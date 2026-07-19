import type { DataSource, GeoPoint, HourlyWeights } from '../types'

/**
 * Subway (지하철 승하차) — station boarding/alighting counts.
 *
 * Synthetic mock data, generated deterministically in code (seeded RNG):
 * ~120 station-like points arranged along subway-line-like arcs — a Line-2-ish
 * loop around the city center, a Gangnam corridor, and a central (Jongno)
 * axis — plus a few outlying stations. Rush-hour peaks at h8/h18 mirror the
 * ttareungi mock's hourly shape. A real adapter would map the open
 * 승하차 인원 dataset per station the same way.
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

const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi)

/**
 * Commute-shaped hourly profile with sharp rush-hour peaks (h8, h18) — subway
 * ridership is peakier than bike rentals. Distributes `weight` across 24 hours.
 */
function hourlyProfile(weight: number, rng: () => number): HourlyWeights {
  const bump = (h: number, center: number, sigma: number) =>
    Math.exp(-((h - center) ** 2) / (2 * sigma * sigma))
  const raw: number[] = []
  for (let h = 0; h < 24; h++) {
    const shape = 0.03 + 1.2 * bump(h, 8, 1.2) + bump(h, 18, 1.5) + 0.2 * bump(h, 13, 3.0)
    raw.push(shape * (0.9 + 0.2 * rng()))
  }
  const sum = raw.reduce((s, x) => s + x, 0)
  return raw.map((x) => Math.round((x / sum) * weight))
}

function makePoint(lng: number, lat: number, weight: number, rng: () => number): GeoPoint {
  const w = Math.max(50, Math.round(weight))
  return {
    lng: clamp(lng, BOUNDS.minLng, BOUNDS.maxLng),
    lat: clamp(lat, BOUNDS.minLat, BOUNDS.maxLat),
    weight: w,
    weightByHour: hourlyProfile(w, rng),
  }
}

const jitter = (rng: () => number, amt: number) => (rng() - 0.5) * 2 * amt

function generate(): GeoPoint[] {
  const rng = mulberry32(0x50b0a1) // fixed seed — deterministic output
  const points: GeoPoint[] = []

  // Line-2-ish loop: an ellipse around the city center. Weight peaks at the
  // south-east (Gangnam) and north-west (City Hall / Euljiro) sides.
  const LOOP = { lng: 127.0, lat: 37.53, rLng: 0.085, rLat: 0.045, stations: 44 }
  for (let i = 0; i < LOOP.stations; i++) {
    const t = (i / LOOP.stations) * 2 * Math.PI
    const lng = LOOP.lng + Math.cos(t) * LOOP.rLng + jitter(rng, 0.004)
    const lat = LOOP.lat + Math.sin(t) * LOOP.rLat + jitter(rng, 0.003)
    // Two hot arcs on the loop: t≈-π/4 (Gangnam) and t≈3π/4 (City Hall).
    const hot =
      Math.exp(-((Math.cos(t + Math.PI / 4) - 1) ** 2) * 2) +
      0.8 * Math.exp(-((Math.cos(t - (3 * Math.PI) / 4) - 1) ** 2) * 2)
    points.push(makePoint(lng, lat, (4000 + 22000 * hot) * (0.7 + 0.6 * rng()), rng))
  }

  // Gangnam corridor (Line-2/Sinbundang-ish): dense east–west run of big stations.
  const CORRIDOR = { stations: 22 }
  for (let i = 0; i < CORRIDOR.stations; i++) {
    const f = i / (CORRIDOR.stations - 1)
    const lng = 127.02 + f * (127.1 - 127.02) + jitter(rng, 0.003)
    const lat = 37.5 + (f - 0.5) * -0.015 + jitter(rng, 0.004) // 37.49–37.51 band
    const core = Math.exp(-((f - 0.15) ** 2) / 0.08) // hottest near Gangnam Stn
    points.push(makePoint(lng, lat, (6000 + 20000 * core) * (0.7 + 0.6 * rng()), rng))
  }

  // Central axis (Line-1/5-ish through Jongno): west–east 126.97→127.0, lat 37.55–37.58.
  const AXIS = { stations: 18 }
  for (let i = 0; i < AXIS.stations; i++) {
    const f = i / (AXIS.stations - 1)
    const lng = 126.97 + f * (127.0 - 126.97) + jitter(rng, 0.002)
    const lat = 37.55 + f * (37.58 - 37.55) + jitter(rng, 0.003)
    points.push(makePoint(lng, lat, (8000 + 12000 * Math.exp(-((f - 0.4) ** 2) / 0.1)) * (0.7 + 0.6 * rng()), rng))
  }

  // Two radial spokes reaching out of the loop (NE and SW), fading outward.
  const SPOKES: Array<{ fromLng: number; fromLat: number; toLng: number; toLat: number; stations: number }> = [
    { fromLng: 127.06, fromLat: 37.56, toLng: 127.16, toLat: 37.66, stations: 12 }, // NE
    { fromLng: 126.94, fromLat: 37.5, toLng: 126.82, toLat: 37.45, stations: 12 }, // SW
  ]
  for (const s of SPOKES) {
    for (let i = 0; i < s.stations; i++) {
      const f = i / (s.stations - 1)
      const lng = s.fromLng + f * (s.toLng - s.fromLng) + jitter(rng, 0.004)
      const lat = s.fromLat + f * (s.toLat - s.fromLat) + jitter(rng, 0.004)
      points.push(makePoint(lng, lat, (9000 - 7500 * f) * (0.7 + 0.6 * rng()), rng))
    }
  }

  // A handful of isolated outer stations.
  for (let i = 0; i < 10; i++) {
    const lng = BOUNDS.minLng + rng() * (BOUNDS.maxLng - BOUNDS.minLng)
    const lat = BOUNDS.minLat + rng() * (BOUNDS.maxLat - BOUNDS.minLat)
    points.push(makePoint(lng, lat, 300 + rng() * 1500, rng))
  }

  return points
}

export const subwaySource: DataSource = {
  meta: {
    id: 'subway',
    label: 'Subway (승하차)',
    description: 'Station ridership along the rail network',
    unit: 'riders',
    accent: '#3ddbd9', // IBM Teal 30
  },
  load: async () => generate(),
}
