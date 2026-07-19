/**
 * Probe whether this device can compile the contour-terrain shader's key
 * constructs (std140 UBO with vec4 members, the contour fragment math). Some
 * mobile GPU drivers reject the ANGLE-translated version even though the source
 * is spec-valid and desktop/laptop compiles it fine. If the probe fails, the
 * dashboard shows the zero-WebGL SVG fallback instead of letting deck.gl try
 * (and surface a shader-error overlay).
 *
 * The probe mirrors the real terrain program: a texture-less vertex shader that
 * passes a baked height, and a fragment shader with the exact UBO layout + ops.
 */
const PROBE_VS = `#version 300 es
in float heightVal;
out float vHeight;
void main(void) {
  vHeight = max(heightVal, 0.0);
  gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
}`

const PROBE_FS = `#version 300 es
precision highp float;
layout(std140) uniform terrainUniforms {
  float heightScale;
  float interval;
  float lineWidth;
  float capOpacity;
  vec4 lineColor;
  vec4 peakColor;
} terrain;
layout(std140) uniform layerUniforms {
  float opacity;
} layer;
in float vHeight;
out vec4 fragColor;
void main(void) {
  float h = vHeight / terrain.interval;
  float f = abs(fract(h - 0.5) - 0.5);
  float line = 1.0 - smoothstep(terrain.lineWidth, terrain.lineWidth + 0.03, f);
  vec3 color = mix(terrain.lineColor, terrain.peakColor, vHeight).rgb;
  fragColor = vec4(color, line * layer.opacity);
}`

let cached: boolean | undefined

export function terrainShaderSupported(): boolean {
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

    const compile = (type: number, src: string): WebGLShader | null => {
      const shader = gl!.createShader(type)
      if (!shader) return null
      gl!.shaderSource(shader, src)
      gl!.compileShader(shader)
      return gl!.getShaderParameter(shader, gl!.COMPILE_STATUS) ? shader : null
    }

    const vs = compile(gl.VERTEX_SHADER, PROBE_VS)
    const fs = compile(gl.FRAGMENT_SHADER, PROBE_FS)
    if (!vs || !fs) return false

    const program = gl.createProgram()
    if (!program) return false
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    return gl.getProgramParameter(program, gl.LINK_STATUS) === true
  } catch {
    return false
  } finally {
    // Drop the probe context promptly.
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
  }
}
