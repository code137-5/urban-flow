/**
 * Global particle budget, shared by every dashboard panel.
 *
 * The dashboard can grow to 6 contour-terrain panels, each with its own WebGL
 * context and particle layer. Mobile GPUs sustain ~50k point sprites at 60fps
 * across a page; we stay well under that so terrain + up to 6 contexts fit too.
 * Each panel asks for its share via `perPanelParticleCount` — the layer itself
 * only ever sees a resolved `numParticles` prop.
 */

export type GpuTier = 'desktop' | 'mobile'

let cachedTier: GpuTier | null = null

/** Coarse-pointer heuristic; cached — a session never changes tier. */
export function detectGpuTier(): GpuTier {
  if (cachedTier) return cachedTier
  const coarse =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches
  cachedTier = coarse ? 'mobile' : 'desktop'
  return cachedTier
}

/** Total base particles across ALL live panels. */
export const GLOBAL_PARTICLE_BUDGET: Record<GpuTier, number> = {
  desktop: 24_000,
  mobile: 12_000,
}

/** Cap for a single panel even when it has the budget to itself. */
export const MAX_PER_PANEL: Record<GpuTier, number> = {
  desktop: 8_000,
  mobile: 4_000,
}

/**
 * Per-panel particle count: an equal share of the global budget, clamped by
 * the per-panel cap and an optional explicit request (e.g. from the tuner).
 */
export function perPanelParticleCount(activePanels: number, requested = Infinity): number {
  const tier = detectGpuTier()
  const share = Math.floor(GLOBAL_PARTICLE_BUDGET[tier] / Math.max(1, activePanels))
  return Math.max(0, Math.min(requested, share, MAX_PER_PANEL[tier]))
}
