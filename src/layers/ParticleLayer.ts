import { Layer, project32 } from '@deck.gl/core'
import type { DefaultProps, LayerContext, LayerProps, UpdateParameters } from '@deck.gl/core'
import { BufferTransform, Model } from '@luma.gl/engine'
import type { Buffer, Texture } from '@luma.gl/core'
import type { Heightmap } from '../data/types'
import { lngLatToUv } from '../data/trips'
import { computeFlowField } from '../data/flowField'
import type { FlowField } from '../data/flowField'
import type { TripSchedule } from './tripSchedule'
import { particleUniforms } from './particleUniforms'
import type { ParticleProps as ParticleUniformValues } from './particleUniforms'
import updateVs from './shaders/particle-update.vs.glsl'
import vs from './shaders/particle.vs.glsl'
import fs from './shaders/particle.fs.glsl'

export type ParticleLayerProps = {
  /** Masked, normalized [0,1] scalar field (−1 = masked-out) — same object the terrain renders. */
  heightmap: Heightmap
  /**
   * Which trip each slot plays, on a clock shared by every layer given the same
   * schedule — so their particles move in lockstep. Change = full rebuild.
   */
  schedule: TripSchedule
  /** Resolved particle slot count (see particleBudget.ts). Change = full buffer rebuild. */
  numParticles?: number
  /** Peak elevation in meters at height 1.0 — MUST match the terrain layer's. */
  heightScale?: number
  /** Fade-in/out window at each end of a trip, as a fraction of the trip (0–0.5). */
  fadeFraction?: number
  /** 0–1: how much alpha climbs with trip progress (faint at the origin, full at the destination). */
  arrivalRamp?: number
  /** Sprite size in pixels. */
  pointSize?: number
  /** Halo strength 0–1 — overlapping halos bloom under additive blending. */
  glow?: number
  /** Sprite diameter as a multiple of the core dot — how far the halo reaches. */
  haloScale?: number
  /** Trail (ghost afterimage) strength 0–1; 0 disables the history draws. */
  trail?: number
  /** Number of ghost snapshots in the trail — one extra draw call each. Change = history realloc. */
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

const defaultProps: DefaultProps<ParticleLayerProps & Pick<LayerProps, 'parameters'>> = {
  numParticles: { type: 'number', value: 1000 },
  heightScale: { type: 'number', value: 4000 },
  fadeFraction: { type: 'number', value: 0.1 },
  arrivalRamp: { type: 'number', value: 0 },
  pointSize: { type: 'number', value: 3 },
  glow: { type: 'number', value: 0.6 },
  haloScale: { type: 'number', value: 2 },
  trail: { type: 'number', value: 0.7 },
  trailLength: { type: 'number', value: 8 },
  trailGap: { type: 'number', value: 6 },
  color: { type: 'color', value: [244, 244, 244] }, // near-white — legible on the cyan→red contour ramp
  zOffset: { type: 'number', value: 15 },
  animate: true,
  maxFps: { type: 'number', value: 30 },
  // GPU state goes through the LAYER's `parameters`, not the Model's: deck.gl
  // calls model.setParameters(layer parameters) on every draw, wiping whatever the
  // Model was created with. Left to deck's defaults the sprites alpha-blend and
  // WRITE DEPTH, so a trail's near-transparent quad hides any particle passing
  // behind it (particles blink as they cross trails).
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
}

// Static per-slot attribute layout (floats per particle).
const TRIP_STRIDE = 4 // originU, originV, destU, destV
const TIMING_STRIDE = 2 // playback seconds, startAt (schedule clock s)
// Past this many changed slots in one step (e.g. resuming after a long pause),
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
 * trip ends without reading the GPU back. That bookkeeping lives in a shared
 * TripSchedule (tripSchedule.ts); `_step` ticks it and rewrites just the 24
 * bytes of each slot whose trip changed.
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
    /** Static per-slot trip endpoints (UV) and timing; CPU mirrors below. */
    tripBuffer?: Buffer
    timingBuffer?: Buffer
    tripData?: Float32Array
    timingData?: Float32Array
    /** Schedule version each slot was last written from. */
    seen?: Uint32Array
    /** Guards the async ensure() against a teardown racing it. */
    setupToken: number
    flowTexture?: Texture
    flowField?: FlowField
    transform?: BufferTransform
    model?: Model
    current: number
    stepScheduled: boolean
    timerId?: ReturnType<typeof setTimeout>
    lastStepTime: number
    /** Schedule clock at the last step — frozen while `animate` is false. */
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
      props.schedule !== oldProps.schedule
    ) {
      this._teardown()
      void this._setup()
    } else {
      // Trips are lng/lat-based and the bounds are fixed, so a new heightmap
      // only means a new height/mask texture — no reseeding.
      if (props.heightmap !== oldProps.heightmap) this._rebuildField()
      if (props.trailLength !== oldProps.trailLength) this._rebuildHistory()
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
   * Wait for the schedule to cover our slots, then build the GPU resources.
   * Async only for that wait; nothing is drawn until it resolves (like the
   * panel's pre-heightmap state). A teardown during the await abandons the setup.
   */
  private async _setup() {
    const { heightmap, schedule } = this.props
    const numParticles = this.props.numParticles!
    const token = ++this.state.setupToken

    await schedule.ensure(numParticles)
    if (token !== this.state.setupToken) return

    const { device } = this.context
    const tripData = new Float32Array(numParticles * TRIP_STRIDE)
    const timingData = new Float32Array(numParticles * TIMING_STRIDE)
    const seen = new Uint32Array(numParticles) // 0 = never written; _syncSlots fills them
    const positions = new Float32Array(numParticles * 4)

    for (let p = 0; p < numParticles; p++) {
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
      bufferLayout: [{ name: 'positions', format: 'float32x4' }],
      isInstanced: false,
    })

    this.state.buffers = buffers
    this.state.history = history
    this.state.historyHead = 0
    this.state.stepCount = 0
    this.state.tripBuffer = tripBuffer
    this.state.timingBuffer = timingBuffer
    this.state.tripData = tripData
    this.state.timingData = timingData
    this.state.seen = seen
    this.state.flowTexture = flowTexture
    this.state.flowField = flowField
    this.state.transform = transform
    this.state.model = model
    this.state.current = 0
    this.state.lastStepTime = performance.now() / 1000
    this._syncSlots()

    if (this.props.animate) this._scheduleStep()
    this.setNeedsRedraw()
  }

  /**
   * Mirror the schedule into the GPU: rewrite every slot whose trip changed since
   * we last looked. Churn is well under one slot per step at normal rates, so
   * per-slot sub-range writes are the cheap path.
   */
  private _syncSlots() {
    const { seen, tripData, timingData, tripBuffer, timingBuffer } = this.state
    if (!seen || !tripData || !timingData || !tripBuffer || !timingBuffer) return
    const { schedule, heightmap } = this.props
    const toUv = lngLatToUv(heightmap.bounds)

    const changed: number[] = []
    for (let p = 0; p < seen.length; p++) {
      const version = schedule.versions[p] ?? 0 // 0 = the source gave nothing; stays hidden
      if (version === seen[p]) continue
      seen[p] = version
      const trip = schedule.trips[p]
      const [ou, ov] = toUv(trip.origin[0], trip.origin[1])
      const [du, dv] = toUv(trip.destination[0], trip.destination[1])
      tripData[p * TRIP_STRIDE] = ou
      tripData[p * TRIP_STRIDE + 1] = ov
      tripData[p * TRIP_STRIDE + 2] = du
      tripData[p * TRIP_STRIDE + 3] = dv
      timingData[p * TIMING_STRIDE] = schedule.durations[p]
      timingData[p * TIMING_STRIDE + 1] = schedule.startAt[p]
      changed.push(p)
    }
    if (changed.length === 0) return

    if (changed.length > BULK_WRITE_THRESHOLD) {
      tripBuffer.write(tripData)
      timingBuffer.write(timingData)
      return
    }
    for (const p of changed) {
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
      // finish() only returns the recorded commands — they run on submit.
      device.submit(encoder.finish())
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
    this.state.transform?.destroy()
    this.state.model?.destroy()
    this.state.buffers?.forEach((b) => b.destroy())
    this.state.history?.forEach((b) => b.destroy())
    this.state.tripBuffer?.destroy()
    this.state.timingBuffer?.destroy()
    this.state.flowTexture?.destroy()
    this.state.transform = undefined
    this.state.model = undefined
    this.state.buffers = undefined
    this.state.history = undefined
    this.state.tripBuffer = undefined
    this.state.timingBuffer = undefined
    this.state.tripData = undefined
    this.state.timingData = undefined
    this.state.seen = undefined
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

    // Finished slots get their next trip BEFORE the transform runs, so the new
    // trip's first frame is evaluated this step (progress 0, faded in from there).
    this.state.simTime = this.props.schedule.tick()
    this._syncSlots()

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
      // finish() only returns the recorded commands — they run on submit.
      this.context.device.submit(encoder.finish())
      this.state.historyHead = (this.state.historyHead + 1) % history.length
    }

    this.setNeedsRedraw()
  }

  private _uniformValues(dt: number, alphaScale = 1, sizeScale = 1): ParticleUniformValues {
    const { heightmap } = this.props
    const flowField = this.state.flowField!
    const [minLng, minLat, maxLng, maxLat] = heightmap.bounds
    const heightScale = this.props.heightScale!
    const fadeFraction = this.props.fadeFraction!
    const arrivalRamp = this.props.arrivalRamp!
    const pointSize = this.props.pointSize!
    const glow = this.props.glow!
    const haloScale = Math.max(1, this.props.haloScale!)
    const color = this.props.color!
    const zOffset = this.props.zOffset!
    return {
      bounds: [minLng, minLat, maxLng - minLng, maxLat - minLat],
      scale: [1 / flowField.spanXMeters, 1 / flowField.spanYMeters, heightScale, zOffset],
      // x = timeScale: 1, because the schedule's durations are already playback seconds.
      motion: [1, 0, 0, dt],
      // Progress runs 0..1; the fade window is a fraction of the trip.
      lifecycle: [1, this.state.simTime, arrivalRamp, fadeFraction],
      color: [color[0] / 255, color[1] / 255, color[2] / 255, alphaScale],
      sprite: [pointSize * sizeScale, 0, glow, haloScale],
    }
  }
}
