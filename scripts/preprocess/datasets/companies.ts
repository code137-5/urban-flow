import type { DatasetJob } from '../job.ts'
import { readSgisGrid, sgisGridPath } from '../sgisGrid.ts'

/**
 * 사업체 (business establishments) — 통계청 SGIS 2024 100 m grid, summed per
 * cell. Same count-field treatment as population.ts. Far heavier tail than
 * population (median 16, max ~4,600 in the CBD office blocks); the runtime
 * KDE's log1p weighting keeps Gangnam/Jongno from flattening everything else.
 */
export const companiesJob: DatasetJob = {
  id: 'companies',
  cellMeters: 250,
  aggregation: 'sum',
  toCells: () => readSgisGrid(sgisGridPath('companies'), 'company_cnt'),
}
