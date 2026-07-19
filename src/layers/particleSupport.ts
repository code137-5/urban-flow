/**
 * Probe whether this device can run the particle system's key constructs:
 * a transform-feedback program whose VERTEX stage samples a texture (the flow
 * field), plus the point-sprite render pair. Mirrors terrainSupport.ts — probe
 * the exact risky constructs on a throwaway context before deck.gl ever tries.
 *
 * Failure here disables ONLY the particles; the terrain (gated separately by
 * terrainShaderSupported) still renders. Worst case is today's shipped visual.
 */

const PARTICLE_UBO = `layout(std140) uniform particleUniforms {
  vec4 bounds;
  vec4 scale;
  vec4 motion;
  vec4 lifecycle;
  vec4 color;
  vec4 sprite;
} particle;`

// Update program: vertex-stage texture read + TF varying — the two constructs
// the simulation depends on.
const UPDATE_VS = `#version 300 es
${PARTICLE_UBO}
in vec4 inPosition;
in vec2 inSeed;
out vec4 outPosition;
uniform sampler2D flowTexture;
void main(void) {
  vec4 f = texture(flowTexture, inPosition.xy);
  vec2 dir = mix(vec2(-f.g, f.r), f.rg, particle.motion.z);
  outPosition = vec4(inPosition.xy + dir * particle.motion.w, f.b, inPosition.w + 1.0);
}`

const UPDATE_FS = `#version 300 es
precision highp float;
out vec4 fragColor;
void main(void) { fragColor = vec4(0.0); }`

// Render pair: point sprite with UBO-driven size/color.
const RENDER_VS = `#version 300 es
${PARTICLE_UBO}
in vec4 positions;
in vec2 seeds;
out float vAlpha;
void main(void) {
  vAlpha = smoothstep(0.0, particle.lifecycle.w, positions.w);
  gl_PointSize = particle.sprite.x * (1.0 + seeds.x);
  gl_Position = vec4(positions.xy, 0.0, 1.0);
}`

const RENDER_FS = `#version 300 es
precision highp float;
${PARTICLE_UBO}
in float vAlpha;
out vec4 fragColor;
void main(void) {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.12, d) * vAlpha * particle.color.a;
  fragColor = vec4(particle.color.rgb * a, a);
}`

let cached: boolean | undefined

export function particlesSupported(): boolean {
  if (cached !== undefined) return cached
  cached = probe()
  return cached
}

function probe(): boolean {
  if (typeof document === 'undefined') return true
  let gl: WebGL2RenderingContext | null = null
  try {
    gl = document.createElement('canvas').getContext('webgl2')
    if (!gl) return false

    // Spec guarantees 16, but this exact spec-vs-driver gap is what bit the
    // terrain (float VTF); verify the driver actually reports vertex units.
    if ((gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS) as number) < 1) return false

    const compile = (type: number, src: string): WebGLShader | null => {
      const shader = gl!.createShader(type)
      if (!shader) return null
      gl!.shaderSource(shader, src)
      gl!.compileShader(shader)
      return gl!.getShaderParameter(shader, gl!.COMPILE_STATUS) ? shader : null
    }

    const link = (vsSrc: string, fsSrc: string, tfVarying?: string): boolean => {
      const vs = compile(gl!.VERTEX_SHADER, vsSrc)
      const fs = compile(gl!.FRAGMENT_SHADER, fsSrc)
      if (!vs || !fs) return false
      const program = gl!.createProgram()
      if (!program) return false
      gl!.attachShader(program, vs)
      gl!.attachShader(program, fs)
      // Must be set BEFORE linkProgram — this is what makes it a TF program.
      if (tfVarying) gl!.transformFeedbackVaryings(program, [tfVarying], gl!.SEPARATE_ATTRIBS)
      gl!.linkProgram(program)
      return gl!.getProgramParameter(program, gl!.LINK_STATUS) === true
    }

    return link(UPDATE_VS, UPDATE_FS, 'outPosition') && link(RENDER_VS, RENDER_FS)
  } catch {
    return false
  } finally {
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
  }
}
