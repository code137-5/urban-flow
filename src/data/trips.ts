import type { Bounds, Heightmap } from './types'

/**
 * Trip model for the particle layer.
 *
 * Every particle plays one `Trip` — a straight line from `origin` to `destination`
 * taking `durationSec` playback seconds — then asks its `TripSource` for the next
 * one. The layer never sees where trips come from: `randomTripSource` below
 * synthesizes them; a future `apiTripSource(url)` would `fetch` OD rows into the
 * same shape (see the stub note at the bottom of this file).
 */

/** One origin→destination movement. Coordinates are WGS84 [lng, lat]. */
export interface Trip {
  origin: [number, number]
  destination: [number, number]
  /** Playback seconds at timeScale = 1. */
  durationSec: number
}

/**
 * Pluggable trip supplier — the API seam. The layer's TripQueue calls this in
 * batches (~200 at a time) whenever its prefetch pool runs low, so an
 * implementation must be safe to call repeatedly. It may return fewer than
 * `count` (or none) when it has nothing more to give.
 */
export interface TripSource {
  next(count: number): Promise<Trip[]>
}

/** Deterministic RNG — reproducible trips make Playwright screenshots comparable. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Same constants the flow field uses (flowField.ts) so trip durations and the
// particle UV scale agree on what a meter is.
const M_PER_DEG_LAT = 110_540
const M_PER_DEG_LNG_EQUATOR = 111_320

/** Approximate ground distance in meters between two lng/lat points (Seoul scale). */
export function distanceMeters(a: [number, number], b: [number, number]): number {
  const midLat = ((a[1] + b[1]) / 2) * (Math.PI / 180)
  const dx = (b[0] - a[0]) * M_PER_DEG_LNG_EQUATOR * Math.cos(midLat)
  const dy = (b[1] - a[1]) * M_PER_DEG_LAT
  return Math.hypot(dx, dy)
}

/** lng/lat → heightmap UV in [0,1]² over `bounds` (inverse of particle.vs.glsl). */
export function lngLatToUv(bounds: Bounds): (lng: number, lat: number) => [number, number] {
  const [minLng, minLat, maxLng, maxLat] = bounds
  const spanLng = maxLng - minLng
  const spanLat = maxLat - minLat
  return (lng, lat) => [(lng - minLng) / spanLng, (lat - minLat) / spanLat]
}

export interface RandomTripOptions {
  seed?: number
  /** Poster-scale speed range in m/s; duration = distance / speed. Not physical. */
  speedMps?: [number, number]
  /** Reject origin/destination pairs closer than this — no near-stationary trips. */
  minDistanceMeters?: number
}

/**
 * Infinite, deterministic random trips inside the Seoul mask. Endpoints are
 * rejection-sampled from the heightmap's unmasked cells (a point anywhere inside
 * the cell, cell-edge anchored like the old particle seeder), so the random
 * source respects the same boundary the terrain draws.
 */
export function randomTripSource(heightmap: Heightmap, opts: RandomTripOptions = {}): TripSource {
  const { seed = 0x5e0e1, speedMps = [500, 900], minDistanceMeters = 1500 } = opts
  const { data, width: W, height: H, bounds } = heightmap
  const [minLng, minLat, maxLng, maxLat] = bounds
  const spanLng = maxLng - minLng
  const spanLat = maxLat - minLat
  const rand = mulberry32(seed)

  const samplePoint = (): [number, number] => {
    let i = 0
    let j = 0
    let tries = 0
    do {
      i = Math.floor(rand() * W)
      j = Math.floor(rand() * H)
    } while (data[j * W + i] < 0 && ++tries < 100)
    return [minLng + ((i + rand()) / W) * spanLng, minLat + ((j + rand()) / H) * spanLat]
  }

  const makeTrip = (): Trip => {
    const origin = samplePoint()
    let destination = samplePoint()
    let tries = 0
    while (distanceMeters(origin, destination) < minDistanceMeters && ++tries < 20) {
      destination = samplePoint()
    }
    const speed = speedMps[0] + rand() * (speedMps[1] - speedMps[0])
    return { origin, destination, durationSec: distanceMeters(origin, destination) / speed }
  }

  return {
    next: (count) => Promise.resolve(Array.from({ length: count }, makeTrip)),
  }
}

// Future: `apiTripSource(url)` — fetch(`${url}?count=${count}`) returning
// `{ origin: [lng, lat], destination: [lng, lat], durationSec }[]`, mapped onto
// `Trip`. Nothing in the layer changes; TerrainPanel just receives it as
// `tripSource` instead of the random one.
