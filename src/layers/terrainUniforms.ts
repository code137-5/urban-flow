import type { ShaderModule } from '@luma.gl/shadertools'

/** UBO for the contour terrain shaders. Field order must match the std140 block. */
export type TerrainProps = {
  heightScale: number
  interval: number
  lineWidth: number
  lineColor: [number, number, number]
  peakColor: [number, number, number]
}

const uniformBlock = /* glsl */ `\
layout(std140) uniform terrainUniforms {
  float heightScale;
  float interval;
  float lineWidth;
  vec3 lineColor;
  vec3 peakColor;
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
    lineColor: 'vec3<f32>',
    peakColor: 'vec3<f32>',
  },
} as const satisfies ShaderModule<TerrainProps>
