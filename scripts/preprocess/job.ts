import type { Aggregation, RawCell } from './grid.ts'

/**
 * One preprocessing job = one dataset. `toCells` reads data/raw/<id>.* and maps
 * the raw domain fields into generic RawCells (dataset-specific mapping lives in
 * the adapter). run.ts then grids, clips to Seoul, and writes public/data/<id>.json.
 */
export interface DatasetJob {
  /** Must match the DatasetId used in src/data/sources. */
  id: string
  /** Grid resolution in meters. */
  cellMeters: number
  /** 'sum' for counts, 'mean' for intensive fields (elevation, density). */
  aggregation: Aggregation
  toCells(): RawCell[]
}
