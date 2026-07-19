import type { DataSource, GeoPoint } from '../types'

/**
 * Synthetic "Subway boardings (지하철 승하차)" dataset.
 *
 * No real data file — points are generated deterministically from a seeded PRNG
 * so the terrain is identical across reloads (bare Math.random is forbidden in
 * this env). The spatial signature is intentionally DISTINCT from Ttareungi:
 * tight, high-weight spikes around Seoul's major transfer stations, so switching
 * a panel to this dataset visibly sharpens the contour terrain into peaks.
 */

/** mulberry32 — tiny deterministic PRNG. Returns floats in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Major transfer hubs: [lng, lat, peak weight]. Spiky, high-intensity cores. */
const HUBS: readonly [number, number, number][] = [
  [127.028, 37.498, 900], // Gangnam
  [127.1, 37.513, 720], // Jamsil
  [126.972, 37.555, 840], // Seoul Station
  [126.981, 37.476, 560], // Sadang
  [127.037, 37.561, 500], // Wangsimni
  [126.924, 37.557, 640], // Hongdae
  [127.07, 37.54, 480], // Konkuk Univ
]

const POINT_COUNT = 120

function generate(): GeoPoint[] {
  const rand = mulberry32(0xc0_ffee)
  const points: GeoPoint[] = []
  for (let i = 0; i < POINT_COUNT; i++) {
    const [hlng, hlat, peak] = HUBS[i % HUBS.length]
    // Tight Gaussian-ish scatter around each hub (Box–Muller). Small sigma keeps
    // clusters compact so the KDE reads as spiky peaks rather than a plateau.
    const r = Math.sqrt(-2 * Math.log(rand() + 1e-9))
    const theta = 2 * Math.PI * rand()
    const sigma = 0.004
    const lng = hlng + r * Math.cos(theta) * sigma
    const lat = hlat + r * Math.sin(theta) * sigma * 0.8
    // High weight near the hub center, decaying with distance from it.
    const falloff = Math.max(0.15, 1 - r * 0.35)
    const weight = Math.round(peak * falloff * (0.6 + 0.4 * rand()))
    points.push({ lng, lat, weight })
  }
  return points
}

export const subwaySource: DataSource = {
  meta: {
    id: 'subway',
    label: 'Subway (지하철 승하차)',
    description: 'Boardings clustered at major transfer hubs',
    unit: 'riders',
    accent: '#4589ff', // IBM Blue 50 — in-palette, distinct from Ttareungi's Blue 40
  },
  load: async () => generate(),
}
