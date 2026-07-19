import { Layer, project32 } from '@deck.gl/core'
import type { DefaultProps, LayerContext, UpdateParameters } from '@deck.gl/core'
import { BufferTransform, Model } from '@luma.gl/engine'
import type { Buffer, Texture } from '@luma.gl/core'
import type { Heightmap } from '../data/types'
import { computeFlowField } from '../data/flowField'
import type { FlowField } from '../data/flowField'
import { particleUniforms } from './particleUniforms'
import type { ParticleProps as ParticleUniformValues } from './particleUniforms'
import updateVs from './shaders/particle-update.vs.glsl'
import vs from './shaders/particle.vs.glsl'
import fs from './shaders/particle.fs.glsl'

export type ParticleLayerProps = {
  /** Masked, normalized [0,1] scalar field (−1 = masked-out) — same object the terrain renders. */
  heightmap: Heightmap
  /** Resolved particle count (see particleBudget.ts). Change = full buffer rebuild. */
  numParticles?: number
  /** Peak elevation in meters at height 1.0 — MUST match the terrain layer's. */
  heightScale?: number
  /** Advection speed in m/s at |gradient| = 1 (poster-scale, not physical). */
  speed?: number
  /** Per-frame direction jitter, 0–1. */
  jitter?: number
  /** 0 = flow along contour lines (isoline tangent), 1 = straight uphill. */
  flowBlend?: number
  /** Particle lifetime in simulation frames. */
  maxAge?: number
  /** Fade-in/out window at spawn/expiry, in frames. */
  fadeFrames?: number
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
  numParticles: { type: 'number', value: 4000 },
  heightScale: { type: 'number', value: 4000 },
  speed: { type: 'number', value: 1300 },
  jitter: { type: 'number', value: 0 },
  flowBlend: { type: 'number', value: 0 },
  maxAge: { type: 'number', value: 800 },
  fadeFrames: { type: 'number', value: 30 },
  pointSize: { type: 'number', value: 3 },
  sizeVariation: { type: 'number', value: 0.5 },
  glow: { type: 'number', value: 0.6 },
  trail: { type: 'number', value: 0.7 },
  trailLength: { type: 'number', value: 6 },
  trailGap: { type: 'number', value: 4 },
  color: { type: 'color', value: [120, 169, 255] }, // IBM Blue 40, the design system link color
  zOffset: { type: 'number', value: 15 },
  animate: true,
  maxFps: { type: 'number', value: 30 },
}

/** Deterministic RNG — reproducible spawns make Playwright screenshots comparable. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Initial particle state: rejection-sampled in-mask positions, randomized ages. */
function seedParticles(
  heightmap: Heightmap,
  count: number,
  maxAge: number,
): { positions: Float32Array; seeds: Float32Array } {
  const { data, width: W, height: H } = heightmap
  const rand = mulberry32(0x5e0e1) // fixed seed — "Seoul"-ish, arbitrary
  const positions = new Float32Array(count * 4)
  const seeds = new Float32Array(count * 2)
  for (let p = 0; p < count; p++) {
    let i = 0
    let j = 0
    let k = 0
    let tries = 0
    do {
      i = Math.floor(rand() * W)
      j = Math.floor(rand() * H)
      k = j * W + i
    } while (data[k] < 0 && ++tries < 100)
    const masked = data[k] < 0
    positions[p * 4] = (i + rand()) / W
    positions[p * 4 + 1] = (j + rand()) / H
    positions[p * 4 + 2] = masked ? -1 : data[k]
    // Randomized starting age — staggers respawns from the very first frame.
    positions[p * 4 + 3] = rand() * maxAge
    seeds[p * 2] = rand()
    seeds[p * 2 + 1] = rand()
  }
  return { positions, seeds }
}

/**
 * GPU particles advected over the contour terrain.
 *
 * Simulation state (UV position, terrain height, age) lives in two ping-pong
 * vertex BUFFERS updated by a luma.gl BufferTransform (transform feedback) —
 * never in a texture — so the render stage does zero texture fetches, matching
 * the terrain's "bake, don't fetch" mobile constraint. The flow field (heightmap
 * gradient) is the single vertex-stage texture read, confined to the update
 * program and probe-gated (particleSupport.ts). Respawn/lifecycle ideas adapted
 * from code137-5/glsl_particle_animation; buffer transport from the WeatherLayers
 * deck.gl-particle architecture.
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
    flowTexture?: Texture
    flowField?: FlowField
    transform?: BufferTransform
    model?: Model
    current: number
    stepScheduled: boolean
    timerId?: ReturnType<typeof setTimeout>
    lastStepTime: number
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
  }

  updateState(params: UpdateParameters<this>) {
    super.updateState(params)
    const { props, oldProps, changeFlags } = params

    if (changeFlags.extensionsChanged || props.numParticles !== oldProps.numParticles) {
      this._teardown()
      this._setup()
    } else if (props.heightmap !== oldProps.heightmap) {
      // Same particle count: rebuild the field + re-seed state in place.
      this._rebuildField()
    } else if (props.trailLength !== oldProps.trailLength) {
      this._rebuildHistory()
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

  private _setup() {
    const { device } = this.context
    const { heightmap } = this.props
    const numParticles = this.props.numParticles!
    const maxAge = this.props.maxAge!

    const flowField = computeFlowField(heightmap)
    const { positions, seeds } = seedParticles(heightmap, numParticles, maxAge)

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
    const flowTexture = this._createFlowTexture(flowField)

    const transform = new BufferTransform(device, {
      id: `${this.props.id}-update`,
      vs: updateVs,
      modules: [particleUniforms],
      topology: 'point-list',
      vertexCount: numParticles,
      bufferLayout: [
        { name: 'inPosition', format: 'float32x4' },
        { name: 'inSeed', format: 'float32x2' },
      ],
      outputs: ['outPosition'],
    })
    transform.model.setAttributes({ inSeed: seedBuffer })
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
    this.state.flowTexture = flowTexture
    this.state.flowField = flowField
    this.state.transform = transform
    this.state.model = model
    this.state.current = 0
    this.state.lastStepTime = performance.now() / 1000
  }

  private _rebuildField() {
    const { heightmap } = this.props
    const { buffers, transform } = this.state
    if (!buffers || !transform) return
    const flowField = computeFlowField(heightmap)
    this.state.flowTexture?.destroy()
    const flowTexture = this._createFlowTexture(flowField)
    transform.model.setBindings({ flowTexture })
    this.state.flowTexture = flowTexture
    this.state.flowField = flowField
    const { positions } = seedParticles(heightmap, this.props.numParticles!, this.props.maxAge!)
    buffers[0].write(positions)
    buffers[1].write(positions)
    this.state.history?.forEach((b) => b.write(positions))
    this.state.current = 0
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
    this.state.transform?.destroy()
    this.state.model?.destroy()
    this.state.buffers?.forEach((b) => b.destroy())
    this.state.history?.forEach((b) => b.destroy())
    this.state.seedBuffer?.destroy()
    this.state.flowTexture?.destroy()
    this.state.transform = undefined
    this.state.model = undefined
    this.state.buffers = undefined
    this.state.history = undefined
    this.state.seedBuffer = undefined
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

    transform.model.shaderInputs.setProps({ particle: this._uniformValues(dt) })
    transform.run({
      inputBuffers: { inPosition: buffers[current] },
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
    const {
      heightScale = 4000,
      speed = 600,
      jitter = 0.25,
      flowBlend = 0,
      maxAge = 300,
      fadeFrames = 30,
      pointSize = 3,
      sizeVariation = 0.5,
      glow = 0.6,
      color = [120, 169, 255],
      zOffset = 15,
    } = this.props
    return {
      bounds: [minLng, minLat, maxLng - minLng, maxLat - minLat],
      scale: [1 / flowField.spanXMeters, 1 / flowField.spanYMeters, heightScale, zOffset],
      motion: [speed, jitter, flowBlend, dt],
      // Wrapped time (float precision) + respawn-age randomization fraction.
      lifecycle: [maxAge, (performance.now() / 1000) % 3600, 0.95, fadeFrames],
      color: [color[0] / 255, color[1] / 255, color[2] / 255, alphaScale],
      sprite: [pointSize * sizeScale, sizeVariation, glow, 0],
    }
  }
}
