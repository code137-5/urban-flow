import type { DatasetJob } from '../job.ts'
import { readSgisGrid, sgisGridPath } from '../sgisGrid.ts'

/**
 * 종사자 (workers by workplace) — 통계청 SGIS 2024 100 m grid, summed per cell.
 * The daytime counterpart of population.ts: where people work rather than
 * where they are registered. Heaviest tail of the three SGIS grids (median 45,
 * max ~16,500 in a single office-tower square).
 */
export const employeesJob: DatasetJob = {
  id: 'employees',
  cellMeters: 250,
  aggregation: 'sum',
  toCells: () => readSgisGrid(sgisGridPath('employees'), 'employee_cnt'),
}
