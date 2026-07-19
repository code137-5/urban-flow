import type { DataSource, GeoPoint, HourlyWeights } from '../types'

/**
 * Saenghwal-idong (생활이동) — population origin–destination movement.
 *
 * Synthetic mock data, generated deterministically in code (seeded RNG) instead
 * of a CSV: ~140 weighted points clustered around the three big employment
 * centers (Gangnam, Yeouido, Jongno/City Hall) plus low-weight background
 * scatter across Seoul. Weights are in the same order of magnitude as the
 * ttareungi mock (the KDE p99-normalizes, so only relative shape matters).
 * A real adapter would aggregate the open 생활이동 OD dataset the same way.
 */

const BOUNDS = { minLng: 126.76, minLat: 37.42, maxLng: 127.18, maxLat: 37.7 }

/** Deterministic 32-bit PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Standard-normal sample (Box–Muller) driven by the seeded RNG. */
function gaussian(rng: () => number): number {
  const u = Math.max(rng(), 1e-9)
  const v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi)

/**
 * Commute-shaped hourly profile: morning (h8) and evening (h18) peaks with a
 * midday shoulder. Distributes `weight` across 24 hours (rounded).
 */
function hourlyProfile(weight: number, rng: () => number): HourlyWeights {
  const bump = (h: number, center: number, sigma: number) =>
    Math.exp(-((h - center) ** 2) / (2 * sigma * sigma))
  const raw: number[] = []
  for (let h = 0; h < 24; h++) {
    const shape = 0.05 + bump(h, 8, 1.6) + 0.9 * bump(h, 18, 2.0) + 0.25 * bump(h, 13, 3.0)
    raw.push(shape * (0.85 + 0.3 * rng()))
  }
  const sum = raw.reduce((s, x) => s + x, 0)
  return raw.map((x) => Math.round((x / sum) * weight))
}

interface Cluster {
  lng: number
  lat: number
  /** Spatial std-dev in degrees. */
  spread: number
  count: number
  /** Peak weight at cluster core. */
  peak: number
}

// Employment/activity centers — deliberately a different spatial pattern from
// the ttareungi mock (which leans Hongdae/Jamsil/riverside leisure spots).
const CLUSTERS: Cluster[] = [
  { lng: 127.03, lat: 37.5, spread: 0.02, count: 40, peak: 24000 }, // Gangnam
  { lng: 126.92, lat: 37.52, spread: 0.013, count: 30, peak: 15000 }, // Yeouido
  { lng: 126.98, lat: 37.57, spread: 0.017, count: 35, peak: 18000 }, // Jongno / City Hall
]

const BACKGROUND_COUNT = 35

function generate(): GeoPoint[] {
  const rng = mulberry32(0x5e0421) // fixed seed — deterministic output
  const points: GeoPoint[] = []

  for (const c of CLUSTERS) {
    for (let i = 0; i < c.count; i++) {
      const dLng = gaussian(rng) * c.spread
      const dLat = gaussian(rng) * c.spread * 0.8
      const lng = clamp(c.lng + dLng, BOUNDS.minLng, BOUNDS.maxLng)
      const lat = clamp(c.lat + dLat, BOUNDS.minLat, BOUNDS.maxLat)
      // Weight falls off with distance from the cluster core.
      const d2 = (dLng / c.spread) ** 2 + (dLat / (c.spread * 0.8)) ** 2
      const weight = Math.max(20, Math.round(c.peak * Math.exp(-d2 / 2) * (0.6 + 0.8 * rng())))
      points.push({ lng, lat, weight, weightByHour: hourlyProfile(weight, rng) })
    }
  }

  // Low-weight background scatter across the whole city.
  for (let i = 0; i < BACKGROUND_COUNT; i++) {
    const lng = BOUNDS.minLng + rng() * (BOUNDS.maxLng - BOUNDS.minLng)
    const lat = BOUNDS.minLat + rng() * (BOUNDS.maxLat - BOUNDS.minLat)
    const weight = Math.round(30 + rng() * 600)
    points.push({ lng, lat, weight, weightByHour: hourlyProfile(weight, rng) })
  }

  return points
}

export const saenghwalIdongSource: DataSource = {
  meta: {
    id: 'saenghwal-idong',
    label: 'Saenghwal-idong (population OD)',
    description: 'Where Seoul moves between home and work',
    unit: 'trips',
    accent: '#ff7eb6', // IBM Magenta 40
  },
  load: async () => generate(),
}
