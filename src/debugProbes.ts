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
import { compileQuiet, compiledLog, sanitizeShaderSource, shaderErrors } from './webgl-compat'
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

/**
 * Line-level difference between the ANGLE translation of the SAME source on a
 * clean context and on one with a culprit extension enabled — the evidence an
 * upstream ANGLE/driver bug report needs.
 */
export type TranslatedDiff = {
  /** The culprit extension enabled for side (b). */
  ext: string
  /** False when `WEBGL_debug_shaders` gave us nothing to compare. */
  available: boolean
  /** True when both translations are byte-identical. */
  identical: boolean
  /** Lines present only in the CLEAN translation (capped). */
  removed: string[]
  /** Lines present only in the +ext translation (capped). */
  added: string[]
  /** Compile outcome of each side, for context. */
  cleanCompile: string
  extCompile: string
  note: string
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
  /** First extension named by the F3 search (kept for older readers). */
  culpritExt: string | null
  /** EVERY extension the F3 search named, in the order they were found. */
  culpritExts: string[]
  /** True when the compile passed with `culpritExts` excluded (list is complete). */
  culpritsComplete: boolean
  /** Translated-source evidence for the first culprit, when we got that far. */
  translatedDiff: TranslatedDiff | null
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
 *        supported extension, bisected repeatedly to name EVERY culprit, plus a
 *        translated-source diff for the first one),
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

// ---------------------------------------------------------------------------
// F3: find EVERY culprit extension, not just the first one.
// ---------------------------------------------------------------------------

/**
 * The device has more than one culprit: round 1 named
 * `NV_shader_noperspective_interpolation`, and once that was blocked app-wide
 * round 2 named `OES_shader_multisample_interpolation` behind it. A bisection
 * that stops at the first name costs a full user roundtrip per culprit, so the
 * search now loops: name a culprit, add it to `excluded`, re-test "all supported
 * extensions minus excluded" on a fresh context, and bisect again while that
 * still FAILs. Bounded three ways — culprits, total trials, and the shared
 * scratch-context budget — because every trial burns a WebGL context on a phone
 * that caps them at ~8-16 live.
 */
const MAX_CULPRITS = 6
const MAX_EXT_TRIALS = 40
const MAX_SINGLE_EXT_PROBES = 15

/** Shared state for one F3 search: trials spent, and why we stopped early. */
type ExtBudget = { trials: number; stop: string | null }

/** Enable `subset` on a fresh context, then compile the failing source. */
function extTrial(err: ShaderError, subset: readonly string[]): Trial | null {
  return trial(err, (gl) => {
    for (const name of subset) gl.getExtension(name)
  })
}

/**
 * One budgeted extension trial, yielding to the browser afterwards. Returns
 * `null` the moment a bound is hit (trials or contexts) with `budget.stop`
 * naming which — every caller treats `null` as "stop", never as a result.
 */
async function extProbe(
  err: ShaderError,
  subset: readonly string[],
  budget: ExtBudget,
): Promise<Trial | null> {
  if (budget.stop) return null
  if (budget.trials >= MAX_EXT_TRIALS) {
    budget.stop = `trial bound (${MAX_EXT_TRIALS})`
    return null
  }
  budget.trials++
  const r = extTrial(err, subset)
  if (!r) budget.stop = 'context budget exhausted'
  await idle()
  return r
}

/**
 * Neither half of the suspect set reproduced the FAIL on its own. Before
 * declaring an interaction, try the extensions one at a time — a bounded pass
 * that names a lone culprit the halving somehow stepped over.
 */
async function probeSingles(
  err: ShaderError,
  suspects: readonly string[],
  budget: ExtBudget,
): Promise<string | null> {
  const limit = Math.min(suspects.length, MAX_SINGLE_EXT_PROBES)
  logForensics(`F3 singles: trying ${limit} of ${suspects.length} exts one at a time`)
  for (let i = 0; i < limit; i++) {
    const name = suspects[i]
    const r = await extProbe(err, [name], budget)
    if (!r) return null
    if (!r.ok) return name
  }
  return null
}

/**
 * Halve the suspect list, keeping whichever half still reproduces the FAIL,
 * until one name is left. If neither half fails alone, fall back to single
 * extensions; if that finds nothing either, the trigger needs two extensions
 * from different halves, which this bisection cannot name.
 */
async function bisectExtensions(
  err: ShaderError,
  suspects: readonly string[],
  budget: ExtBudget,
): Promise<string | null> {
  let current = suspects.slice()
  for (let round = 0; round < 12 && current.length > 1; round++) {
    const mid = Math.ceil(current.length / 2)
    const first = current.slice(0, mid)
    const second = current.slice(mid)
    const a = await extProbe(err, first, budget)
    if (!a) return null
    if (!a.ok) {
      current = first
      continue
    }
    const b = await extProbe(err, second, budget)
    if (!b) return null
    if (!b.ok) {
      current = second
      continue
    }
    logForensics(`F3 bisect: neither half of ${current.length} exts fails alone (interaction)`)
    const single = await probeSingles(err, current, budget)
    if (!single) {
      if (!budget.stop) budget.stop = `interaction between >=2 of ${current.length} exts`
      return null
    }
    return single
  }
  return current.length === 1 ? current[0] : null
}

/** Outcome of the whole F3 search. */
type CulpritSearch = {
  culprits: string[]
  /** True when the compile PASSED with `culprits` excluded — the list is complete. */
  complete: boolean
  /** Why we stopped, when the list is not complete. */
  stop: string
}

/**
 * Loop the bisection until the failing source compiles with every named culprit
 * excluded. The caller has already proven that the full extension list FAILs,
 * so the first bisection runs without re-testing that.
 */
async function findCulpritExtensions(
  err: ShaderError,
  all: readonly string[],
): Promise<CulpritSearch> {
  const budget: ExtBudget = { trials: 0, stop: null }
  const culprits: string[] = []

  for (;;) {
    const suspects = all.filter((name) => !culprits.includes(name))
    const culprit = await bisectExtensions(err, suspects, budget)
    if (!culprit) {
      return {
        culprits,
        complete: false,
        stop: budget.stop ?? 'bisection did not resolve a single extension',
      }
    }
    culprits.push(culprit)
    logForensics(`F3 culprit ext = ${culprit}`)

    if (culprits.length >= MAX_CULPRITS) {
      return { culprits, complete: false, stop: `culprit bound (${MAX_CULPRITS})` }
    }
    const rest = all.filter((name) => !culprits.includes(name))
    if (rest.length === 0) return { culprits, complete: true, stop: '' }

    // Re-test "everything minus the culprits so far": passing ends the search.
    const r = await extProbe(err, rest, budget)
    if (!r) {
      return { culprits, complete: false, stop: budget.stop ?? 'context budget exhausted' }
    }
    logForensics(
      `F3 retest ${rest.length} exts minus ${culprits.length} culprit(s): ${r.ok ? 'ok' : 'FAIL'}`,
    )
    if (r.ok) return { culprits, complete: true, stop: '' }
  }
}

// ---------------------------------------------------------------------------
// Translated-source evidence: what a culprit extension changes in ANGLE's output.
// ---------------------------------------------------------------------------

/**
 * A hidden same-origin `about:blank` iframe. Its realm has its OWN
 * `WebGL2RenderingContext.prototype`, which `installWebglCompat` never touched
 * (it patches `window.WebGL2RenderingContext` of the main realm only), so
 * `gl.shaderSource` / `gl.compileShader` there are the pristine natives.
 *
 * We need that because `compileQuiet` deletes its shader while
 * `getTranslatedShaderSource` needs a live one, and the pre-patch originals
 * `compileQuiet` uses are module-private to `webgl-compat.ts` (a teammate owns
 * that file). Compiling through the PATCHED `compileShader` instead is not an
 * option: our +culprit compile is meant to fail, and a failure there would push
 * into `shaderErrors`, dump the full numbered source, and dispatch
 * `uf-shader-error` — which queues a whole second post-mortem + forensics run.
 * A separate realm gives us an unpatched compile with no such side effects.
 */
let pristineRealm: Window | null | undefined

function getPristineRealm(): Window | null {
  if (pristineRealm !== undefined) return pristineRealm
  pristineRealm = null
  try {
    const frame = document.createElement('iframe')
    frame.setAttribute('aria-hidden', 'true')
    frame.setAttribute('title', 'urban-flow forensics scratch realm')
    frame.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:1px;border:0'
    const host = document.body ?? document.documentElement
    host.appendChild(frame)
    if (frame.contentWindow?.document) pristineRealm = frame.contentWindow
  } catch {
    pristineRealm = null
  }
  return pristineRealm
}

/**
 * A scratch context we may compile on DIRECTLY. Prefers the pristine realm; a
 * main-realm context is only acceptable while it is unpatched (the patch marks
 * the prototype with `__ufCompilePatched`). No usable context means the diff is
 * skipped and says why — never silently compiled through the noisy path.
 */
function translationCtx(): { gl: WebGL2RenderingContext | null; reason: string } {
  const realm = getPristineRealm()
  if (realm) {
    try {
      const gl = realm.document.createElement('canvas').getContext('webgl2')
      if (gl) return { gl, reason: '' }
    } catch {
      /* fall through to the main realm */
    }
  }
  const gl = scratchCtx()
  if (!gl) return { gl: null, reason: 'no scratch context available' }
  if ('__ufCompilePatched' in gl) {
    releaseCtx(gl)
    return { gl: null, reason: 'no unpatched compile path (iframe realm unavailable)' }
  }
  return { gl, reason: '' }
}

type TranslatedCompile = { ok: boolean; log: string; translated?: string }

/**
 * `compileQuiet` with the shader kept alive long enough to read
 * `WEBGL_debug_shaders.getTranslatedShaderSource`. Only ever called with a
 * context from `translationCtx`, whose `shaderSource`/`compileShader` are the
 * unpatched natives — so this stays as quiet as `compileQuiet` itself.
 */
function compileKeepTranslated(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): TranslatedCompile {
  const shader = gl.createShader(type)
  if (!shader) return { ok: false, log: '(createShader returned null)' }
  try {
    gl.shaderSource(shader, sanitizeShaderSource(source))
    gl.compileShader(shader)
    const ok = Boolean(gl.getShaderParameter(shader, gl.COMPILE_STATUS))
    const log = ok ? '' : gl.getShaderInfoLog(shader) || '(driver returned an empty info log)'
    let translated: string | undefined
    try {
      const ext = gl.getExtension('WEBGL_debug_shaders')
      if (ext) translated = ext.getTranslatedShaderSource(shader) || undefined
    } catch {
      /* ignore */
    }
    return { ok, log, translated }
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

/** Enable `exts`, compile the failing source, keep the ANGLE translation. */
function captureTranslated(
  err: ShaderError,
  exts: readonly string[],
): { res: TranslatedCompile | null; reason: string } {
  const { gl, reason } = translationCtx()
  if (!gl) return { res: null, reason }
  try {
    for (const name of exts) gl.getExtension(name)
    const type = err.stage === 'vertex' ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER
    return { res: compileKeepTranslated(gl, type, err.source), reason: '' }
  } catch (e) {
    return { res: { ok: false, log: `(threw: ${String(e)})` }, reason: '' }
  } finally {
    releaseCtx(gl)
  }
}

/** Cap per diff side: enough to see the construct, short enough for a phone console. */
const DIFF_CAP = 25

/**
 * Lines of `a` that `b` does not have, order-preserving and multiplicity-aware
 * (a line repeated 3x in `a` and 1x in `b` yields 2). Not an LCS diff — for two
 * translations of the same source the interesting output is exactly "which
 * lines appeared/disappeared", and this stays cheap and dependency-free.
 */
function linesOnlyIn(a: readonly string[], b: readonly string[]): string[] {
  const remaining = new Map<string, number>()
  for (const line of b) remaining.set(line, (remaining.get(line) ?? 0) + 1)
  const out: string[] = []
  for (const line of a) {
    const n = remaining.get(line) ?? 0
    if (n > 0) remaining.set(line, n - 1)
    else out.push(line)
  }
  return out
}

function capped(lines: readonly string[]): string[] {
  return lines.length <= DIFF_CAP
    ? lines.slice()
    : [...lines.slice(0, DIFF_CAP), `... (${lines.length - DIFF_CAP} more)`]
}

/**
 * Compile the failing source twice more — once clean, once with only the first
 * culprit extension enabled — and diff ANGLE's translated output. That diff is
 * the one artefact an upstream ANGLE/driver bug report actually needs: it shows
 * whether the extension changes the generated code at all, or whether identical
 * code is being rejected purely because the extension is enabled.
 */
async function runTranslatedDiff(err: ShaderError, ext: string): Promise<TranslatedDiff> {
  const clean = captureTranslated(err, [])
  await idle()
  const withExt = captureTranslated(err, [ext])
  await idle()

  const diff: TranslatedDiff = {
    ext,
    available: false,
    identical: false,
    removed: [],
    added: [],
    cleanCompile: clean.res ? fmt(clean.res) : `skipped (${clean.reason})`,
    extCompile: withExt.res ? fmt(withExt.res) : `skipped (${withExt.reason})`,
    note: '',
  }

  const a = clean.res?.translated
  const b = withExt.res?.translated
  if (!clean.res || !withExt.res) {
    diff.note = `unavailable (${clean.reason || withExt.reason || 'no context'})`
  } else if (!a || !b) {
    diff.note =
      'unavailable (WEBGL_debug_shaders exposes no translated source on the scratch context' +
      `; clean=${a ? 'got it' : 'empty'}, +ext=${b ? 'got it' : 'empty'})`
  } else if (a === b) {
    diff.available = true
    diff.identical = true
    diff.note = `identical (${a.split('\n').length} lines, ${a.length} chars) - the extension changes the driver's verdict, not ANGLE's output`
  } else {
    diff.available = true
    const aLines = a.split('\n')
    const bLines = b.split('\n')
    diff.removed = capped(linesOnlyIn(aLines, bLines))
    diff.added = capped(linesOnlyIn(bLines, aLines))
    diff.note = `${aLines.length} vs ${bLines.length} lines`
  }

  const header = `translated diff (clean vs +${ext}):`
  if (!diff.available || diff.identical) {
    logForensics(`${header} ${diff.note} | clean ${diff.cleanCompile} | +ext ${diff.extCompile}`)
  } else {
    logForensics(
      `${header} ${diff.note} | clean ${diff.cleanCompile} | +ext ${diff.extCompile}\n` +
        [...diff.removed.map((l) => `- ${l}`), ...diff.added.map((l) => `+ ${l}`)].join('\n'),
    )
  }
  return diff
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
  let culpritExts: string[] = []
  let culpritsComplete = false
  let translatedDiff: TranslatedDiff | null = null
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

    // F3 — every supported extension enabled, then bisect (repeatedly, since
    // the device has more than one culprit) if that breaks it.
    try {
      let exts: string[] = []
      const r = trial(err, (gl) => {
        exts = gl.getSupportedExtensions() ?? []
        for (const name of exts) gl.getExtension(name)
      })
      f3 = outcome(r)
      logForensics(`F3 all-ext (${exts.length}) ${label}: ${r ? fmt(r) : 'skipped (no context)'}`)
      if (r && !r.ok && f2 === 'ok' && exts.length > 1) {
        const search = await findCulpritExtensions(err, exts)
        culpritExts = search.culprits
        culpritsComplete = search.complete
        if (search.culprits.length === 0) {
          logForensics(`F3 all culprits = none resolved (${search.stop})`)
        } else if (search.complete) {
          logForensics(
            `F3 all culprits = ${search.culprits.join(', ')} (compile passes with these excluded)`,
          )
        } else {
          logForensics(
            `F3 all culprits = ${search.culprits.join(', ')} ` +
              `(bound reached, list may be incomplete: ${search.stop})`,
          )
        }
      }
    } catch (e) {
      f3 = 'error'
      logForensics(`F3 crashed: ${String(e)}`)
    }
    await idle()

    // F3d — with a culprit confirmed, capture the evidence an upstream ANGLE
    // bug report needs: the translated source with and without that extension.
    try {
      const first = culpritExts[0]
      if (!first) {
        logForensics('translated diff: skipped (no culprit extension confirmed)')
      } else if (contextBudgetExhausted) {
        logForensics(`translated diff (clean vs +${first}): skipped (context budget exhausted)`)
      } else {
        translatedDiff = await runTranslatedDiff(err, first)
      }
    } catch (e) {
      logForensics(`translated diff crashed: ${String(e)}`)
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

    const culpritList =
      culpritExts.length === 0
        ? 'none'
        : culpritExts.join(', ') + (culpritsComplete ? '' : ' (incomplete)')
    const summary =
      `summary: F0 ${f0}, F1 ${f1}, F2 ${f2}, F3 ${f3}, F4 ${f4}, F5 ${f5}` +
      ` | culprit exts = ${culpritList}`
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
        culpritExt: culpritExts[0] ?? null,
        culpritExts,
        culpritsComplete,
        translatedDiff,
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
