import { SEOUL_BOUNDS } from '../../../src/data/bounds.ts'
import { CONTOURS_PATH, contoursToCells } from '../contours.ts'
import type { DatasetJob } from '../job.ts'

/**
 * DEM — real Seoul terrain elevation (표고, meters), rasterized from the 20 m
 * contour lines in data/raw/contours.geojson (see contours.ts). The converter
 * already emits one sample per grid cell, so 'mean' is a pass-through; the
 * frontend KDE then smooths the regular grid into the contour surface.
 * 250 m cells keep the Bukhansan / Inwangsan ridges from washing out.
 */
const CELL_METERS = 250

export const demJob: DatasetJob = {
  id: 'dem',
  cellMeters: CELL_METERS,
  aggregation: 'mean',
  toCells: () => contoursToCells(CONTOURS_PATH, SEOUL_BOUNDS, CELL_METERS),
}
