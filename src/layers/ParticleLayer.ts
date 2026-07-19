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
  speed: { type: 'number', value: 600 },
  jitter: { type: 'number', value: 0.25 },
  flowBlend: { type: 'number', value: 0 },
  maxAge: { type: 'number', value: 300 },
  fadeFrames: { type: 'number', value: 30 },
  pointSize: { type: 'number', value: 3 },
  sizeVariation: { type: 'number', value: 0.5 },
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
    const { model, buffers, current } = this.state
    if (!model || !buffers) return
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
    this.state.current = 0
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
    this.state.seedBuffer?.destroy()
    this.state.flowTexture?.destroy()
    this.state.transform = undefined
    this.state.model = undefined
    this.state.buffers = undefined
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
    this.setNeedsRedraw()
  }

  private _uniformValues(dt: number): ParticleUniformValues {
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
      color = [120, 169, 255],
      zOffset = 15,
    } = this.props
    return {
      bounds: [minLng, minLat, maxLng - minLng, maxLat - minLat],
      scale: [1 / flowField.spanXMeters, 1 / flowField.spanYMeters, heightScale, zOffset],
      motion: [speed, jitter, flowBlend, dt],
      // Wrapped time (float precision) + respawn-age randomization fraction.
      lifecycle: [maxAge, (performance.now() / 1000) % 3600, 0.95, fadeFrames],
      color: [color[0] / 255, color[1] / 255, color[2] / 255, 1],
      sprite: [pointSize, sizeVariation, 0, 0],
    }
  }
}
