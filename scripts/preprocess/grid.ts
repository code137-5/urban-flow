import type { Bounds, GeoPoint } from '../../src/data/types.ts'

// Meters per degree of latitude — same constant the frontend KDE uses
// (src/data/heightmap.ts) so preprocessing and rendering share one geodesy.
const M_PER_DEG_LAT = 111320

/** A raw observation before gridding: a value (and optional hourly split) at a point. */
export interface RawCell {
  lng: number
  lat: number
  value: number
  /** Optional per-hour breakdown (length 24) for the time-of-day scrubber. */
  valueByHour?: number[]
}

/** 'sum' for counts (population, rentals); 'mean' for intensive fields (elevation, density). */
export type Aggregation = 'sum' | 'mean'

export interface GridOptions {
  bounds: Bounds
  /** Target grid cell size in meters (e.g. 500). */
  cellMeters: number
  aggregation?: Aggregation
}

/**
 * Bin raw observations onto a regular grid over `bounds` at `cellMeters`
 * resolution, then emit one {@link GeoPoint} per non-empty cell at its centroid.
 *
 * This is the single funnel every grid/administrative dataset flows through:
 * the cell centroid becomes a weighted GeoPoint, which the frontend's existing
 * KDE → contour pipeline renders unchanged. `sum` accumulates counts; `mean`
 * averages intensive quantities (elevation, floor-area density).
 */
export function aggregateToGrid(
  cells: RawCell[],
  { bounds, cellMeters, aggregation = 'sum' }: GridOptions,
): GeoPoint[] {
  const [minLng, minLat, maxLng, maxLat] = bounds
  const centerLat = (minLat + maxLat) / 2
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((centerLat * Math.PI) / 180)

  const spanLng = maxLng - minLng
  const spanLat = maxLat - minLat
  const cols = Math.max(1, Math.round((spanLng * mPerDegLng) / cellMeters))
  const rows = Math.max(1, Math.round((spanLat * M_PER_DEG_LAT) / cellMeters))

  const sums = new Float64Array(cols * rows)
  const counts = new Int32Array(cols * rows)
  // Hourly accumulators are allocated lazily — only datasets that carry
  // valueByHour pay for them.
  const hourSums = new Map<number, Float64Array>()

  for (const cell of cells) {
    if (cell.lng < minLng || cell.lng >= maxLng || cell.lat < minLat || cell.lat >= maxLat) {
      continue
    }
    const col = Math.min(cols - 1, Math.floor(((cell.lng - minLng) / spanLng) * cols))
    const row = Math.min(rows - 1, Math.floor(((cell.lat - minLat) / spanLat) * rows))
    const idx = row * cols + col
    sums[idx] += cell.value
    counts[idx] += 1
    if (cell.valueByHour) {
      let acc = hourSums.get(idx)
      if (!acc) {
        acc = new Float64Array(24)
        hourSums.set(idx, acc)
      }
      for (let h = 0; h < 24; h++) acc[h] += cell.valueByHour[h] ?? 0
    }
  }

  const points: GeoPoint[] = []
  for (let idx = 0; idx < sums.length; idx++) {
    const n = counts[idx]
    if (n === 0) continue
    const row = Math.floor(idx / cols)
    const col = idx - row * cols
    const lng = minLng + ((col + 0.5) / cols) * spanLng
    const lat = minLat + ((row + 0.5) / rows) * spanLat
    const divisor = aggregation === 'mean' ? n : 1
    const point: GeoPoint = { lng, lat, weight: sums[idx] / divisor }
    const acc = hourSums.get(idx)
    if (acc) {
      point.weightByHour = Array.from(acc, (v) => v / divisor)
    }
    points.push(point)
  }
  return points
}
