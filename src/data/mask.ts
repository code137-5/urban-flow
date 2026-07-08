import booleanPointInPolygon from '@turf/boolean-point-in-polygon'
import type { Bounds } from './types'
import { SEOUL_FEATURES } from './seoulGeo'

/** Inside Seoul iff the point falls in any of the 25 자치구 polygons. */
function inSeoul(lng: number, lat: number): boolean {
  for (const f of SEOUL_FEATURES) {
    if (booleanPointInPolygon([lng, lat], f)) return true
  }
  return false
}

/**
 * Rasterize "inside Seoul" onto a gridSize×gridSize grid. Returns 1 for kept
 * cells, 0 for masked-out (outside the city). Row-major, same layout as the
 * heightmap.
 *
 * The Han river is intentionally NOT masked out — the KDE contour field flows
 * across it, and the river is drawn separately as a flat overlay. Runtime
 * ~1–2s for 200×200; cached in-memory per bounds+gridSize by field.ts.
 */
export function buildMask(bounds: Bounds, gridSize = 200): Float32Array {
  const [minLng, minLat, maxLng, maxLat] = bounds
  const spanLng = maxLng - minLng
  const spanLat = maxLat - minLat
  const mask = new Float32Array(gridSize * gridSize)

  for (let r = 0; r < gridSize; r++) {
    const lat = minLat + ((r + 0.5) / gridSize) * spanLat
    for (let c = 0; c < gridSize; c++) {
      const lng = minLng + ((c + 0.5) / gridSize) * spanLng
      mask[r * gridSize + c] = inSeoul(lng, lat) ? 1 : 0
    }
  }
  return mask
}

/**
 * Merge a mask into a heightmap: masked-out cells become -1 so the terrain
 * fragment shader can `discard` them. Returns a new array.
 */
export function applyMask(heightmap: Float32Array, mask: Float32Array): Float32Array {
  const out = new Float32Array(heightmap.length)
  for (let i = 0; i < heightmap.length; i++) {
    out[i] = mask[i] < 0.5 ? -1 : heightmap[i]
  }
  return out
}
