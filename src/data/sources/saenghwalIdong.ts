import type { DataSource, GeoPoint } from '../types'
import { SEOUL_BOUNDS } from '../../config'

/**
 * Synthetic "Living Migration (생활이동)" dataset — Seoul population OD flow.
 *
 * No real data file — points are generated deterministically from a seeded PRNG
 * so the terrain is stable across reloads (bare Math.random is forbidden here).
 * The spatial signature is intentionally DISTINCT from Ttareungi and Subway:
 * broad, SMOOTH spread — strong central-business cores plus a diffuse residential
 * background blanketing the bounds, so the contours read as gentle rolling
 * terrain rather than isolated spikes.
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

/** CBD cores: [lng, lat, weight]. Broad, moderate-high, wide scatter. */
const CORES: readonly [number, number, number][] = [
  [126.99, 37.565, 620], // Jung-gu (historic CBD)
  [127.028, 37.498, 560], // Gangnam business district
  [126.924, 37.521, 480], // Yeouido (finance)
]

const CORE_COUNT = 90 // clustered around the three cores
const BACKGROUND_COUNT = 60 // diffuse residential fill across the bounds
const [MIN_LNG, MIN_LAT, MAX_LNG, MAX_LAT] = SEOUL_BOUNDS

function generate(): GeoPoint[] {
  const rand = mulberry32(0xba_da55)
  const points: GeoPoint[] = []

  // Broad Gaussian clusters over each core — larger sigma than Subway so the
  // heightmap stays smooth and rounded rather than spiky.
  for (let i = 0; i < CORE_COUNT; i++) {
    const [clng, clat, base] = CORES[i % CORES.length]
    const r = Math.sqrt(-2 * Math.log(rand() + 1e-9))
    const theta = 2 * Math.PI * rand()
    const sigma = 0.018
    const lng = clng + r * Math.cos(theta) * sigma
    const lat = clat + r * Math.sin(theta) * sigma * 0.8
    const weight = Math.round(base * (0.5 + 0.5 * rand()))
    points.push({ lng, lat, weight })
  }

  // Diffuse low-weight residential background so migration covers the whole city
  // instead of only the cores — this is what visually separates it from Subway.
  for (let i = 0; i < BACKGROUND_COUNT; i++) {
    const lng = MIN_LNG + (MAX_LNG - MIN_LNG) * rand()
    const lat = MIN_LAT + (MAX_LAT - MIN_LAT) * rand()
    const weight = Math.round(60 + 120 * rand())
    points.push({ lng, lat, weight })
  }

  return points
}

export const saenghwalIdongSource: DataSource = {
  meta: {
    id: 'saenghwal-idong',
    label: 'Living Migration (생활이동)',
    description: 'Population OD flow across central cores and suburbs',
    unit: 'people moved',
    accent: '#a6c8ff', // IBM Blue 30 — in-palette, lighter than the other two
  },
  load: async () => generate(),
}
