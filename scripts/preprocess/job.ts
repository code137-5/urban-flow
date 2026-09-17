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
  /**
   * Drop cells outside the 25 자치구 before writing (default true). Set false for
   * continuous fields like elevation: the frontend KDE is an un-normalized sum,
   * so without samples beyond the boundary the surface falls to zero along the
   * edge and the city reads as a cliff-walled plateau. The render-time mask
   * still hides everything outside Seoul.
   */
  clip?: boolean
  toCells(): RawCell[]
}
