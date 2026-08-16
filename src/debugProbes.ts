/**
 * On-device shader probe lab.
 *
 * A phone (Qualcomm Adreno 710 / ANGLE / WebGL2) rejects our two custom FRAGMENT
 * shaders at `compileShader` with `COMPILE_STATUS = false` and an EMPTY info log,
 * even though ANGLE translation succeeds and the assembled sources are valid
 * ES 3.00. Every vertex shader compiles. That is a driver bug triggered by some
 * construct in the fragment prologue/body — and with no info log the only way to
 * find it is to bisect ON the device.
 *
 * This module compiles a ladder of fragment shaders that progressively add the
 * constructs of the real assembled shader (P00 minimal → P08 the real particle
 * fragment shader; P09 the real terrain fragment shader) and logs ONE line per
 * probe. The first FAIL names the construct that breaks the driver.
 *
 * It is loaded ONLY from `debug.ts`, only when debug mode is active, and only
 * after eruda is up so the lines are visible on the phone. Normal visitors never
 * request this chunk.
 *
 * All probes compile through `compileQuiet`, which uses the pre-patch
 * `shaderSource`/`compileShader`: probe failures are EXPECTED, so they must not
 * land in `shaderErrors` nor trigger the full numbered-source console dump.
 */
import { compileQuiet, compiledLog, shaderErrors } from './webgl-compat'
import type { CompiledEntry, ShaderError } from './webgl-compat'
import particleFsSource from './layers/shaders/particle.fs.glsl'
import terrainFsSource from './layers/shaders/terrain.fs.glsl'

export type ProbeResult = { id: string; name: string; ok: boolean; log: string }

/** One post-mortem run: the three re-tests around a single captured failure. */
export type PostMortemResult = {
  /** `index` of the failed compile this post-mortem investigates. */
  index: number | null
  stage: string
  freshCtx: { ok: boolean; log: string }
  sameCtx: { ok: boolean; log: string } | null
  sameCtxMinimal: { ok: boolean; log: string } | null
  verdict: string
}

/** One forensics run: the F0-F5 ladder around a single captured failure. */
export type ForensicsResult = {
  index: number | null
  stage: string
  /** Per-step outcome: 'ok' | 'FAIL' | 'skipped' | 'error'. */
  f0: string
  f1: string
  f2: string
  f3: string
  f4: string
  f5: string
  /** Context attributes of the failing context (F1), when we had one. */
  attributes: WebGLContextAttributes | null
  /** Extension named by the F3 bisection, when it resolved to exactly one. */
  culpritExt: string | null
  /** Prior-shader index named by the F5 bisection, when it resolved to one. */
  culpritIndex: number | null
  summary: string
}

declare global {
  interface Window {
    /** Results of the on-device shader probe ladder (debug mode only). */
    __ufProbeResults?: { summary: string; firstFail: string | null; results: ProbeResult[] }
    /** Post-mortem re-tests, one per captured shader failure (debug mode only). */
    __ufPostMortem?: PostMortemResult[]
    /** Context forensics, one per captured shader failure (debug mode only). */
    __ufForensics?: ForensicsResult[]
  }
}

// ---------------------------------------------------------------------------
// Prologue fragments, replicating what luma.gl assembles ahead of our shaders.
// ---------------------------------------------------------------------------

const VERSION = '#version 300 es'

const PRECISION = 'precision highp float;'

/** The real define block luma emits for a DEFAULT_GPU fragment shader. */
const DEFINES = `#define SHADER_TYPE_FRAGMENT
#define DEFAULT_GPU
#define LUMA_FP64_CODE_ELIMINATION_WORKAROUND 1
#define LUMA_FP32_TAN_PRECISION_WORKAROUND 1
#define LUMA_FP64_HIGH_BITS_OVERFLOW_WORKAROUND 1
#define MODULE_GEOMETRY
#define SMOOTH_EDGE_RADIUS 0.5`

/** deck.gl's geometry module: a struct type AND a global instance of it. */
const GEOMETRY = `struct FragmentGeometry {
  vec2 uv;
} geometry;

float smoothedge(float edge, float x) {
  return smoothstep(edge - SMOOTH_EDGE_RADIUS, edge + SMOOTH_EDGE_RADIUS, x);
}`

/**
 * The filter hook. Its parameter `geometry` SHADOWS the global instance above —
 * a legal but unusual construct, and a plausible driver trigger.
 */
const FILTER = `void DECKGL_FILTER_COLOR(inout vec4 color, FragmentGeometry geometry) {}`

/** deck.gl's core layer UBO. */
const LAYER_UBO = `layout(std140) uniform layerUniforms {
  float opacity;
} layer;`

/** Verbatim from src/layers/particleUniforms.ts. */
const PARTICLE_UBO = `layout(std140) uniform particleUniforms {
  vec4 bounds;
  vec4 scale;
  vec4 motion;
  vec4 lifecycle;
  vec4 color;
  vec4 sprite;
} particle;`

/** Verbatim from src/layers/terrainUniforms.ts. */
const TERRAIN_UBO = `layout(std140) uniform terrainUniforms {
  float heightScale;
  float interval;
  float lineWidth;
  float capOpacity;
  vec4 lineColor;
  vec4 peakColor;
} terrain;`

/**
 * Assemble a probe in luma's order: version, defines, precision, UBOs, modules,
 * hooks, then the shader body (varyings + `out` + `main`).
 */
function assemble(parts: {
  defines?: boolean
  ubos?: string[]
  geometry?: boolean
  filter?: boolean
  body: string
}): string {
  const out = [VERSION]
  if (parts.defines) out.push(DEFINES)
  out.push(PRECISION)
  for (const ubo of parts.ubos ?? []) out.push(ubo)
  if (parts.geometry) out.push(GEOMETRY)
  if (parts.filter) out.push(FILTER)
  out.push(parts.body)
  return out.join('\n\n') + '\n'
}

/** Strip the leading `#version` line from a real .glsl so we can re-prologue it. */
function stripVersion(src: string): string {
  return src.replace(/^\s*#version[^\n]*\n/, '')
}

// ---------------------------------------------------------------------------
// The probe ladder.
// ---------------------------------------------------------------------------

type Probe = { id: string; name: string; source: string }

/** P00: the smallest legal ES 3.00 fragment shader. If this fails, the compiler is dead. */
const MINIMAL_SOURCE = `${VERSION}\n${PRECISION}\nout vec4 fragColor;\nvoid main(){fragColor=vec4(1.0);}\n`

const MINIMAL_BODY = `out vec4 fragColor;

void main(void) {
  fragColor = vec4(1.0);
}`

const GEOMETRY_BODY = `out vec4 fragColor;

void main(void) {
  float e = smoothedge(0.5, geometry.uv.x);
  fragColor = vec4(e, e, e, 1.0);
}`

const FILTER_BODY = `out vec4 fragColor;

void main(void) {
  float e = smoothedge(0.5, geometry.uv.x);
  fragColor = vec4(e, e, e, 1.0);
  DECKGL_FILTER_COLOR(fragColor, geometry);
}`

const LAYER_BODY = `out vec4 fragColor;

void main(void) {
  float e = smoothedge(0.5, geometry.uv.x);
  fragColor = vec4(e, e, e, layer.opacity);
  DECKGL_FILTER_COLOR(fragColor, geometry);
}`

const PARTICLE_UBO_BODY = `out vec4 fragColor;

void main(void) {
  float e = smoothedge(0.5, geometry.uv.x);
  float a = e * particle.sprite.z * particle.color.a * layer.opacity;
  fragColor = vec4(particle.color.rgb * a, a);
  DECKGL_FILTER_COLOR(fragColor, geometry);
}`

const VARYING_BODY = `in float vAlpha;

out vec4 fragColor;

void main(void) {
  float e = smoothedge(0.5, geometry.uv.x);
  float a = e * vAlpha * particle.sprite.z * particle.color.a * layer.opacity;
  fragColor = vec4(particle.color.rgb * a, a);
  DECKGL_FILTER_COLOR(fragColor, geometry);
}`

const DISCARD_BODY = `in float vAlpha;

out vec4 fragColor;

void main(void) {
  float e = smoothedge(0.5, geometry.uv.x);
  float a = e * vAlpha * particle.sprite.z * particle.color.a * layer.opacity;
  if (a < 0.01) discard;
  fragColor = vec4(particle.color.rgb * a, a);
  DECKGL_FILTER_COLOR(fragColor, geometry);
}`

function buildProbes(): Probe[] {
  return [
    { id: 'P00', name: 'minimal', source: MINIMAL_SOURCE },
    {
      id: 'P01',
      name: 'defines',
      source: assemble({ defines: true, body: MINIMAL_BODY }),
    },
    {
      id: 'P02',
      name: 'geometry-struct+smoothedge',
      source: assemble({ defines: true, geometry: true, body: GEOMETRY_BODY }),
    },
    {
      id: 'P03',
      name: 'shadow-param filter hook',
      source: assemble({ defines: true, geometry: true, filter: true, body: FILTER_BODY }),
    },
    {
      id: 'P04',
      name: 'layerUniforms std140',
      source: assemble({
        defines: true,
        ubos: [LAYER_UBO],
        geometry: true,
        filter: true,
        body: LAYER_BODY,
      }),
    },
    {
      id: 'P05',
      name: 'particleUniforms std140 (2nd block)',
      source: assemble({
        defines: true,
        ubos: [LAYER_UBO, PARTICLE_UBO],
        geometry: true,
        filter: true,
        body: PARTICLE_UBO_BODY,
      }),
    },
    {
      id: 'P06',
      name: 'vAlpha varying',
      source: assemble({
        defines: true,
        ubos: [LAYER_UBO, PARTICLE_UBO],
        geometry: true,
        filter: true,
        body: VARYING_BODY,
      }),
    },
    {
      id: 'P07',
      name: 'conditional discard',
      source: assemble({
        defines: true,
        ubos: [LAYER_UBO, PARTICLE_UBO],
        geometry: true,
        filter: true,
        body: DISCARD_BODY,
      }),
    },
    {
      id: 'P08',
      name: 'real particle.fs (gl_PointCoord)',
      source: assemble({
        defines: true,
        ubos: [LAYER_UBO, PARTICLE_UBO],
        geometry: true,
        filter: true,
        body: stripVersion(particleFsSource),
      }),
    },
    {
      id: 'P09',
      name: 'real terrain.fs',
      source: assemble({
        defines: true,
        ubos: [LAYER_UBO, TERRAIN_UBO],
        geometry: true,
        filter: true,
        body: stripVersion(terrainFsSource),
      }),
    },
  ]
}

// ---------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------

function logProbe(r: ProbeResult): void {
  try {
    // console.error so eruda renders it red and it survives log-level filters.
    console.error(
      r.ok
        ? `[uf-probe] ${r.id} ${r.name}: ok`
        : `[uf-probe] ${r.id} ${r.name}: FAIL log="${r.log.replace(/\s+/g, ' ').trim()}"`,
    )
  } catch {
    /* ignore */
  }
}

export async function runShaderProbes(): Promise<void> {
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2')
    if (!gl) {
      console.error('[uf-probe] no webgl2 context available - probes skipped')
      return
    }

    const results: ProbeResult[] = []

    for (const probe of buildProbes()) {
      let res: { ok: boolean; log: string }
      try {
        res = compileQuiet(gl, gl.FRAGMENT_SHADER, probe.source)
      } catch (e) {
        res = { ok: false, log: `(probe threw: ${String(e)})` }
      }
      const r: ProbeResult = { id: probe.id, name: probe.name, ok: res.ok, log: res.log }
      results.push(r)
      logProbe(r)
    }

    // P10+ — recompile the REAL captured failures verbatim on the scratch
    // context, to confirm the probe context reproduces the device failure.
    // (Usually empty at this point: probes run before the first deck.gl render.)
    const real = shaderErrors.filter((e) => e.source)
    if (real.length === 0) {
      console.error('[uf-probe] P10+ verbatim-recompile: skipped (no captured shader failures yet)')
    } else {
      real.forEach((err, i) => {
        const id = `P${10 + i}`
        const name = `verbatim shader #${err.index ?? '?'} (${err.stage})`
        let res: { ok: boolean; log: string }
        try {
          const type = err.stage === 'vertex' ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER
          res = compileQuiet(gl, type, err.source)
        } catch (e) {
          res = { ok: false, log: `(probe threw: ${String(e)})` }
        }
        const r: ProbeResult = { id, name, ok: res.ok, log: res.log }
        results.push(r)
        logProbe(r)
      })
    }

    const firstFail = results.find((r) => !r.ok) ?? null
    const summary =
      `[uf-probe] summary: ${results.map((r) => `${r.id} ${r.ok ? 'ok' : 'FAIL'}`).join(', ')}` +
      ` | FIRST FAIL = ${firstFail ? `${firstFail.id} ${firstFail.name}` : 'none'}`
    try {
      console.error(summary)
    } catch {
      /* ignore */
    }
    try {
      window.__ufProbeResults = {
        summary,
        firstFail: firstFail ? firstFail.id : null,
        results,
      }
    } catch {
      /* ignore */
    }
  } catch (e) {
    try {
      console.error('[uf-probe] probe lab crashed', e)
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Post-mortem: re-test a REAL failure after it happened.
// ---------------------------------------------------------------------------

/**
 * The probe ladder runs before React renders and passes everything, including
 * the real fragment bodies — so the phone's failure is state/order-dependent,
 * not construct-dependent. This is the other half of the experiment: once a
 * compile has actually failed, recompile the exact same bytes
 *
 *   T1 on a FRESH scratch context,
 *   T2 on the SAME context that just failed,
 *   T3 the minimal P00 shader on that same context,
 *
 * which separates "this source is bad" from "that context's compiler is gone".
 */
function logPost(line: string): void {
  try {
    // console.error so eruda renders it red and it survives log-level filters.
    console.error(`[uf-postmortem] ${line}`)
  } catch {
    /* ignore */
  }
}

function fmt(res: { ok: boolean; log: string }): string {
  return res.ok ? 'ok' : `FAIL log="${res.log.replace(/\s+/g, ' ').trim()}"`
}

function verdictFor(
  fresh: { ok: boolean },
  same: { ok: boolean } | null,
  minimal: { ok: boolean } | null,
): string {
  if (!fresh.ok) return 'source-dependent after all'
  if (!same) return 'no context captured - fresh ctx compiles the same source'
  if (same.ok) return 'transient - compiler recovered; retry could work'
  if (minimal && !minimal.ok) return 'context compiler dead (even minimal fails)'
  if (minimal && minimal.ok) return 'source+state interaction on that context'
  return 'context poisoned (fresh ctx compiles same source)'
}

export async function runPostMortem(err: ShaderError): Promise<void> {
  try {
    const label = `shader#${err.index ?? '?'}`
    const type = err.stage === 'vertex' ? 'vertex' : 'fragment'

    // T1 — fresh scratch context.
    let fresh: { ok: boolean; log: string }
    try {
      const canvas = document.createElement('canvas')
      const gl = canvas.getContext('webgl2')
      fresh = gl
        ? compileQuiet(gl, type === 'vertex' ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER, err.source)
        : { ok: false, log: '(no fresh webgl2 context)' }
    } catch (e) {
      fresh = { ok: false, log: `(threw: ${String(e)})` }
    }
    logPost(`T1 fresh-ctx ${label}: ${fmt(fresh)}`)

    // T2/T3 — the exact context that failed, if we captured it.
    let same: { ok: boolean; log: string } | null = null
    let minimal: { ok: boolean; log: string } | null = null
    const gl = err.gl
    if (gl) {
      try {
        same = compileQuiet(gl, type === 'vertex' ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER, err.source)
      } catch (e) {
        same = { ok: false, log: `(threw: ${String(e)})` }
      }
      logPost(`T2 same-ctx ${label}: ${fmt(same)}`)
      try {
        minimal = compileQuiet(gl, gl.FRAGMENT_SHADER, MINIMAL_SOURCE)
      } catch (e) {
        minimal = { ok: false, log: `(threw: ${String(e)})` }
      }
      logPost(`T3 same-ctx minimal: ${fmt(minimal)}`)
    } else {
      logPost(`T2/T3 same-ctx ${label}: skipped (no context captured on the error)`)
    }

    const verdict = verdictFor(fresh, same, minimal)
    logPost(`verdict: ${verdict}`)

    try {
      const store = (window.__ufPostMortem ??= [])
      store.push({
        index: err.index ?? null,
        stage: err.stage,
        freshCtx: fresh,
        sameCtx: same,
        sameCtxMinimal: minimal,
        verdict,
      })
    } catch {
      /* ignore */
    }
  } catch (e) {
    try {
      console.error('[uf-postmortem] crashed', e)
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Context forensics: WHICH property of deck.gl's context breaks these sources.
// ---------------------------------------------------------------------------

/**
 * The post-mortem verdict is "source+state interaction": the exact bytes that
 * fail on deck.gl's context compile fine on a fresh one, and a minimal shader
 * compiles fine on deck.gl's context. So the difference is a property of THAT
 * context. Only three candidates can differ on a freshly-made context:
 *
 *   F1  the context ATTRIBUTES deck.gl asked for (antialias/alpha/depth/...),
 *   F2/F3 the EXTENSIONS enabled on it (KHR_parallel_shader_compile first —
 *        it makes compiles asynchronous, so a status read can race — then every
 *        supported extension, bisected to name the culprit),
 *   F4/F5 the SEQUENCE of shaders compiled on it before ours (the trace shows
 *        both failures land immediately after one of OUR big vertex shaders).
 *
 * Every step re-compiles the exact failing source on a FRESH scratch context
 * that differs from the baseline in exactly one way, so a FAIL names the cause.
 * Scratch contexts are released with `WEBGL_lose_context` because the bisections
 * can create dozens and mobile browsers cap live contexts at ~8-16.
 */
function logForensics(line: string): void {
  try {
    // console.error so eruda renders it red and it survives log-level filters.
    console.error(`[uf-forensics] ${line}`)
  } catch {
    /* ignore */
  }
}

/** Once a context creation fails, every later step degrades to 'skipped'. */
let contextBudgetExhausted = false

function scratchCtx(attrs?: WebGLContextAttributes): WebGL2RenderingContext | null {
  if (contextBudgetExhausted) return null
  let gl: WebGL2RenderingContext | null = null
  try {
    gl = document.createElement('canvas').getContext('webgl2', attrs)
  } catch {
    gl = null
  }
  if (!gl) {
    contextBudgetExhausted = true
    logForensics('(context budget exhausted)')
  }
  return gl
}

function releaseCtx(gl: WebGL2RenderingContext): void {
  try {
    const ext = gl.getExtension('WEBGL_lose_context') as WEBGL_lose_context | null
    ext?.loseContext()
  } catch {
    /* ignore */
  }
}

type Trial = { ok: boolean; log: string }

/**
 * One experiment: fresh context (optionally with `attrs`), `prepare` it, then
 * compile the failing source on it. `null` means "no context left" — the caller
 * reports 'skipped' rather than inventing a result.
 */
function trial(
  err: ShaderError,
  prepare?: (gl: WebGL2RenderingContext) => void,
  attrs?: WebGLContextAttributes,
): Trial | null {
  const gl = scratchCtx(attrs)
  if (!gl) return null
  try {
    prepare?.(gl)
    return compileQuiet(gl, err.stage === 'vertex' ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER, err.source)
  } catch (e) {
    return { ok: false, log: `(threw: ${String(e)})` }
  } finally {
    releaseCtx(gl)
  }
}

function outcome(r: Trial | null): string {
  return r ? (r.ok ? 'ok' : 'FAIL') : 'skipped'
}

/** Yield to the browser between steps: forensics must not block a phone's UI. */
function idle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Enable `subset` on a fresh context, then compile the failing source. */
function extTrial(err: ShaderError, subset: readonly string[]): Trial | null {
  return trial(err, (gl) => {
    for (const name of subset) gl.getExtension(name)
  })
}

/**
 * Halve the extension list, keeping whichever half still reproduces the FAIL,
 * until one name is left. If neither half fails alone the trigger needs two
 * extensions from different halves, which this simple bisection cannot name —
 * we report the surviving list size instead of guessing.
 */
function bisectExtensions(err: ShaderError, list: readonly string[]): string | null {
  let current = list.slice()
  for (let round = 0; round < 10 && current.length > 1; round++) {
    const mid = Math.ceil(current.length / 2)
    const first = current.slice(0, mid)
    const second = current.slice(mid)
    const a = extTrial(err, first)
    if (!a) return null
    if (!a.ok) {
      current = first
      continue
    }
    const b = extTrial(err, second)
    if (!b) return null
    if (!b.ok) {
      current = second
      continue
    }
    logForensics(`F3 bisect: neither half of ${current.length} exts fails alone (interaction)`)
    return null
  }
  return current.length === 1 ? current[0] : null
}

/** Replay `entries` (in order) on a fresh context, then compile the failing source. */
function replayTrial(err: ShaderError, entries: readonly CompiledEntry[]): Trial | null {
  return trial(err, (gl) => {
    for (const e of entries) {
      compileQuiet(gl, e.stage === 'vertex' ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER, e.source)
    }
  })
}

function describeEntry(e: CompiledEntry): string {
  return `#${e.index} ${e.stage} len=${e.source.length}`
}

/**
 * F5. `prior` (whole prefix) is known to reproduce the failure. Find the
 * smallest cause: first try the last three shaders individually — the trace
 * points at the custom vertex shader immediately before the failure, so a single
 * hit here is both likely and cheap — then binary-search the prefix length.
 */
function bisectPrefix(
  err: ShaderError,
  prior: readonly CompiledEntry[],
): { line: string; culpritIndex: number | null } {
  for (const e of prior.slice(-3).reverse()) {
    const r = replayTrial(err, [e])
    if (!r) return { line: 'F5 culprit = unresolved (context budget exhausted)', culpritIndex: null }
    if (!r.ok) {
      return { line: `F5 culprit = ${describeEntry(e)}`, culpritIndex: e.index }
    }
  }
  // No single late shader does it — find the shortest prefix that still fails.
  let lo = 1
  let hi = prior.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const r = replayTrial(err, prior.slice(0, mid))
    if (!r) return { line: 'F5 culprit = unresolved (context budget exhausted)', culpritIndex: null }
    if (r.ok) lo = mid + 1
    else hi = mid
  }
  const minimal = prior.slice(0, lo)
  const last = minimal[minimal.length - 1]
  if (minimal.length === 1 && last) {
    return { line: `F5 culprit = ${describeEntry(last)}`, culpritIndex: last.index }
  }
  return {
    line:
      `F5 culprit = prefix of ${minimal.length} shaders` +
      (last ? ` (last ${describeEntry(last)})` : ''),
    culpritIndex: null,
  }
}

/**
 * Run the F0-F5 ladder for one captured failure. Every step is individually
 * guarded: a crash in one experiment must not cost us the others' output.
 */
export async function runForensics(err: ShaderError): Promise<void> {
  const label = `shader#${err.index ?? '?'}`
  let f0 = 'skipped'
  let f1 = 'skipped'
  let f2 = 'skipped'
  let f3 = 'skipped'
  let f4 = 'skipped'
  let f5 = 'skipped'
  let attributes: WebGLContextAttributes | null = null
  let culpritExt: string | null = null
  let culpritIndex: number | null = null

  try {
    // F0 — baseline: does the failing source compile on a plain fresh context?
    try {
      const r = trial(err)
      f0 = outcome(r)
      logForensics(`F0 baseline fresh-ctx ${label}: ${r ? fmt(r) : 'skipped (no context)'}`)
    } catch (e) {
      f0 = 'error'
      logForensics(`F0 crashed: ${String(e)}`)
    }
    await idle()

    // F1 — same context ATTRIBUTES deck.gl requested.
    try {
      attributes = err.gl?.getContextAttributes() ?? null
      if (!attributes) {
        logForensics('F1 attrs: skipped (no context captured on the error)')
      } else {
        logForensics(`F1 attrs = ${JSON.stringify(attributes)}`)
        const r = trial(err, undefined, attributes)
        f1 = outcome(r)
        logForensics(`F1 attrs-ctx ${label}: ${r ? fmt(r) : 'skipped (no context)'}`)
      }
    } catch (e) {
      f1 = 'error'
      logForensics(`F1 crashed: ${String(e)}`)
    }
    await idle()

    // F2 — KHR_parallel_shader_compile, the one extension that changes what
    // COMPILE_STATUS even means (it makes compilation asynchronous).
    try {
      const r = trial(err, (gl) => {
        gl.getExtension('KHR_parallel_shader_compile')
      })
      f2 = outcome(r)
      logForensics(`F2 parallel-ext ${label}: ${r ? fmt(r) : 'skipped (no context)'}`)
    } catch (e) {
      f2 = 'error'
      logForensics(`F2 crashed: ${String(e)}`)
    }
    await idle()

    // F3 — every supported extension enabled, then bisect if that breaks it.
    try {
      let exts: string[] = []
      const r = trial(err, (gl) => {
        exts = gl.getSupportedExtensions() ?? []
        for (const name of exts) gl.getExtension(name)
      })
      f3 = outcome(r)
      logForensics(`F3 all-ext (${exts.length}) ${label}: ${r ? fmt(r) : 'skipped (no context)'}`)
      if (r && !r.ok && f2 === 'ok' && exts.length > 1) {
        culpritExt = bisectExtensions(err, exts)
        logForensics(`F3 culprit ext = ${culpritExt ?? 'unresolved'}`)
      }
    } catch (e) {
      f3 = 'error'
      logForensics(`F3 crashed: ${String(e)}`)
    }
    await idle()

    // F4 — replay the whole compile SEQUENCE that preceded the failure onto a
    // fresh context. A FAIL here means prior compiles alone poison a context.
    let prior: CompiledEntry[] = []
    try {
      prior =
        err.index == null
          ? []
          : compiledLog.filter((e) => e.index < (err.index ?? 0) && e.source.length > 0)
      if (prior.length === 0) {
        logForensics('F4 replay: skipped (no recorded prior shaders)')
      } else {
        const r = replayTrial(err, prior)
        f4 = outcome(r)
        logForensics(
          `F4 replay ${prior.length} prior shaders then ${label}: ${r ? fmt(r) : 'skipped (no context)'}`,
        )
      }
    } catch (e) {
      f4 = 'error'
      logForensics(`F4 crashed: ${String(e)}`)
    }
    await idle()

    // F5 — the sequence reproduces it: shrink it to the single guilty shader.
    try {
      if (f4 === 'FAIL' && prior.length > 0) {
        // Only meaningful when F0 proved the source compiles on a plain context:
        // a source that fails everywhere makes every trial "fail" and the
        // bisection would crown the first shader it tried.
        const meaningful = f0 === 'ok'
        if (!meaningful) {
          logForensics('F5 note: F0 FAILed too - this source is broken on any context, so the bisection below is meaningless')
        }
        const res = bisectPrefix(err, prior)
        culpritIndex = meaningful ? res.culpritIndex : null
        f5 =
          res.culpritIndex == null
            ? 'unresolved'
            : `#${res.culpritIndex}${meaningful ? '' : ' (meaningless: F0 FAIL)'}`
        logForensics(res.line + (meaningful ? '' : ' (meaningless: F0 FAIL)'))
      } else {
        logForensics(`F5 auto-bisect: skipped (F4 ${f4})`)
      }
    } catch (e) {
      f5 = 'error'
      logForensics(`F5 crashed: ${String(e)}`)
    }

    const summary = `summary: F0 ${f0}, F1 ${f1}, F2 ${f2}, F3 ${f3}, F4 ${f4}, F5 ${f5}`
    logForensics(summary)
    try {
      const store = (window.__ufForensics ??= [])
      store.push({
        index: err.index ?? null,
        stage: err.stage,
        f0,
        f1,
        f2,
        f3,
        f4,
        f5,
        attributes,
        culpritExt,
        culpritIndex,
        summary,
      })
    } catch {
      /* ignore */
    }
  } catch (e) {
    try {
      console.error('[uf-forensics] crashed', e)
    } catch {
      /* ignore */
    }
  }
}
