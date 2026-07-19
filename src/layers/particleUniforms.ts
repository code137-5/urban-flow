import type { ShaderModule } from '@luma.gl/shadertools'

/**
 * UBO shared by the particle update (transform feedback) and render programs.
 * Field order must match the std140 block.
 */
export type ParticleProps = {
  /** minLng, minLat, spanLng, spanLat — heightmap UV → LNGLAT. */
  bounds: [number, number, number, number]
  /** 1/spanXMeters, 1/spanYMeters, heightScale (m at h=1), zOffset (m). */
  scale: [number, number, number, number]
  /** speed (m/s at |grad|=1), jitter 0–1, flowBlend 0=isoline 1=uphill, dt (s). */
  motion: [number, number, number, number]
  /** maxAge (frames), time (s, wrapped), respawn-age fraction, fade (frames). */
  lifecycle: [number, number, number, number]
  /** Particle color, RGB 0–1 + base alpha. */
  color: [number, number, number, number]
  /** Point size (px), size variation 0–1, glow strength 0–1, unused. */
  sprite: [number, number, number, number]
}

// vec4-only on purpose: scalar floats would be fine per std140, but keeping
// every member 16-byte aligned sidesteps the mobile-driver packing bugs this
// project has already been burned by (see terrainUniforms.ts).
const uniformBlock = /* glsl */ `\
layout(std140) uniform particleUniforms {
  vec4 bounds;
  vec4 scale;
  vec4 motion;
  vec4 lifecycle;
  vec4 color;
  vec4 sprite;
} particle;
`

export const particleUniforms = {
  name: 'particle',
  vs: uniformBlock,
  fs: uniformBlock,
  uniformTypes: {
    bounds: 'vec4<f32>',
    scale: 'vec4<f32>',
    motion: 'vec4<f32>',
    lifecycle: 'vec4<f32>',
    color: 'vec4<f32>',
    sprite: 'vec4<f32>',
  },
} as const satisfies ShaderModule<ParticleProps>
