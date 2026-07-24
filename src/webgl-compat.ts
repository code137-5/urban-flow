/**
 * WebGL shader-source compatibility shim + on-screen compile-error capture.
 *
 * (1) deck.gl / luma.gl 9.3.x emit an illegal storage qualifier on an interface-
 * block member (`uniform float opacity;` inside a uniform block). Strict mobile
 * GLSL ES compilers reject it, so we intercept `gl.shaderSource` and strip
 * illegal `uniform`/`in`/`out` qualifiers from interface-block members.
 *
 * (2) When a shader still fails to compile on a device (some mobile GPUs reject
 * the ANGLE-translated program), we capture the driver's info log and surface it
 * via a `uf-shader-error` event so the app can show it on-screen — most mobile
 * browsers don't expose a usable console.
 *
 * (3) Some mobile GLSL ES drivers reject any non-ASCII byte in the shader source
 * (em-dashes and other Unicode in comments), often failing with an *empty* info
 * log that gives no clue why. We strip every non-ASCII character to a space in
 * `sanitizeShaderSource` before the source reaches the driver. GLSL has no string
 * literals and all valid tokens are ASCII, so non-ASCII can only appear in
 * comments — replacing it is always safe.
 *
 * Import this module before any WebGL context is created (first in main.tsx).
 */

export type ShaderError = { stage: string; log: string; source: string }

/** Latest captured shader compile errors (most recent last). */
export const shaderErrors: ShaderError[] = []

/**
 * Match every non-ASCII character (anything outside tab / LF / CR / printable
 * ASCII). GLSL has no string literals and all valid tokens are ASCII, so any
 * non-ASCII byte can only legally appear in a comment — replacing it with a
 * space is always safe. We replace (not delete) to preserve token separation
 * and keep line/column offsets stable for driver info logs. Characters outside
 * the BMP occupy two UTF-16 code units and become two spaces (one per unit).
 */
// oxlint-disable-next-line no-control-regex -- intentionally matches control bytes
const NON_ASCII = /[^\x09\x0A\x0D\x20-\x7E]/g

/**
 * Strip non-ASCII characters, then remove illegal storage qualifiers from
 * interface-block members. The non-ASCII pass runs first so the qualifier
 * regex always operates on clean, ASCII-only input.
 */
export function sanitizeShaderSource(src: string): string {
  return src.replace(NON_ASCII, ' ').replace(
    /\b(uniform|buffer)\s+(\w+)\s*\{([^{}]*)\}/g,
    (_full, blockQualifier: string, blockName: string, body: string) => {
      const cleaned = body.replace(/(^|\n)(\s*)(?:uniform|in|out)\s+/g, '$1$2')
      return `${blockQualifier} ${blockName} {${cleaned}}`
    },
  )
}

const sources = new WeakMap<WebGLShader, string>()

function reportShaderError(err: ShaderError): void {
  shaderErrors.push(err)
  try {
    console.error(`[urban-flow] ${err.stage} shader compile failed:\n${err.log}`)
  } catch {
    /* ignore */
  }
  try {
    window.dispatchEvent(new CustomEvent('uf-shader-error', { detail: err }))
  } catch {
    /* ignore */
  }
}

type GL = WebGL2RenderingContext & { __ufSanitized?: boolean; __ufCompilePatched?: boolean }

function patchShaderSource(proto: GL | undefined): void {
  if (!proto || !proto.shaderSource || proto.__ufSanitized) return
  const original = proto.shaderSource
  proto.shaderSource = function (this: WebGL2RenderingContext, shader, source) {
    const clean = typeof source === 'string' ? sanitizeShaderSource(source) : source
    if (shader && typeof clean === 'string') sources.set(shader, clean)
    return original.call(this, shader, clean as string)
  }
  proto.__ufSanitized = true
}

function patchCompileShader(proto: GL | undefined): void {
  if (!proto || !proto.compileShader || proto.__ufCompilePatched) return
  const original = proto.compileShader
  proto.compileShader = function (this: WebGL2RenderingContext, shader) {
    original.call(this, shader)
    try {
      if (shader && !this.getShaderParameter(shader, this.COMPILE_STATUS)) {
        const type = this.getShaderParameter(shader, this.SHADER_TYPE)
        const stage = type === this.VERTEX_SHADER ? 'vertex' : 'fragment'
        const log = this.getShaderInfoLog(shader) || '(driver returned an empty info log)'
        reportShaderError({ stage, log, source: sources.get(shader) ?? '' })
      }
    } catch {
      /* ignore */
    }
  }
  proto.__ufCompilePatched = true
}

/** Install the shims on both WebGL2 and WebGL1 context prototypes (idempotent). */
export function installWebglCompat(): void {
  if (typeof window === 'undefined') return
  for (const ctor of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
    const proto = ctor?.prototype as GL | undefined
    patchShaderSource(proto)
    patchCompileShader(proto)
  }
}

installWebglCompat()
