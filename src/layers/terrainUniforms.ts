import type { ShaderModule } from '@luma.gl/shadertools'

/** UBO for the contour terrain shaders. Field order must match the std140 block. */
export type TerrainProps = {
  heightScale: number
  interval: number
  lineWidth: number
  lineColor: [number, number, number, number]
  peakColor: [number, number, number, number]
}

// Colors are vec4 (not vec3): a std140 UBO `vec3` is a notorious source of
// mobile GLSL ES driver bugs (alignment/packing), while vec4 is 16-byte aligned
// and universally safe. The alpha channel is unused (RGB is read in the shader).
const uniformBlock = /* glsl */ `\
layout(std140) uniform terrainUniforms {
  float heightScale;
  float interval;
  float lineWidth;
  vec4 lineColor;
  vec4 peakColor;
} terrain;
`

export const terrainUniforms = {
  name: 'terrain',
  vs: uniformBlock,
  fs: uniformBlock,
  uniformTypes: {
    heightScale: 'f32',
    interval: 'f32',
    lineWidth: 'f32',
    lineColor: 'vec4<f32>',
    peakColor: 'vec4<f32>',
  },
} as const satisfies ShaderModule<TerrainProps>
