import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { FeatureCollection, LineString } from 'geojson'
import type { Bounds } from '../../src/data/types.ts'
import { M_PER_DEG_LAT, gridDims } from './grid.ts'
import type { RawCell } from './grid.ts'

/**
 * The source DEM was masked on a 0.025° tile grid (outside the mask = 0), so every
 * contour level has straight runs along those grid lines. They are mask edges,
 * not terrain — any vertex this close to a 0.025° multiple (lon or lat) is dropped.
 */
const SEAM_STEP_DEG = 0.025
const SEAM_TOL_DEG = 2e-4

/** Elevation contours are at 20 m steps; nothing below 20 m exists in the file. */
const LOWEST_LEVEL = 20
/** Search radius for neighbouring vertices, in cells. */
const SEARCH_CELLS = 4
/** Beyond this the second contour is too far to interpolate against. */
const MAX_INTERP_METERS = 1500
/** Nearest line is the 20 m one and further than this → treat as river plain. */
const LOWLAND_DIST_METERS = 300
const LOWLAND_ELEV = 8
const NO_CONTOUR_ELEV = 5

export const CONTOURS_PATH = fileURLToPath(
  new URL('../../data/raw/contours.geojson', import.meta.url),
)

type Vertex = [xMeters: number, yMeters: number, elev: number]

function onSeam(deg: number): boolean {
  const q = deg / SEAM_STEP_DEG
  return Math.abs(q - Math.round(q)) * SEAM_STEP_DEG < SEAM_TOL_DEG
}

/**
 * Rasterize an elevation-contour GeoJSON (LineStrings with an `elev` property,
 * meters) onto a regular `cellMeters` grid over `bounds`, one RawCell per cell.
 *
 * Why a grid: the frontend KDE is an un-normalized Gaussian *sum*, so it tracks
 * sample density rather than value. It only reads as elevation when samples sit
 * on a regular grid — the same shape `aggregateToGrid` produces, so the job's
 * 'mean' aggregation becomes a pass-through.
 *
 * Per cell centre: take the nearest vertex A and the nearest vertex B on a
 * *different* level, and interpolate linearly by distance. Cells that only see
 * the lowest level (the Han river plain has no contour at all) become lowland.
 */
export function contoursToCells(
  path: string,
  bounds: Bounds,
  cellMeters: number,
): RawCell[] {
  const fc = JSON.parse(readFileSync(path, 'utf8')) as FeatureCollection<
    LineString,
    { elev: number }
  >

  const [minLng, minLat] = bounds
  // Same dims as aggregateToGrid so the cell centres line up 1:1.
  const { cols, rows, mPerDegLng, spanLng, spanLat } = gridDims(bounds, cellMeters)

  // Vertices in metres relative to the bounds origin, bucketed per grid cell.
  const buckets = new Map<number, Vertex[]>()
  let kept = 0
  let dropped = 0
  for (const feature of fc.features) {
    const elev = feature.properties.elev
    for (const [lng, lat] of feature.geometry.coordinates) {
      if (onSeam(lng) || onSeam(lat)) {
        dropped++
        continue
      }
      const v: Vertex = [(lng - minLng) * mPerDegLng, (lat - minLat) * M_PER_DEG_LAT, elev]
      const key = Math.floor(v[1] / cellMeters) * cols + Math.floor(v[0] / cellMeters)
      let arr = buckets.get(key)
      if (!arr) {
        arr = []
        buckets.set(key, arr)
      }
      arr.push(v)
      kept++
    }
  }
  console.log(`  contours: ${kept} vertices (${dropped} tile-seam vertices dropped)`)

  const cells: RawCell[] = []
  let lowland = 0
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = (c + 0.5) * cellMeters
      const y = (r + 0.5) * cellMeters

      let nearest: { d: number; e: number } | null = null
      let other: { d: number; e: number } | null = null
      // Two passes over the neighbourhood: nearest of any level, then nearest of
      // a different level (needs the first result).
      for (let pass = 0; pass < 2; pass++) {
        if (pass === 1 && !nearest) break
        for (let dr = -SEARCH_CELLS; dr <= SEARCH_CELLS; dr++) {
          const rr = r + dr
          if (rr < 0 || rr >= rows) continue
          for (let dc = -SEARCH_CELLS; dc <= SEARCH_CELLS; dc++) {
            const cc = c + dc
            if (cc < 0 || cc >= cols) continue
            const arr = buckets.get(rr * cols + cc)
            if (!arr) continue
            for (const v of arr) {
              if (pass === 1 && v[2] === nearest!.e) continue
              const d = Math.hypot(v[0] - x, v[1] - y)
              if (pass === 0) {
                if (!nearest || d < nearest.d) nearest = { d, e: v[2] }
              } else if (!other || d < other.d) {
                other = { d, e: v[2] }
              }
            }
          }
        }
      }

      let value: number
      if (!nearest) {
        value = NO_CONTOUR_ELEV
        lowland++
      } else if (!other || other.d > MAX_INTERP_METERS) {
        const isPlain = nearest.e === LOWEST_LEVEL && nearest.d > LOWLAND_DIST_METERS
        value = isPlain ? LOWLAND_ELEV : nearest.e
        if (isPlain) lowland++
      } else {
        const t = nearest.d / (nearest.d + other.d)
        value = nearest.e * (1 - t) + other.e * t
      }

      cells.push({
        lng: minLng + ((c + 0.5) / cols) * spanLng,
        lat: minLat + ((r + 0.5) / rows) * spanLat,
        value,
      })
    }
  }
  console.log(`  contours: ${cols}×${rows} grid, ${lowland} lowland cells`)
  return cells
}
