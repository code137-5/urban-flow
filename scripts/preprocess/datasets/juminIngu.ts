import type { DatasetJob } from '../job.ts'
import { readRawCsv } from '../raw.ts'

/**
 * 주민등록인구 (registered resident population) — headcount by home address,
 * summed per cell. Static (no hourly): where people are registered, not where
 * they currently are. Contrast with saenghwal-ingu's daytime/nighttime shift.
 */
export const juminInguJob: DatasetJob = {
  id: 'jumin-ingu',
  cellMeters: 500,
  aggregation: 'sum',
  toCells: () => readRawCsv('jumin-ingu'),
}
