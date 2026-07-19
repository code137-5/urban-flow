import type { DatasetJob } from '../job.ts'
import { readRawCsv } from '../raw.ts'

/**
 * 상업면적 밀도 (commercial floor-area density) — floor area in commercial use
 * per unit ground area, averaged per cell. Spikes over CBDs and retail cores
 * (Gangnam, Jung-gu), the near-inverse of residential density.
 */
export const commercialDensityJob: DatasetJob = {
  id: 'commercial-density',
  cellMeters: 500,
  aggregation: 'mean',
  toCells: () => readRawCsv('commercial-density'),
}
