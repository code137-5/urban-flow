import type { DatasetJob } from '../job.ts'
import { readRawCsv } from '../raw.ts'

/**
 * 생활인구 (de-facto / living population) — headcount present in a cell, summed.
 * Carries an hourly breakdown (h0..h23): the living population swells downtown by
 * day and in residential districts at night, so this dataset drives the
 * time-of-day scrubber via weightByHour.
 */
export const saenghwalInguJob: DatasetJob = {
  id: 'saenghwal-ingu',
  cellMeters: 500,
  aggregation: 'sum',
  toCells: () => readRawCsv('saenghwal-ingu'),
}
