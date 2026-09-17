import { CONTOURS_PATH, contoursToCells } from '../contours.ts'
import type { DatasetJob } from '../job.ts'

/**
 * DEM — real Seoul terrain elevation (표고, meters), rasterized from the 20 m
 * contour lines in data/raw/contours.geojson (see contours.ts). The converter
 * already emits one sample per grid cell, so 'mean' is a pass-through; the
 * frontend KDE then smooths the regular grid into the contour surface.
 * 250 m cells keep the Bukhansan / Inwangsan ridges from washing out.
 * Not clipped to the 자치구: the contours cover terrain past the border, and the
 * KDE needs those samples so the boundary cuts through real elevation instead
 * of dropping to a cliff. No padMeters — the file already extends past the
 * bounds, so SEOUL_BOUNDS itself never truncates the surface.
 */
const CELL_METERS = 250

export const demJob: DatasetJob = {
  id: 'dem',
  cellMeters: CELL_METERS,
  aggregation: 'mean',
  clip: false,
  toCells: (bounds) => contoursToCells(CONTOURS_PATH, bounds, CELL_METERS),
}
