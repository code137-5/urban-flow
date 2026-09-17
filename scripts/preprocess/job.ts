import type { Bounds } from '../../src/data/types.ts'
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
  /**
   * Extra sample margin, in meters, grown on every side of SEOUL_BOUNDS before
   * gridding. Must exceed the frontend KDE's 4σ cutoff (src/data/heightmap.ts):
   * the 자치구 polygon touches/crosses SEOUL_BOUNDS on the N and E sides, so
   * without the margin the Gaussian sum truncates inside the mask and that rim
   * becomes the 1st-percentile floor `floorToLowest` subtracts (src/data/field.ts)
   * — which crushes the contrast of a narrow-range field (13–21 °C) down to the
   * artefact instead of the data. Unset = no padding.
   */
  padMeters?: number
  /**
   * `bounds` is SEOUL_BOUNDS grown by `padMeters`; jobs that rasterize onto the
   * grid themselves must use it so their cell centres match run.ts's gridding.
   */
  toCells(bounds: Bounds): RawCell[]
}
