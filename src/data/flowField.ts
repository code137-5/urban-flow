import type { Heightmap } from './types'

/**
 * Flow field derived from a heightmap, encoded for an rgba8unorm GPU texture.
 * Sampled (only) by the particle update shader: R,G = gradient direction,
 * B = height, A = Seoul mask. 8-bit unorm is the most universally supported
 * texture format there is — float textures are the mobile failure class this
 * project already ran away from.
 */
export interface FlowField {
  /** RGBA rows, bottom-up matching the heightmap grid (width×height×4). */
  data: Uint8Array
  width: number
  height: number
  /** Heightmap bounds spans in meters (lat-corrected) — meter→UV conversion. */
  spanXMeters: number
  spanYMeters: number
  /** Gradient magnitude (height-units per meter) encoded as ±1 in R/G. */
  maxGradient: number
}

const M_PER_DEG_LAT = 110_540
const M_PER_DEG_LNG_EQUATOR = 111_320

/**
 * Central-difference gradient of the heightmap in meter space, normalized by
 * the field's max magnitude and packed as biased bytes (value*0.5+0.5).
 * Masked neighbors (−1) fall back to a one-sided difference so gradients stay
 * finite at the Seoul boundary; fully masked cells encode a zero vector with
 * A = 0 so the shader can respawn particles that drift outside.
 */
export function computeFlowField(heightmap: Heightmap): FlowField {
  const { data, width: W, height: H, bounds } = heightmap
  const [minLng, minLat, maxLng, maxLat] = bounds
  const midLat = (minLat + maxLat) / 2
  const spanXMeters = (maxLng - minLng) * M_PER_DEG_LNG_EQUATOR * Math.cos((midLat * Math.PI) / 180)
  const spanYMeters = (maxLat - minLat) * M_PER_DEG_LAT
  const cellX = spanXMeters / W
  const cellY = spanYMeters / H

  const h = (i: number, j: number): number => data[j * W + i]
  const masked = (i: number, j: number): boolean => h(i, j) < 0

  // Pass 1: raw gradients + field max magnitude.
  const gx = new Float32Array(W * H)
  const gy = new Float32Array(W * H)
  let maxGradient = 0
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const k = j * W + i
      if (masked(i, j)) continue

      const c = h(i, j)
      const lOk = i > 0 && !masked(i - 1, j)
      const rOk = i < W - 1 && !masked(i + 1, j)
      const dOk = j > 0 && !masked(i, j - 1)
      const uOk = j < H - 1 && !masked(i, j + 1)

      // Central difference where both neighbors exist, one-sided otherwise.
      gx[k] =
        lOk && rOk
          ? (h(i + 1, j) - h(i - 1, j)) / (2 * cellX)
          : rOk
            ? (h(i + 1, j) - c) / cellX
            : lOk
              ? (c - h(i - 1, j)) / cellX
              : 0
      gy[k] =
        dOk && uOk
          ? (h(i, j + 1) - h(i, j - 1)) / (2 * cellY)
          : uOk
            ? (h(i, j + 1) - c) / cellY
            : dOk
              ? (c - h(i, j - 1)) / cellY
              : 0

      const mag = Math.hypot(gx[k], gy[k])
      if (mag > maxGradient) maxGradient = mag
    }
  }
  if (maxGradient === 0) maxGradient = 1 // degenerate flat field; encodes as all-zero vectors

  // Pass 2: encode. Biased byte: -1..1 → 0..255 (128 = zero).
  const out = new Uint8Array(W * H * 4)
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const k = j * W + i
      const o = k * 4
      if (masked(i, j)) {
        out[o] = 128
        out[o + 1] = 128
        out[o + 2] = 0
        out[o + 3] = 0
        continue
      }
      out[o] = Math.round(((gx[k] / maxGradient) * 0.5 + 0.5) * 255)
      out[o + 1] = Math.round(((gy[k] / maxGradient) * 0.5 + 0.5) * 255)
      out[o + 2] = Math.round(Math.min(Math.max(h(i, j), 0), 1) * 255)
      out[o + 3] = 255
    }
  }

  return { data: out, width: W, height: H, spanXMeters, spanYMeters, maxGradient }
}
