import { buildHeightmap } from './heightmap'
import { applyMask, buildMask } from './mask'
import type { Bounds, GeoPoint, Heightmap } from './types'

/** Mask depends only on bounds+gridSize (not hour/data), so cache it. */
const maskCache = new Map<string, Float32Array>()
function getMask(bounds: Bounds, gridSize: number): Float32Array {
  const key = `${bounds.join(',')}|${gridSize}`
  let m = maskCache.get(key)
  if (!m) {
    m = buildMask(bounds, gridSize)
    maskCache.set(key, m)
  }
  return m
}

export type FieldOptions = {
  gridSize?: number
  sigmaMeters?: number
  hour?: number | null
}

/** Full pipeline: KDE heightmap → Seoul mask → masked Heightmap. */
export function computeHeightmap(
  points: GeoPoint[],
  bounds: Bounds,
  { gridSize = 200, sigmaMeters = 500, hour = null }: FieldOptions = {},
): Heightmap {
  const hm = buildHeightmap(points, bounds, gridSize, sigmaMeters, hour)
  const masked = applyMask(hm, getMask(bounds, gridSize))
  return { data: masked, width: gridSize, height: gridSize, bounds }
}
