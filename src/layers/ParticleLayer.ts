import { Layer, project32 } from '@deck.gl/core'
import type { DefaultProps, LayerContext, UpdateParameters } from '@deck.gl/core'
import { BufferTransform, Model } from '@luma.gl/engine'
import type { Buffer, Texture } from '@luma.gl/core'
import type { Heightmap } from '../data/types'
import { lngLatToUv, mulberry32 } from '../data/trips'
import type { Trip, TripSource } from '../data/trips'
import { computeFlowField } from '../data/flowField'
import type { FlowField } from '../data/flowField'
import { TripQueue } from './tripQueue'
import { particleUniforms } from './particleUniforms'
import type { ParticleProps as ParticleUniformValues } from './particleUniforms'
import updateVs from './shaders/particle-update.vs.glsl'
import vs from './shaders/particle.vs.glsl'
import fs from './shaders/particle.fs.glsl'

export type ParticleLayerProps = {
  /** Masked, normalized [0,1] scalar field (−1 = masked-out) — same object the terrain renders. */
  heightmap: Heightmap
  /** Where trips come from (random now, API later). Change = full rebuild. */
  tripSource: TripSource
  /** Resolved particle slot count (see particleBudget.ts). Change = full buffer rebuild. */
  numParticles?: number
  /** Peak elevation in meters at height 1.0 — MUST match the terrain layer's. */
  heightScale?: number
  /** Playback multiplier on trip durations: 2 = every trip plays twice as fast. */
  timeScale?: number
  /** Fade-in/out window at each end of a trip, as a fraction of the trip (0–0.5). */
  fadeFraction?: number
  /** Sprite size in pixels. */
  pointSize?: number
  /** Per-particle size variation, 0–1. */
  sizeVariation?: number
  /** Halo strength 0–1 — overlapping halos bloom under additive blending. */
  glow?: number
  /** Trail (ghost afterimage) strength 0–1; 0 disables the history draws. */
  trail?: number
  /** Number of ghost snapshots in the trail (1–12). Change = history realloc. */
  trailLength?: number
  /** Simulation steps between snapshots — spacing of the ghosts. */
  trailGap?: number
  /** Sprite color (RGB 0–255). */
  color?: [number, number, number]
  /** Meters above the terrain surface (avoids z-fighting the contour lines). */
  zOffset?: number
  /** Drive the simulation loop. false = freeze on the current frame. */
  animate?: boolean
  /** Simulation step rate cap. */
  maxFps?: number
}

const defaultProps: DefaultProps<ParticleLayerProps> = {
  numParticles: { type: 'number', value: 1000 },
  heightScale: { type: 'number', value: 4000 },
  timeScale: { type: 'number', value: 1 },
  fadeFraction: { type: 'number', value: 0.1 },
  pointSize: { type: 'number', value: 3 },
  sizeVariation: { type: 'number', value: 0.5 },
  glow: { type: 'number', value: 0.6 },
  trail: { type: 'number', value: 0.7 },
  trailLength: { type: 'number', value: 8 },
  trailGap: { type: 'number', value: 6 },
  color: { type: 'color', value: [244, 244, 244] }, // near-white — legible on the cyan→red contour ramp
  zOffset: { type: 'number', value: 15 },
  animate: true,
  maxFps: { type: 'number', value: 30 },
}

// Static per-slot attribute layout (floats per particle).
const TRIP_STRIDE = 4 // originU, originV, destU, destV
const TIMING_STRIDE = 2 // durationSec, startAt (sim s)
// Past this many reassignments in one step (e.g. resuming after a long pause),
// one whole-buffer upload beats per-slot writes.
const BULK_WRITE_THRESHOLD = 64

/**
 * GPU particles playing trips (origin → destination in `durationSec`) over the
 * contour terrain.
 *
 * Each particle is a *slot* holding one Trip. Position is a pure function of
 * simulation time (`mix(origin, dest, (t - startAt) / duration)`), evaluated by
 * a luma.gl BufferTransform (transform feedback) into a ping-pong vertex BUFFER
 * — never a texture — so the render stage does zero texture fetches (the same
 * "bake, don't fetch" mobile constraint the terrain honors). The one
 * vertex-stage texture read (terrain height + Seoul mask) is confined to the
 * update program and probe-gated (particleSupport.ts).
 *
 * Because motion is time-deterministic, the CPU knows exactly when each slot's
 * trip ends without reading the GPU back: `_step` scans `endAt`, pulls the next
 * Trip from a prefetching TripQueue, and rewrites just that slot's 24 bytes.
 *
 * The layer is self-driving: draw() schedules the next simulation step on a
 * setTimeout throttle, the step runs the transform and calls setNeedsRedraw().
 * No React state is touched per frame; the host only flips the `animate` prop.
 */
export default class ParticleLayer extends Layer<ParticleLayerProps> {
  static layerName = 'ParticleLayer'
  static defaultProps = defaultProps

  declare state: {
    buffers?: [Buffer, Buffer]
    /** Snapshot ring for trails — copies of past particle state (~2 steps apart). */
    history?: Buffer[]
    historyHead: number
    stepCount: number
    seedBuffer?: Buffer
    /** Static per-slot trip endpoints (UV) and timing; CPU mirrors below. */
    tripBuffer?: Buffer
    timingBuffer?: Buffer
    tripData?: Float32Array
    timingData?: Float32Array
    /** Simulation time at which each slot's trip completes. */
    endAt?: Float64Array
    queue?: TripQueue
    /** Guards the async prime() against a teardown racing it. */
    setupToken: number
    flowTexture?: Texture
    flowField?: FlowField
    transform?: BufferTransform
    model?: Model
    current: number
    stepScheduled: boolean
    timerId?: ReturnType<typeof setTimeout>
    lastStepTime: number
    /** Accumulated simulation seconds — frozen while `animate` is false. */
    simTime: number
  }

  getShaders() {
    return super.getShaders({ vs, fs, modules: [project32, particleUniforms] })
  }

  initializeState() {
    this.state.current = 0
    this.state.stepScheduled = false
    this.state.lastStepTime = 0
    this.state.historyHead = 0
    this.state.stepCount = 0
    this.state.setupToken = 0
    this.state.simTime = 0
  }

  updateState(params: UpdateParameters<this>) {
    super.updateState(params)
    const { props, oldProps, changeFlags } = params

    if (
      changeFlags.extensionsChanged ||
      props.numParticles !== oldProps.numParticles ||
      props.tripSource !== oldProps.tripSource
    ) {
      this._teardown()
      void this._setup()
    } else {
      // Trips are lng/lat-based and the bounds are fixed, so a new heightmap
      // only means a new height/mask texture — no reseeding.
      if (props.heightmap !== oldProps.heightmap) this._rebuildField()
      if (props.trailLength !== oldProps.trailLength) this._rebuildHistory()
      if (props.timeScale !== oldProps.timeScale) this._recomputeEndTimes()
    }

    if (props.animate && this.state.transform) {
      this._scheduleStep()
    } else if (!props.animate && this.state.timerId !== undefined) {
      clearTimeout(this.state.timerId)
      this.state.timerId = undefined
      this.state.stepScheduled = false
    }
  }

  draw() {
    const { model, buffers, current, history, historyHead } = this.state
    if (!model || !buffers) return
    const trail = this.props.trail ?? 0.5

    // Trails: draw past snapshots first (oldest → newest), dimmer and smaller,
    // so the live particles render on top of their own afterimages.
    if (trail > 0 && history) {
      const n = history.length
      for (let i = 0; i < n; i++) {
        const slot = history[(historyHead + i) % n]
        // t runs (1/n .. 1]: newest ghost is brightest and largest.
        const t = (i + 1) / n
        model.setAttributes({ positions: slot })
        model.shaderInputs.setProps({
          particle: this._uniformValues(0, trail * (0.15 + 0.45 * t), 0.45 + 0.4 * t),
        })
        model.draw(this.context.renderPass)
      }
    }

    // Re-bind every frame: never draw the buffer registered as the TF output.
    model.setAttributes({ positions: buffers[current] })
    model.shaderInputs.setProps({ particle: this._uniformValues(0) })
    model.draw(this.context.renderPass)
    if (this.props.animate) this._scheduleStep()
  }

  finalizeState(context: LayerContext) {
    if (this.state.timerId !== undefined) clearTimeout(this.state.timerId)
    this.state.timerId = undefined
    this.state.stepScheduled = false
    this._teardown()
    super.finalizeState(context)
  }

  /**
   * Fill every slot from the source, then build the GPU resources. Async only
   * for the initial prime; nothing is drawn until it resolves (like the panel's
   * pre-heightmap state). A teardown during the await abandons the setup.
   */
  private async _setup() {
    const { heightmap, tripSource } = this.props
    const numParticles = this.props.numParticles!
    const token = ++this.state.setupToken

    const queue = new TripQueue(tripSource)
    this.state.queue = queue
    await queue.prime(numParticles)
    if (token !== this.state.setupToken || this.state.queue !== queue) return

    const { device } = this.context
    const rand = mulberry32(0x5e0e1) // fixed seed — reproducible screenshots
    const toUv = lngLatToUv(heightmap.bounds)
    const tripData = new Float32Array(numParticles * TRIP_STRIDE)
    const timingData = new Float32Array(numParticles * TIMING_STRIDE)
    const endAt = new Float64Array(numParticles)
    const seeds = new Float32Array(numParticles * 2)
    const positions = new Float32Array(numParticles * 4)
    const timeScale = this.props.timeScale!
    const simTime = this.state.simTime

    let last: Trip | null = null
    for (let p = 0; p < numParticles; p++) {
      const trip: Trip | null = queue.take() ?? last
      if (!trip) break // source returned nothing at all — slots stay parked/hidden
      last = trip
      // Random head start so the first frame isn't every particle departing at once.
      const startAt = simTime - rand() * trip.durationSec
      this._writeSlot(tripData, timingData, endAt, toUv, p, trip, startAt, timeScale)
      seeds[p * 2] = rand()
      seeds[p * 2 + 1] = rand()
      positions[p * 4 + 2] = -1 // hidden until the first transform step lands it
    }

    const flowField = computeFlowField(heightmap)
    const buffers: [Buffer, Buffer] = [
      device.createBuffer({ data: positions }),
      device.createBuffer({ data: positions.slice() }),
    ]
    // Trail snapshots start coincident with the live particles (no artifacts on
    // the first frames); they diverge as the ring rotates.
    const trailLength = Math.max(1, Math.round(this.props.trailLength ?? 3))
    const history = Array.from({ length: trailLength }, () =>
      device.createBuffer({ data: positions.slice() }),
    )
    const seedBuffer = device.createBuffer({ data: seeds })
    const tripBuffer = device.createBuffer({ data: tripData })
    const timingBuffer = device.createBuffer({ data: timingData })
    const flowTexture = this._createFlowTexture(flowField)

    const transform = new BufferTransform(device, {
      id: `${this.props.id}-update`,
      vs: updateVs,
      modules: [particleUniforms],
      topology: 'point-list',
      vertexCount: numParticles,
      bufferLayout: [
        { name: 'inTrip', format: 'float32x4' },
        { name: 'inTiming', format: 'float32x2' },
      ],
      outputs: ['outPosition'],
    })
    transform.model.setAttributes({ inTrip: tripBuffer, inTiming: timingBuffer })
    transform.model.setBindings({ flowTexture })

    const model = new Model(device, {
      ...this.getShaders(),
      id: this.props.id,
      topology: 'point-list',
      vertexCount: numParticles,
      bufferLayout: [
        { name: 'positions', format: 'float32x4' },
        { name: 'seeds', format: 'float32x2' },
      ],
      isInstanced: false,
      parameters: {
        // Additive blending (premultiplied): order-independent light over #161616.
        blendColorOperation: 'add',
        blendColorSrcFactor: 'one',
        blendColorDstFactor: 'one',
        blendAlphaOperation: 'add',
        blendAlphaSrcFactor: 'one',
        blendAlphaDstFactor: 'one',
        // Occluded by foreground ridges, but never occludes anything itself.
        depthWriteEnabled: false,
        depthCompare: 'less-equal',
      },
    })
    model.setAttributes({ seeds: seedBuffer })

    this.state.buffers = buffers
    this.state.history = history
    this.state.historyHead = 0
    this.state.stepCount = 0
    this.state.seedBuffer = seedBuffer
    this.state.tripBuffer = tripBuffer
    this.state.timingBuffer = timingBuffer
    this.state.tripData = tripData
    this.state.timingData = timingData
    this.state.endAt = endAt
    this.state.flowTexture = flowTexture
    this.state.flowField = flowField
    this.state.transform = transform
    this.state.model = model
    this.state.current = 0
    this.state.lastStepTime = performance.now() / 1000

    if (this.props.animate) this._scheduleStep()
    this.setNeedsRedraw()
  }

  /** Pack one trip into slot `p` of the CPU mirrors and record when it ends. */
  private _writeSlot(
    tripData: Float32Array,
    timingData: Float32Array,
    endAt: Float64Array,
    toUv: (lng: number, lat: number) => [number, number],
    p: number,
    trip: Trip,
    startAt: number,
    timeScale: number,
  ) {
    const [ou, ov] = toUv(trip.origin[0], trip.origin[1])
    const [du, dv] = toUv(trip.destination[0], trip.destination[1])
    const duration = Math.max(trip.durationSec, 1e-3)
    tripData[p * TRIP_STRIDE] = ou
    tripData[p * TRIP_STRIDE + 1] = ov
    tripData[p * TRIP_STRIDE + 2] = du
    tripData[p * TRIP_STRIDE + 3] = dv
    timingData[p * TIMING_STRIDE] = duration
    timingData[p * TIMING_STRIDE + 1] = startAt
    endAt[p] = startAt + duration / timeScale
  }

  /**
   * Hand finished slots their next trip. Runs every step; churn is well under
   * one slot per step at normal rates, so per-slot sub-range writes are the
   * cheap path. Without a trip ready, the slot replays its current one.
   */
  private _reassignFinished(simTime: number) {
    const { endAt, tripData, timingData, tripBuffer, timingBuffer, queue } = this.state
    if (!endAt || !tripData || !timingData || !tripBuffer || !timingBuffer || !queue) return
    const toUv = lngLatToUv(this.props.heightmap.bounds)
    const timeScale = this.props.timeScale!

    const done: number[] = []
    for (let p = 0; p < endAt.length; p++) if (endAt[p] <= simTime) done.push(p)
    if (done.length === 0) return

    for (const p of done) {
      const trip = queue.take()
      if (trip) {
        this._writeSlot(tripData, timingData, endAt, toUv, p, trip, simTime, timeScale)
      } else {
        timingData[p * TIMING_STRIDE + 1] = simTime
        endAt[p] = simTime + timingData[p * TIMING_STRIDE] / timeScale
      }
    }

    if (done.length > BULK_WRITE_THRESHOLD) {
      tripBuffer.write(tripData)
      timingBuffer.write(timingData)
      return
    }
    for (const p of done) {
      tripBuffer.write(
        tripData.subarray(p * TRIP_STRIDE, (p + 1) * TRIP_STRIDE),
        p * TRIP_STRIDE * 4,
      )
      timingBuffer.write(
        timingData.subarray(p * TIMING_STRIDE, (p + 1) * TIMING_STRIDE),
        p * TIMING_STRIDE * 4,
      )
    }
  }

  /** timeScale changed: every in-flight trip now ends at a different sim time. */
  private _recomputeEndTimes() {
    const { endAt, timingData } = this.state
    if (!endAt || !timingData) return
    const timeScale = this.props.timeScale!
    for (let p = 0; p < endAt.length; p++) {
      const duration = timingData[p * TIMING_STRIDE]
      const startAt = timingData[p * TIMING_STRIDE + 1]
      endAt[p] = startAt + duration / timeScale
    }
  }

  private _rebuildField() {
    const { transform } = this.state
    if (!transform) return
    const flowField = computeFlowField(this.props.heightmap)
    this.state.flowTexture?.destroy()
    const flowTexture = this._createFlowTexture(flowField)
    transform.model.setBindings({ flowTexture })
    this.state.flowTexture = flowTexture
    this.state.flowField = flowField
  }

  /**
   * Recreate the trail ring at the current `trailLength`, seeding every slot
   * from the LIVE particle buffer (GPU-side copy) so ghosts never jump.
   */
  private _rebuildHistory() {
    const { buffers, current } = this.state
    if (!buffers) return
    const { device } = this.context
    const trailLength = Math.max(1, Math.round(this.props.trailLength ?? 3))
    this.state.history?.forEach((b) => b.destroy())
    const src = buffers[current]
    const history: Buffer[] = []
    for (let i = 0; i < trailLength; i++) {
      const buf = device.createBuffer({ byteLength: src.byteLength })
      const encoder = device.createCommandEncoder()
      encoder.copyBufferToBuffer({
        sourceBuffer: src,
        destinationBuffer: buf,
        size: src.byteLength,
      })
      encoder.finish()
      encoder.destroy()
      history.push(buf)
    }
    this.state.history = history
    this.state.historyHead = 0
  }

  private _createFlowTexture(flowField: FlowField): Texture {
    return this.context.device.createTexture({
      data: flowField.data,
      width: flowField.width,
      height: flowField.height,
      format: 'rgba8unorm',
      sampler: {
        minFilter: 'linear',
        magFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      },
    })
  }

  private _teardown() {
    this.state.setupToken += 1 // abandon any in-flight _setup()
    this.state.queue?.dispose()
    this.state.transform?.destroy()
    this.state.model?.destroy()
    this.state.buffers?.forEach((b) => b.destroy())
    this.state.history?.forEach((b) => b.destroy())
    this.state.seedBuffer?.destroy()
    this.state.tripBuffer?.destroy()
    this.state.timingBuffer?.destroy()
    this.state.flowTexture?.destroy()
    this.state.queue = undefined
    this.state.transform = undefined
    this.state.model = undefined
    this.state.buffers = undefined
    this.state.history = undefined
    this.state.seedBuffer = undefined
    this.state.tripBuffer = undefined
    this.state.timingBuffer = undefined
    this.state.tripData = undefined
    this.state.timingData = undefined
    this.state.endAt = undefined
    this.state.flowTexture = undefined
  }

  private _scheduleStep() {
    if (this.state.stepScheduled) return
    this.state.stepScheduled = true
    this.state.timerId = setTimeout(() => {
      this.state.stepScheduled = false
      this.state.timerId = undefined
      this._step()
    }, 1000 / this.props.maxFps!)
  }

  private _step() {
    const { transform, buffers, current } = this.state
    if (!transform || !buffers) return // finalized while the timer was pending

    const now = performance.now() / 1000
    const dt = Math.min(Math.max(now - this.state.lastStepTime, 0), 0.05)
    this.state.lastStepTime = now
    this.state.simTime += dt

    // Finished slots get their next trip BEFORE the transform runs, so the new
    // trip's first frame is evaluated this step (progress 0, faded in from there).
    this._reassignFinished(this.state.simTime)

    transform.model.shaderInputs.setProps({ particle: this._uniformValues(dt) })
    transform.run({
      outputBuffers: { outPosition: buffers[1 - current] },
      // transform.run() opens a render pass that CLEARS the bound framebuffer
      // by default — discard rasterization and disable every clear, or the
      // terrain flashes black on each simulation step.
      discard: true,
      clearColor: false,
      clearDepth: false,
      clearStencil: false,
    })
    this.state.current = 1 - current

    // Rotate a state snapshot into the trail ring every `trailGap` steps so the
    // ghost afterimages sit a visible distance behind the live particles.
    this.state.stepCount += 1
    const { history } = this.state
    const trailGap = Math.max(1, Math.round(this.props.trailGap ?? 2))
    if (history && (this.props.trail ?? 0.5) > 0 && this.state.stepCount % trailGap === 0) {
      const target = history[this.state.historyHead]
      const encoder = this.context.device.createCommandEncoder()
      encoder.copyBufferToBuffer({
        sourceBuffer: this.state.buffers![this.state.current],
        destinationBuffer: target,
        size: target.byteLength,
      })
      encoder.finish()
      encoder.destroy()
      this.state.historyHead = (this.state.historyHead + 1) % history.length
    }

    this.setNeedsRedraw()
  }

  private _uniformValues(dt: number, alphaScale = 1, sizeScale = 1): ParticleUniformValues {
    const { heightmap } = this.props
    const flowField = this.state.flowField!
    const [minLng, minLat, maxLng, maxLat] = heightmap.bounds
    const heightScale = this.props.heightScale!
    const timeScale = this.props.timeScale!
    const fadeFraction = this.props.fadeFraction!
    const pointSize = this.props.pointSize!
    const sizeVariation = this.props.sizeVariation!
    const glow = this.props.glow!
    const color = this.props.color!
    const zOffset = this.props.zOffset!
    return {
      bounds: [minLng, minLat, maxLng - minLng, maxLat - minLat],
      scale: [1 / flowField.spanXMeters, 1 / flowField.spanYMeters, heightScale, zOffset],
      motion: [timeScale, 0, 0, dt],
      // Progress runs 0..1; the fade window is a fraction of the trip.
      lifecycle: [1, this.state.simTime, 0, fadeFraction],
      color: [color[0] / 255, color[1] / 255, color[2] / 255, alphaScale],
      sprite: [pointSize * sizeScale, sizeVariation, glow, 0],
    }
  }
}
