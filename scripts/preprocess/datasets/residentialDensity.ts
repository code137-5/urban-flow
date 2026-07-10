import type { DatasetJob } from '../job.ts'
import { readRawCsv } from '../raw.ts'

/**
 * 주거면적 밀도 (residential floor-area density) — floor area zoned/used for
 * housing per unit ground area, averaged per cell. Peaks over apartment belts,
 * dips over CBDs where commercial use dominates.
 */
export const residentialDensityJob: DatasetJob = {
  id: 'residential-density',
  cellMeters: 500,
  aggregation: 'mean',
  toCells: () => readRawCsv('residential-density'),
}
