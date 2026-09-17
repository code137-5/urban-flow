import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { FeatureCollection, Point } from 'geojson'
import type { Bounds } from '../../src/data/types.ts'
import { M_PER_DEG_LAT, gridDims } from './grid.ts'
import type { RawCell } from './grid.ts'

/** Sensors averaged per cell centre. S-DoT sites sit ~330 m apart (median; up to
 * ~4 km across the mountains, the airport and the river margins), so a dozen
 * bridges the holes in the network without pulling every cell towards the
 * citywide mean. */
const NEIGHBOURS = 12
/**
 * Softening ε in the inverse-distance weight, w = 1 / (d² + ε²). Plain 1/d²
 * diverges at the sensor itself, so a cell centre that happens to land on a site
 * would take that one reading verbatim while its neighbour a cell away is a
 * blend — a speckle of single-sensor spikes the KDE then smooths into bumps.
 * ε = half a cell makes the weight flat within a cell and 1/d² beyond it.
 */
const EPSILON_METERS = 250

/** data/raw/environment_2023_yearly_median_<variable>.geojson (S-DoT, 2023). */
export function sensorsPath(variable: string): string {
  return fileURLToPath(
    new URL(`../../data/raw/environment_2023_yearly_median_${variable}.geojson`, import.meta.url),
  )
}

/**
 * Resample a scattered point GeoJSON of sensor readings (`valueProp` on each
 * feature) onto a regular `cellMeters` grid over `bounds`, one RawCell per cell.
 *
 * Why a grid: the frontend KDE is an un-normalized Gaussian *sum*, so feeding it
 * the sensor points directly would render where the sensors are — dense in the
 * city centre — not how warm or loud the city is. On a complete regular grid the
 * sum has the same number of samples everywhere and reads as the field again,
 * and the job's 'mean' aggregation becomes a pass-through.
 *
 * Per cell centre: an inverse-distance-weighted average of the {@link NEIGHBOURS}
 * nearest sensors, softened by {@link EPSILON_METERS}. It is defined everywhere —
 * network holes and the padded rim outside Seoul simply extrapolate from whatever
 * sensors are nearest, which is what the KDE needs at the edge (see
 * DatasetJob.padMeters). Values stay raw physical units (°C / dB / %RH); the
 * frontend treats weight <= 0 as a missing sample, so nothing is re-based here.
 */
export function sensorsToCells(
  path: string,
  valueProp: string,
  bounds: Bounds,
  cellMeters: number,
): RawCell[] {
  const fc = JSON.parse(readFileSync(path, 'utf8')) as FeatureCollection<
    Point,
    Record<string, unknown>
  >

  const [minLng, minLat] = bounds
  const { cols, rows, mPerDegLng, spanLng, spanLat } = gridDims(bounds, cellMeters)

  // Sensors in metres relative to the bounds origin — the same frame as the
  // cell centres below, so a distance is a plain hypot.
  const xs: number[] = []
  const ys: number[] = []
  const values: number[] = []
  let skipped = 0
  for (const feature of fc.features) {
    const value = feature.properties?.[valueProp]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      skipped++
      continue
    }
    const [lng, lat] = feature.geometry.coordinates
    xs.push((lng - minLng) * mPerDegLng)
    ys.push((lat - minLat) * M_PER_DEG_LAT)
    values.push(value)
  }
  if (values.length === 0) throw new Error(`no finite ${valueProp} values in ${path}`)

  const k = Math.min(NEIGHBOURS, values.length)
  const eps2 = EPSILON_METERS * EPSILON_METERS
  // Running k-nearest, kept sorted by squared distance (k is tiny: insertion sort
  // beats sorting all ~900 sensors per cell).
  const nearD2 = new Float64Array(k)
  const nearValue = new Float64Array(k)

  const cells: RawCell[] = []
  for (let r = 0; r < rows; r++) {
    const lat = minLat + ((r + 0.5) / rows) * spanLat
    const y = (lat - minLat) * M_PER_DEG_LAT
    for (let c = 0; c < cols; c++) {
      const lng = minLng + ((c + 0.5) / cols) * spanLng
      const x = (lng - minLng) * mPerDegLng

      let found = 0
      for (let i = 0; i < values.length; i++) {
        const dx = xs[i] - x
        const dy = ys[i] - y
        const d2 = dx * dx + dy * dy
        if (found === k && d2 >= nearD2[k - 1]) continue
        let j = found < k ? found++ : k - 1
        for (; j > 0 && nearD2[j - 1] > d2; j--) {
          nearD2[j] = nearD2[j - 1]
          nearValue[j] = nearValue[j - 1]
        }
        nearD2[j] = d2
        nearValue[j] = values[i]
      }

      let weightSum = 0
      let valueSum = 0
      for (let j = 0; j < found; j++) {
        const w = 1 / (nearD2[j] + eps2)
        weightSum += w
        valueSum += w * nearValue[j]
      }
      cells.push({ lng, lat, value: valueSum / weightSum })
    }
  }
  console.log(
    `  sensors: ${values.length} sites (${skipped} skipped), ${cols}×${rows} grid, k=${k}`,
  )
  return cells
}
