/**
 * Snap `raw` onto the step grid anchored at `min`, then clamp into [lo, hi].
 * The toFixed round-trip keeps fractional steps clean (0.1 + 3 * 0.1 is not 0.4
 * in binary floating point); the gap clamp wins over the grid, so a thumb pushed
 * against its neighbour parks exactly `minGap` away even off-grid.
 */
export function snapClamp(raw: number, min: number, step: number, lo: number, hi: number): number {
  const snapped = Number((min + Math.round((raw - min) / step) * step).toFixed(6))
  return Math.min(hi, Math.max(lo, snapped))
}
