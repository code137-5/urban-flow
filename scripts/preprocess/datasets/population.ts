import type { DatasetJob } from '../job.ts'
import { readSgisGrid, sgisGridPath } from '../sgisGrid.ts'

/**
 * 인구 (resident population) — 통계청 SGIS 2024 100 m grid, summed per cell.
 * A headcount, not a measured field: 'sum' over the 100 m squares is the
 * population of each 250 m cell, and a cell nobody lives in (mountain, river)
 * is genuinely zero. So no IDW resampling, no complete-grid fill and no
 * padMeters — the KDE floor (field.ts floorToLowest) is already ~0 from the
 * empty areas inside Seoul, and the KDE sum over cell centres is the field.
 */
export const populationJob: DatasetJob = {
  id: 'population',
  cellMeters: 250,
  aggregation: 'sum',
  toCells: () => readSgisGrid(sgisGridPath('pop'), 'pop_total'),
}
