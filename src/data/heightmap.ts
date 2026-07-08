import type { Bounds, GeoPoint } from './types'

const M_PER_DEG_LAT = 111320

/**
 * Weighted Gaussian KDE of `points` onto a `gridSize`×`gridSize` grid over `bounds`.
 * Returns a row-major Float32Array normalized to [0, 1] by p99 clipping.
 *
 *   h(x,y) = Σᵢ wᵢ · exp(-‖(x,y) - pointᵢ‖² / 2σ²)     (distance in meters)
 *
 * Design notes (technique ported from Aete/seoul-terrain-animation):
 * - Each point only touches cells within a σ×3 radius → O(N·k²).
 * - `useLogWeight` (default) compresses the heavy tail so one hotspot (e.g. Gangnam)
 *   doesn't flatten everything else.
 * - Normalization clips at the 99th percentile then divides — NOT max-normalization,
 *   which would crush all but the top few cells to ~0.
 *
 * @param hour  null → use aggregate `weight`; 0–23 → use `weightByHour[hour]`.
 */
export function buildHeightmap(
  points: GeoPoint[],
  bounds: Bounds,
  gridSize = 200,
  sigmaMeters = 500,
  hour: number | null = null,
  useLogWeight = true,
): Float32Array {
  const [minLng, minLat, maxLng, maxLat] = bounds
  const centerLat = (minLat + maxLat) / 2
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((centerLat * Math.PI) / 180)

  const spanLng = maxLng - minLng
  const spanLat = maxLat - minLat
  const cellMetersX = (spanLng * mPerDegLng) / gridSize
  const cellMetersY = (spanLat * M_PER_DEG_LAT) / gridSize

  // Cutoff radius (σ×3) expressed in grid cells per axis.
  const cutoff = sigmaMeters * 3
  const radCols = Math.ceil(cutoff / cellMetersX)
  const radRows = Math.ceil(cutoff / cellMetersY)
  const inv2Sigma2 = 1 / (2 * sigmaMeters * sigmaMeters)

  const grid = new Float32Array(gridSize * gridSize)

  for (const p of points) {
    const raw = hour === null ? p.weight : (p.weightByHour?.[hour] ?? 0)
    if (raw <= 0) continue
    const w = useLogWeight ? Math.log1p(raw) : raw

    // Fractional grid position of the point.
    const pcol = ((p.lng - minLng) / spanLng) * gridSize - 0.5
    const prow = ((p.lat - minLat) / spanLat) * gridSize - 0.5
    const c0 = Math.max(0, Math.floor(pcol - radCols))
    const c1 = Math.min(gridSize - 1, Math.ceil(pcol + radCols))
    const r0 = Math.max(0, Math.floor(prow - radRows))
    const r1 = Math.min(gridSize - 1, Math.ceil(prow + radRows))

    for (let r = r0; r <= r1; r++) {
      const cellLat = minLat + ((r + 0.5) / gridSize) * spanLat
      const dyMeters = (cellLat - p.lat) * M_PER_DEG_LAT
      const dy2 = dyMeters * dyMeters
      for (let c = c0; c <= c1; c++) {
        const cellLng = minLng + ((c + 0.5) / gridSize) * spanLng
        const dxMeters = (cellLng - p.lng) * mPerDegLng
        const d2 = dxMeters * dxMeters + dy2
        grid[r * gridSize + c] += w * Math.exp(-d2 * inv2Sigma2)
      }
    }
  }

  return normalizeP99(grid)
}

/** Clamp to the 99th percentile then scale to [0, 1]. Mutates and returns `grid`. */
function normalizeP99(grid: Float32Array): Float32Array {
  const sorted = Float32Array.from(grid).sort()
  const p99 = sorted[Math.floor(0.99 * (sorted.length - 1))]
  if (p99 <= 0) return grid // degenerate (all ~0); leave as-is
  for (let i = 0; i < grid.length; i++) {
    grid[i] = Math.min(grid[i], p99) / p99
  }
  return grid
}
