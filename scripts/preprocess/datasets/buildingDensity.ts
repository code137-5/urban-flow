import type { DatasetJob } from '../job.ts'
import { readRawCsv } from '../raw.ts'

/**
 * 건축연면적 밀도 (gross floor-area density) — total building floor area per unit
 * ground area (an intensive ratio), so averaged per cell. High over dense
 * built-up cores, low over parks/rivers. `value` is the density figure.
 */
export const buildingDensityJob: DatasetJob = {
  id: 'building-density',
  cellMeters: 500,
  aggregation: 'mean',
  toCells: () => readRawCsv('building-density'),
}
