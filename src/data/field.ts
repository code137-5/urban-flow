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

/**
 * Drop the surface so its lowest in-mask level sits at 0. Fields with a
 * non-zero base (real elevation: the Han river plain is ~10 m, not 0) would
 * otherwise float as a thick slab above the z=0 boundary plate. The floor is
 * the 1st percentile of in-mask cells (robust to a few edge cells), and the
 * remaining range is rescaled so the p99 summit still lands at exactly 1 —
 * the fragment shader's plateau cap keys on that value. Mutates `data`.
 */
function floorToLowest(data: Float32Array): void {
  const inside: number[] = []
  for (let i = 0; i < data.length; i++) if (data[i] >= 0) inside.push(data[i])
  if (inside.length === 0) return
  inside.sort((a, b) => a - b)
  const floor = inside[Math.floor(0.01 * (inside.length - 1))]
  if (floor <= 0 || floor >= 1) return
  const scale = 1 / (1 - floor)
  for (let i = 0; i < data.length; i++) {
    if (data[i] >= 0) data[i] = Math.max(0, data[i] - floor) * scale
  }
}

/** Full pipeline: KDE heightmap → Seoul mask → floor to lowest → Heightmap. */
export function computeHeightmap(
  points: GeoPoint[],
  bounds: Bounds,
  { gridSize = 200, sigmaMeters = 500, hour = null }: FieldOptions = {},
): Heightmap {
  const hm = buildHeightmap(points, bounds, gridSize, sigmaMeters, hour)
  const masked = applyMask(hm, getMask(bounds, gridSize))
  floorToLowest(masked)
  return { data: masked, width: gridSize, height: gridSize, bounds }
}
