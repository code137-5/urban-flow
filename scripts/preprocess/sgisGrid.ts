import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { FeatureCollection, Polygon } from 'geojson'
import { SEOUL_BOUNDS } from '../../src/data/bounds.ts'
import type { RawCell } from './grid.ts'
import { utmKToWgs84 } from './proj.ts'

/** data/raw/seoul_grid100m_<name>_2024.geojson — 통계청 SGIS 100 m 격자통계, 2024. */
export function sgisGridPath(name: string): string {
  return fileURLToPath(new URL(`../../data/raw/seoul_grid100m_${name}_2024.geojson`, import.meta.url))
}

/** Source cell edge in metres; every feature must be exactly this square. */
const CELL_METERS = 100

/**
 * Read an SGIS 100 m grid (population, companies, …) into one RawCell per
 * non-empty square, `valueProp` as the value.
 *
 * Unlike the sensor fields these are *counts*: a weighted KDE sum over cell
 * centres IS the field, and an absent or zero cell simply adds nothing. So
 * there is no interpolation, no complete-grid fill and no padding — the cells
 * go straight to aggregateToGrid('sum') (see datasets/population.ts).
 *
 * The files are EPSG:5179 (UTM-K metres), the first non-WGS84 raw inputs in
 * the repo; centres are reprojected with proj4. Squares are axis-aligned on
 * exact 100 m multiples, so the centre is the min corner + 50 m — no centroid
 * math.
 */
export function readSgisGrid(path: string, valueProp: string): RawCell[] {
  const fc = JSON.parse(readFileSync(path, 'utf8')) as FeatureCollection<
    Polygon,
    Record<string, unknown> & { grid_cd?: string }
  >

  const [bMinLng, bMinLat, bMaxLng, bMaxLat] = SEOUL_BOUNDS
  const cells: RawCell[] = []
  let total = 0
  let skipped = 0
  let outside = 0
  let outsideTotal = 0
  let minLng = Infinity
  let minLat = Infinity
  let maxLng = -Infinity
  let maxLat = -Infinity

  for (const feature of fc.features) {
    const value = feature.properties?.[valueProp]
    if (feature.geometry?.type !== 'Polygon') {
      throw new Error(`${path}: non-Polygon feature ${feature.properties?.grid_cd}`)
    }
    const ring = feature.geometry.coordinates[0]
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const [x, y] of ring) {
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
    if (x1 - x0 !== CELL_METERS || y1 - y0 !== CELL_METERS) {
      throw new Error(
        `${path}: ${feature.properties?.grid_cd} is ${x1 - x0}x${y1 - y0} m, expected ${CELL_METERS} m square`,
      )
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      // Zero/absent counts contribute nothing to the sum — drop them here to
      // keep the output small rather than ship weight-0 points.
      skipped++
      continue
    }
    const [lng, lat] = utmKToWgs84(x0 + CELL_METERS / 2, y0 + CELL_METERS / 2)
    if (lng < minLng) minLng = lng
    if (lng > maxLng) maxLng = lng
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
    total += value
    if (lng < bMinLng || lng >= bMaxLng || lat < bMinLat || lat >= bMaxLat) {
      // aggregateToGrid will drop these silently; count them so a projection
      // mistake can't make the dataset quietly vanish. The genuine overshoot is
      // a few 강일동 squares ~300 m past the eastern edge of SEOUL_BOUNDS.
      outside++
      outsideTotal += value
    }
    cells.push({ lng, lat, value })
  }

  const extent = `[${minLng.toFixed(4)}, ${minLat.toFixed(4)}, ${maxLng.toFixed(4)}, ${maxLat.toFixed(4)}]`
  if (outsideTotal > total * 0.02) {
    throw new Error(
      `${path}: ${outside} squares (${outsideTotal.toLocaleString()} of ${valueProp}) fall outside SEOUL_BOUNDS, extent ${extent} — projection wrong?`,
    )
  }
  console.log(
    `${valueProp}: ${fc.features.length} squares, ${cells.length} non-empty (${skipped} empty), ` +
      `total ${total.toLocaleString()}, extent ${extent}` +
      (outside > 0
        ? `; ${outside} squares / ${outsideTotal.toLocaleString()} outside SEOUL_BOUNDS (dropped)`
        : ''),
  )
  return cells
}
