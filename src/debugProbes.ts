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
import { compileQuiet, shaderErrors } from './webgl-compat'
import particleFsSource from './layers/shaders/particle.fs.glsl'
import terrainFsSource from './layers/shaders/terrain.fs.glsl'

export type ProbeResult = { id: string; name: string; ok: boolean; log: string }

declare global {
  interface Window {
    /** Results of the on-device shader probe ladder (debug mode only). */
    __ufProbeResults?: { summary: string; firstFail: string | null; results: ProbeResult[] }
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
    {
      id: 'P00',
      name: 'minimal',
      source: `${VERSION}\n${PRECISION}\nout vec4 fragColor;\nvoid main(){fragColor=vec4(1.0);}\n`,
    },
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
