import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { FeatureCollection, Polygon } from 'geojson'
import { SEOUL_BOUNDS } from '../../src/data/bounds.ts'
import type { RawCell } from './grid.ts'
import { utmKToWgs84 } from './proj.ts'

/** data/raw/seoul_grid100m_pop_2024.geojson — SGIS 100 m grid population, 2024. */
const GRID_PATH = fileURLToPath(new URL('../../data/raw/seoul_grid100m_pop_2024.geojson', import.meta.url))

/** Source cell edge in metres; every feature must be exactly this square. */
const CELL_METERS = 100

/**
 * Read the SGIS 100 m population grid into one RawCell per populated square.
 *
 * Unlike the sensor fields this is a *count*: a weighted KDE sum over cell
 * centres IS the population field, and an absent or zero cell simply adds no
 * people. So there is no interpolation, no complete-grid fill and no padding —
 * the cells go straight to aggregateToGrid('sum') (see datasets/population.ts).
 *
 * The file is EPSG:5179 (UTM-K metres), the first non-WGS84 raw input in the
 * repo; centres are reprojected with proj4. Squares are axis-aligned on exact
 * 100 m multiples, so the centre is the min corner + 50 m — no centroid math.
 */
export function readPopulationGrid(): RawCell[] {
  const fc = JSON.parse(readFileSync(GRID_PATH, 'utf8')) as FeatureCollection<
    Polygon,
    { grid_cd?: string; pop_total?: number }
  >

  const [bMinLng, bMinLat, bMaxLng, bMaxLat] = SEOUL_BOUNDS
  const cells: RawCell[] = []
  let total = 0
  let skipped = 0
  let outside = 0
  let outsidePop = 0
  let minLng = Infinity
  let minLat = Infinity
  let maxLng = -Infinity
  let maxLat = -Infinity

  for (const feature of fc.features) {
    const pop = feature.properties?.pop_total
    if (feature.geometry?.type !== 'Polygon') {
      throw new Error(`population grid: non-Polygon feature ${feature.properties?.grid_cd}`)
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
        `population grid: ${feature.properties?.grid_cd} is ${x1 - x0}x${y1 - y0} m, expected ${CELL_METERS} m square`,
      )
    }
    if (typeof pop !== 'number' || !Number.isFinite(pop) || pop <= 0) {
      // Zero/absent population contributes nothing to the sum — drop it here to
      // keep the output small rather than ship weight-0 points.
      skipped++
      continue
    }
    const [lng, lat] = utmKToWgs84(x0 + CELL_METERS / 2, y0 + CELL_METERS / 2)
    if (lng < minLng) minLng = lng
    if (lng > maxLng) maxLng = lng
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
    total += pop
    if (lng < bMinLng || lng >= bMaxLng || lat < bMinLat || lat >= bMaxLat) {
      // aggregateToGrid will drop these silently; count them so a projection
      // mistake can't make the dataset quietly vanish. The genuine overshoot is
      // a few 강일동 squares ~300 m past the eastern edge of SEOUL_BOUNDS.
      outside++
      outsidePop += pop
    }
    cells.push({ lng, lat, value: pop })
  }

  const extent = `[${minLng.toFixed(4)}, ${minLat.toFixed(4)}, ${maxLng.toFixed(4)}, ${maxLat.toFixed(4)}]`
  if (outsidePop > total * 0.02) {
    throw new Error(
      `population grid: ${outside} squares (${outsidePop.toLocaleString()} people) fall outside SEOUL_BOUNDS, extent ${extent} — projection wrong?`,
    )
  }
  console.log(
    `population grid: ${fc.features.length} squares, ${cells.length} populated (${skipped} empty), ` +
      `total ${total.toLocaleString()} people, extent ${extent}` +
      (outside > 0 ? `; ${outside} squares / ${outsidePop.toLocaleString()} people outside SEOUL_BOUNDS (dropped)` : ''),
  )
  return cells
}
