import { Layer, project32 } from '@deck.gl/core'
import type {
  DefaultProps,
  LayerContext,
  UpdateParameters,
} from '@deck.gl/core'
import { Model } from '@luma.gl/engine'
import type { Heightmap } from '../data/types'
import { terrainUniforms } from './terrainUniforms'
import vs from './shaders/terrain.vs.glsl'
import fs from './shaders/terrain.fs.glsl'

export type ContourTerrainLayerProps = {
  /** Masked, normalized [0,1] scalar field (−1 = masked-out). */
  heightmap: Heightmap
  /** Peak elevation in meters at height 1.0. */
  heightScale?: number
  /** Contour spacing in normalized height units. */
  interval?: number
  /** Line half-width, in fractions of a contour interval (0–0.5). */
  lineWidth?: number
  /** Line color at height 0 (RGB 0–255). */
  lineColor?: [number, number, number]
  /** Line color at height 1 (RGB 0–255). */
  peakColor?: [number, number, number]
}

const defaultProps: DefaultProps<ContourTerrainLayerProps> = {
  heightScale: { type: 'number', value: 4000 },
  interval: { type: 'number', value: 0.06 },
  lineWidth: { type: 'number', value: 0.04 },
  lineColor: { type: 'color', value: [251, 191, 36] },
  peakColor: { type: 'color', value: [125, 211, 252] },
}

type GridMesh = {
  positions: Float64Array
  /** Per-vertex heightmap value (−1 = masked), baked as an attribute. */
  heights: Float32Array
  indices: Uint32Array
  vertexCount: number
}

/**
 * Build a cell-centered grid mesh (LNGLAT) matching the heightmap layout, with
 * the height baked into a per-vertex attribute (NOT a texture — see class doc).
 */
function buildGridMesh(heightmap: Heightmap): GridMesh {
  const { width: W, height: H, bounds, data } = heightmap
  const [minLng, minLat, maxLng, maxLat] = bounds
  const spanLng = maxLng - minLng
  const spanLat = maxLat - minLat

  const positions = new Float64Array(W * H * 3)
  const heights = new Float32Array(W * H)
  for (let j = 0; j < H; j++) {
    const lat = minLat + ((j + 0.5) / H) * spanLat
    for (let i = 0; i < W; i++) {
      const k = j * W + i
      positions[k * 3] = minLng + ((i + 0.5) / W) * spanLng
      positions[k * 3 + 1] = lat
      positions[k * 3 + 2] = 0
      heights[k] = data[k]
    }
  }

  const indices = new Uint32Array((W - 1) * (H - 1) * 6)
  let t = 0
  for (let j = 0; j < H - 1; j++) {
    for (let i = 0; i < W - 1; i++) {
      const a = j * W + i
      const b = a + 1
      const c = a + W
      const d = c + 1
      indices[t++] = a
      indices[t++] = b
      indices[t++] = c
      indices[t++] = b
      indices[t++] = d
      indices[t++] = c
    }
  }
  return { positions, heights, indices, vertexCount: indices.length }
}

/**
 * Renders a heightmap as a 3D contour surface: the grid mesh is displaced in the
 * vertex shader by height, and the fragment shader draws only contour lines
 * (fract, in height-interval units — no screen-space derivatives). Masked cells
 * (−1) are discarded.
 *
 * Height is supplied as a per-vertex ATTRIBUTE, not a sampled texture: vertex
 * texture fetch of a float (r32float) texture is unsupported on many mobile
 * GPUs and made the terrain shader fail to compile there while the (texture-less)
 * base map layers rendered fine. Baking the height into the mesh removes VTF,
 * the float texture, and the sampler entirely. Technique adapted from
 * Aete/seoul-terrain-animation.
 */
export default class ContourTerrainLayer extends Layer<ContourTerrainLayerProps> {
  static layerName = 'ContourTerrainLayer'
  static defaultProps = defaultProps

  declare state: {
    model?: Model
    mesh?: GridMesh
  }

  getShaders() {
    return super.getShaders({ vs, fs, modules: [project32, terrainUniforms] })
  }

  initializeState() {
    const attributeManager = this.getAttributeManager()!
    attributeManager.add({
      indices: {
        size: 1,
        isIndexed: true,
        update: (attr) => (attr.value = this.state.mesh!.indices),
        noAlloc: true,
      },
      positions: {
        size: 3,
        type: 'float64',
        fp64: this.use64bitPositions(),
        update: (attr) => (attr.value = this.state.mesh!.positions),
        noAlloc: true,
      },
      heightVal: {
        size: 1,
        update: (attr) => (attr.value = this.state.mesh!.heights),
        noAlloc: true,
      },
    })
  }

  updateState(params: UpdateParameters<this>) {
    super.updateState(params)
    const { props, oldProps, changeFlags } = params
    const attributeManager = this.getAttributeManager()!

    if (changeFlags.extensionsChanged) {
      this.state.model?.destroy()
      this.state.model = this._getModel()
      attributeManager.invalidateAll()
    }

    if (props.heightmap !== oldProps.heightmap) {
      const mesh = buildGridMesh(props.heightmap)
      this.state.mesh = mesh
      this.state.model?.setVertexCount(mesh.vertexCount)
      attributeManager.invalidateAll()
    }
  }

  draw() {
    const { model } = this.state
    if (!model) return
    const {
      heightScale = 4000,
      interval = 0.06,
      lineWidth = 0.04,
      lineColor = [251, 191, 36],
      peakColor = [125, 211, 252],
    } = this.props
    model.shaderInputs.setProps({
      terrain: {
        heightScale,
        interval,
        lineWidth,
        // Pad RGB (0–255) → vec4 in 0–1; alpha unused (RGB is read in the shader).
        lineColor: [...lineColor.map((x) => x / 255), 1] as [number, number, number, number],
        peakColor: [...peakColor.map((x) => x / 255), 1] as [number, number, number, number],
      },
    })
    model.draw(this.context.renderPass)
  }

  finalizeState(context: LayerContext) {
    super.finalizeState(context)
    this.state.model?.destroy()
  }

  _getModel(): Model {
    return new Model(this.context.device, {
      ...this.getShaders(),
      id: this.props.id,
      bufferLayout: this.getAttributeManager()!.getBufferLayouts(),
      topology: 'triangle-list',
      isInstanced: false,
    })
  }
}
