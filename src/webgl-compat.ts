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
 * browsers don't expose a usable console. We also emit rich diagnostics
 * (renderer/vendor/version, a global shader index, and the full numbered source)
 * to the console so an on-device debugger like eruda can read them, and expose
 * `window.__ufShaderErrors` for interactive inspection.
 *
 * (3) Some mobile GLSL ES drivers reject any non-ASCII byte in the shader source
 * (em-dashes and other Unicode in comments), often failing with an *empty* info
 * log that gives no clue why. We strip every non-ASCII character to a space in
 * `sanitizeShaderSource` before the source reaches the driver. GLSL has no string
 * literals and all valid tokens are ASCII, so non-ASCII can only appear in
 * comments — replacing it is always safe.
 *
 * (4) Several mobile GLSL ES drivers mis-handle *comment content itself* — its
 * length, particular characters, or nesting-lookalikes (`/*` inside `//`, `//`
 * inside a block comment) — and fail with an empty info log. Comments are
 * semantically dead, so we proactively strip ALL of them (line and block) in
 * `sanitizeShaderSource` before the source reaches the driver. Stripping is
 * always safe and removes an entire class of empty-log failures. We preserve
 * newlines (and, for block comments, replace each removed character with a
 * space) so line numbers in driver info logs stay aligned with the source.
 *
 * Import this module before any WebGL context is created (first in main.tsx).
 */

export type ShaderError = {
  stage: string
  log: string
  /** The cleaned source actually handed to the driver. */
  source: string
  /** Unmasked (or plain) GPU renderer string, when available. */
  renderer?: string
  /** Unmasked (or plain) GPU vendor string, when available. */
  vendor?: string
  /** GL VERSION string. */
  version?: string
  /** SHADING_LANGUAGE_VERSION string. */
  glsl?: string
  /** ANGLE-translated source, if `WEBGL_debug_shaders` exposes it (often empty). */
  translated?: string
  /** Global 1-based index of this `compileShader` call — tells you WHICH shader failed. */
  index?: number
  /**
   * The exact context the failing compile ran on, so post-mortem probes can
   * re-test the same source on the SAME (possibly poisoned) context as well as
   * on a fresh one. Debug tooling only — never read by app code.
   */
  gl?: WebGL2RenderingContext
}

/** Latest captured shader compile errors (most recent last). */
export const shaderErrors: ShaderError[] = []

declare global {
  interface Window {
    /** Captured shader compile errors, for on-device inspection (e.g. eruda). */
    __ufShaderErrors?: ShaderError[]
  }
}

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
 * Remove all GLSL comments with a single-pass character scanner (a regex is too
 * fragile for the edge cases: `//` inside `/* *\/`, `/*` inside `//`, an
 * unterminated block comment at EOF, a stray `*\/` with no opener, and slashes
 * in operators like `a / b` / `a /= b` that must NOT be eaten).
 *
 * - Line comment (`//` … end of line): dropped; the newline is kept.
 * - Block comment (`/* … *\/`): every non-newline character (delimiters
 *   included) becomes a space; newlines are kept, so a comment spanning N lines
 *   still yields N lines. An unterminated block comment runs to EOF.
 *
 * GLSL has no string or character literals, so no `/` can be "inside a string";
 * a plain scanner is therefore sufficient and safe. Line numbers are preserved,
 * keeping driver info-log line references aligned with the cleaned source.
 */
function stripComments(src: string): string {
  let out = ''
  const n = src.length
  let i = 0
  while (i < n) {
    const c = src[i]
    const d = i + 1 < n ? src[i + 1] : ''
    if (c === '/' && d === '/') {
      // Line comment: skip to (but not including) the newline; emit nothing.
      i += 2
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && d === '*') {
      // Block comment: blank out every non-newline char, keep newlines.
      out += '  ' // the opening `/*`
      i += 2
      while (i < n && !(src[i] === '*' && i + 1 < n && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      if (i < n) {
        out += '  ' // the closing `*/`
        i += 2
      }
      // If we hit EOF first (i === n), the block was unterminated → whole rest
      // was consumed as comment, which matches GLSL's own behavior.
      continue
    }
    // Any other `/` (division, `/=`, a bare `*/`) passes through untouched.
    out += c
    i++
  }
  return out
}

/**
 * Strip non-ASCII characters, then remove all comments, then remove illegal
 * storage qualifiers from interface-block members. Order matters: the non-ASCII
 * pass runs first so the scanner sees clean ASCII, the comment strip runs next
 * so the qualifier regex never trips over qualifier-lookalikes hidden in
 * comments, and the qualifier fix runs last on comment-free code.
 */
export function sanitizeShaderSource(src: string): string {
  return stripComments(src.replace(NON_ASCII, ' ')).replace(
    /\b(uniform|buffer)\s+(\w+)\s*\{([^{}]*)\}/g,
    (_full, blockQualifier: string, blockName: string, body: string) => {
      const cleaned = body.replace(/(^|\n)(\s*)(?:uniform|in|out)\s+/g, '$1$2')
      return `${blockQualifier} ${blockName} {${cleaned}}`
    },
  )
}

const sources = new WeakMap<WebGLShader, string>()

/** Per-context device strings, gathered once and cached. */
type ContextDiag = { renderer?: string; vendor?: string; version?: string; glsl?: string }
const contextDiag = new WeakMap<WebGL2RenderingContext, ContextDiag>()

/** Global running count of `compileShader` calls, so we can name the failing shader. */
let compileCount = 0

/**
 * Debug-mode compile tracing. Read once at module load (before any context
 * exists) from the same `uf-debug` flag `debug.ts` gates on, so normal visitors
 * pay nothing and see nothing. The trace exists because the phone's failures are
 * STATE/ORDER-dependent: knowing how many shaders compiled, in what order, and
 * which named one broke is the whole signal.
 */
const traceEnabled = (() => {
  try {
    return localStorage.getItem('uf-debug') === '1'
  } catch {
    return false
  }
})()

/** `#define SHADER_NAME foo-layer-fragment-shader` — luma names every shader it assembles. */
function shaderName(source: string | undefined): string {
  const m = source ? /#define SHADER_NAME (\S+)/.exec(source) : null
  return m ? m[1] : '?'
}

/** ONE terse line per compileShader call, console.error so eruda shows it. */
function trace(index: number, stage: string, ok: boolean, source: string | undefined): void {
  try {
    console.error(
      `[uf-trace] #${index} ${stage} ${ok ? 'ok' : 'FAIL'} ${shaderName(source)} ` +
        `len=${source ? source.length : 0}`,
    )
  } catch {
    /* ignore */
  }
}

/**
 * Shaders that already used up their one auto-retry. A driver whose compiler
 * service crashed reports failure with an EMPTY info log; the service respawns,
 * so a second `compileShader` on the same shader object can succeed. Retrying
 * more than once would just spin.
 */
const retried = new WeakSet<WebGLShader>()

/**
 * Read the GPU renderer/vendor/version strings from a context (cached per
 * context). Prefers the unmasked strings from `WEBGL_debug_renderer_info` and
 * falls back to the plain `RENDERER`/`VENDOR` parameters. Everything is wrapped
 * in try/catch: several of these calls throw on locked-down mobile drivers.
 */
function getContextDiag(gl: WebGL2RenderingContext): ContextDiag {
  const cached = contextDiag.get(gl)
  if (cached) return cached
  const d: ContextDiag = {}
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    if (ext) {
      d.renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string
      d.vendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) as string
    }
  } catch {
    /* ignore */
  }
  try {
    if (!d.renderer) d.renderer = gl.getParameter(gl.RENDERER) as string
  } catch {
    /* ignore */
  }
  try {
    if (!d.vendor) d.vendor = gl.getParameter(gl.VENDOR) as string
  } catch {
    /* ignore */
  }
  try {
    d.version = gl.getParameter(gl.VERSION) as string
  } catch {
    /* ignore */
  }
  try {
    d.glsl = gl.getParameter(gl.SHADING_LANGUAGE_VERSION) as string
  } catch {
    /* ignore */
  }
  contextDiag.set(gl, d)
  return d
}

function reportShaderError(err: ShaderError): void {
  shaderErrors.push(err)
  // (existing) one-line summary with the driver info log.
  try {
    console.error(`[urban-flow] ${err.stage} shader compile failed:\n${err.log}`)
  } catch {
    /* ignore */
  }
  // (1) device + failing-shader context, eruda-friendly single line.
  try {
    console.error(
      `[urban-flow] shader #${err.index ?? '?'} (${err.stage}) failed | ` +
        `renderer=${err.renderer ?? '?'} | vendor=${err.vendor ?? '?'} | ` +
        `version=${err.version ?? '?'} | glsl=${err.glsl ?? '?'} | ` +
        `sourceLength=${err.source.length}` +
        (err.translated ? ` | translatedLength=${err.translated.length}` : ''),
    )
  } catch {
    /* ignore */
  }
  // (2) full numbered source, chunked so eruda can render each block.
  try {
    const numbered = err.source
      .split('\n')
      .map((line, i) => `${String(i + 1).padStart(3, ' ')}| ${line}`)
    const CHUNK = 60
    for (let i = 0; i < numbered.length; i += CHUNK) {
      console.error(
        `[urban-flow] source lines ${i + 1}-${Math.min(i + CHUNK, numbered.length)}:\n` +
          numbered.slice(i, i + CHUNK).join('\n'),
      )
    }
  } catch {
    /* ignore */
  }
  // (3) full numbered ANGLE-translated source, same chunked format. This is what
  // the driver's own compiler actually consumed, so when the info log is empty
  // it is the only evidence of which construct the driver choked on.
  try {
    if (err.translated) {
      const numbered = err.translated
        .split('\n')
        .map((line, i) => `${String(i + 1).padStart(3, ' ')}| ${line}`)
      const CHUNK = 60
      for (let i = 0; i < numbered.length; i += CHUNK) {
        console.error(
          `[urban-flow] translated lines ${i + 1}-${Math.min(i + CHUNK, numbered.length)}:\n` +
            numbered.slice(i, i + CHUNK).join('\n'),
        )
      }
    }
  } catch {
    /* ignore */
  }
  try {
    window.dispatchEvent(new CustomEvent('uf-shader-error', { detail: err }))
  } catch {
    /* ignore */
  }
}

type GL = WebGL2RenderingContext & {
  __ufSanitized?: boolean
  __ufCompilePatched?: boolean
  __ufLinkPatched?: boolean
}

type SourceFn = (shader: WebGLShader, source: string) => void
type CompileFn = (shader: WebGLShader) => void

/**
 * The pre-patch `shaderSource` / `compileShader`, keyed by the prototype they
 * were taken from. `compileQuiet` uses these so probe compiles never run through
 * the reporting patch (which would push into `shaderErrors` and dump the full
 * numbered source for every intentionally-failing probe).
 */
const originalSource = new WeakMap<object, SourceFn>()
const originalCompile = new WeakMap<object, CompileFn>()

/** Walk the context's prototype chain for a remembered original. */
function findOriginal<T>(gl: object, map: WeakMap<object, T>): T | undefined {
  let proto: object | null = Object.getPrototypeOf(gl) as object | null
  while (proto) {
    const fn = map.get(proto)
    if (fn) return fn
    proto = Object.getPrototypeOf(proto) as object | null
  }
  return undefined
}

/**
 * Compile `source` on `gl` and return the status WITHOUT any of the reporting
 * side effects of the patched `compileShader`: nothing is pushed into
 * `shaderErrors`, no console dump, no `uf-shader-error` event. The source still
 * goes through `sanitizeShaderSource` explicitly, so a quiet compile sees
 * exactly the bytes a real shader would.
 *
 * Intended for the on-device probe lab (`debugProbes.ts`), where most probes are
 * expected to fail and the noise would bury the useful signal.
 */
export function compileQuiet(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): { ok: boolean; log: string } {
  const shader = gl.createShader(type)
  if (!shader) return { ok: false, log: '(createShader returned null)' }
  try {
    const clean = sanitizeShaderSource(source)
    const setSource = findOriginal(gl, originalSource)
    const compile = findOriginal(gl, originalCompile)
    if (setSource) setSource.call(gl, shader, clean)
    else gl.shaderSource(shader, clean)
    if (compile) compile.call(gl, shader)
    else gl.compileShader(shader)
    const ok = Boolean(gl.getShaderParameter(shader, gl.COMPILE_STATUS))
    const log = ok ? '' : gl.getShaderInfoLog(shader) || '(driver returned an empty info log)'
    return { ok, log }
  } catch (e) {
    return { ok: false, log: `(threw: ${String(e)})` }
  } finally {
    try {
      gl.deleteShader(shader)
    } catch {
      /* ignore */
    }
  }
}

function patchShaderSource(proto: GL | undefined): void {
  if (!proto || !proto.shaderSource || proto.__ufSanitized) return
  const original = proto.shaderSource
  originalSource.set(proto, original as SourceFn)
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
  originalCompile.set(proto, original as CompileFn)
  proto.compileShader = function (this: WebGL2RenderingContext, shader) {
    const index = ++compileCount
    original.call(this, shader)
    try {
      if (!shader) return
      let ok = Boolean(this.getShaderParameter(shader, this.COMPILE_STATUS))
      let rawLog = ok ? '' : this.getShaderInfoLog(shader) || ''

      // Auto-retry experiment: an empty info log is the signature of a crashed
      // Qualcomm shader-compiler service rather than a real GLSL error. The
      // service respawns, so compiling the SAME shader object a second time can
      // succeed — recompiling an attached shader is legal GL, and luma reads
      // COMPILE_STATUS after us, so it sees the updated state. Once per shader.
      if (!ok && rawLog.trim() === '' && !retried.has(shader)) {
        retried.add(shader)
        original.call(this, shader)
        ok = Boolean(this.getShaderParameter(shader, this.COMPILE_STATUS))
        if (ok) {
          try {
            console.warn(`[urban-flow] shader #${index} compiled on retry`)
          } catch {
            /* ignore */
          }
        } else {
          rawLog = this.getShaderInfoLog(shader) || ''
        }
      }

      const type = this.getShaderParameter(shader, this.SHADER_TYPE)
      const stage = type === this.VERTEX_SHADER ? 'vertex' : 'fragment'

      if (traceEnabled) trace(index, stage, ok, sources.get(shader))

      if (!ok) {
        const log = rawLog || '(driver returned an empty info log)'
        const diag = getContextDiag(this)
        let translated: string | undefined
        try {
          const ext = this.getExtension('WEBGL_debug_shaders')
          if (ext) translated = ext.getTranslatedShaderSource(shader) || undefined
        } catch {
          /* ignore */
        }
        reportShaderError({
          stage,
          log,
          source: sources.get(shader) ?? '',
          index,
          translated,
          gl: this,
          renderer: diag.renderer,
          vendor: diag.vendor,
          version: diag.version,
          glsl: diag.glsl,
        })
      }
    } catch {
      /* ignore */
    }
  }
  proto.__ufCompilePatched = true
}

function patchLinkProgram(proto: GL | undefined): void {
  if (!proto || !proto.linkProgram || proto.__ufLinkPatched) return
  const original = proto.linkProgram
  proto.linkProgram = function (this: WebGL2RenderingContext, program) {
    original.call(this, program)
    try {
      if (program && !this.getProgramParameter(program, this.LINK_STATUS)) {
        const log =
          this.getProgramInfoLog(program) || '(driver returned an empty program info log)'
        console.error(`[urban-flow] program link failed:\n${log}`)
      }
    } catch {
      /* ignore */
    }
  }
  proto.__ufLinkPatched = true
}

/** Install the shims on both WebGL2 and WebGL1 context prototypes (idempotent). */
export function installWebglCompat(): void {
  if (typeof window === 'undefined') return
  window.__ufShaderErrors = shaderErrors
  for (const ctor of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
    const proto = ctor?.prototype as GL | undefined
    patchShaderSource(proto)
    patchCompileShader(proto)
    patchLinkProgram(proto)
  }
}

installWebglCompat()
