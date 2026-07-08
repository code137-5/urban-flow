import { GeoJsonLayer } from '@deck.gl/layers'
import { SEOUL_BOUNDARY } from '../data/seoulGeo'

export type SeoulBoundaryOptions = {
  /** Outline color, RGB or RGBA 0–255. */
  lineColor?: [number, number, number] | [number, number, number, number]
  /** Faint plate fill, RGBA 0–255. */
  fillColor?: [number, number, number, number]
  lineWidth?: number
}

/**
 * Seoul administrative outline, drawn flat at ground level (z=0) beneath the
 * contour terrain so the city's shape reads even where the KDE field is flat.
 * The outer edges of the 25 자치구 form the Seoul boundary; the inner edges are
 * district borders. `depthTest: false` keeps it a clean backdrop plate — the
 * terrain (drawn after) paints its contour relief on top.
 */
export function seoulBoundaryLayer({
  lineColor = [148, 163, 184],
  fillColor = [148, 163, 184, 14],
  lineWidth = 1.2,
}: SeoulBoundaryOptions = {}): GeoJsonLayer {
  return new GeoJsonLayer({
    id: 'seoul-boundary',
    data: SEOUL_BOUNDARY,
    stroked: true,
    filled: true,
    getLineColor: lineColor,
    getFillColor: fillColor,
    updateTriggers: { getLineColor: lineColor, getFillColor: fillColor },
    lineWidthUnits: 'pixels',
    getLineWidth: lineWidth,
    lineWidthMinPixels: 1,
    parameters: { depthTest: false },
  })
}
