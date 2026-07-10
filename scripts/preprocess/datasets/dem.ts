import type { DatasetJob } from '../job.ts'
import { readRawCsv } from '../raw.ts'

/**
 * DEM — actual terrain elevation (표고, meters). `value` is elevation; averaged
 * per cell so overlapping samples smooth rather than pile up. Fed through the
 * same KDE as the density datasets: on a regular grid, weight=elevation yields a
 * smoothed elevation surface, which reads as real Seoul relief in contour form.
 */
export const demJob: DatasetJob = {
  id: 'dem',
  cellMeters: 500,
  aggregation: 'mean',
  toCells: () => readRawCsv('dem'),
}
