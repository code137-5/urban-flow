/**
 * Global particle budget, shared by every particle layer on the page.
 *
 * The dashboard can grow to 6 contour-terrain panels, each with its own WebGL
 * context and one particle layer per flow it has switched on. Mobile GPUs
 * sustain ~50k point sprites at 60fps across a page; we stay well under that so
 * terrain + up to 6 contexts fit too. Each (panel, flow) layer asks for its share
 * via `perPanelParticleCount` — the layer itself only ever sees a resolved
 * `numParticles` prop.
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

/**
 * Fallback particles per flow per panel. The real count is the trips in the
 * flow's hour window ÷ its trips-per-particle (Dashboard / odTrips.ts); this is
 * what draws until the hour totals arrive, and for good without Supabase. The
 * default trips-per-particle are tuned to give about this many at 07–10, so the
 * hand-over is invisible. A full-day window asks for ~1,900 per flow, which the
 * desktop share still covers at 6 panels × 2 flows (24,000 / 12 = 2,000); on
 * mobile `perPanelParticleCount` clamps wide windows.
 */
export const PARTICLES_PER_FLOW = 400

/** Total base particles across ALL live panels. */
export const GLOBAL_PARTICLE_BUDGET: Record<GpuTier, number> = {
  desktop: 24_000,
  mobile: 12_000,
}

/** Cap for a single (panel, flow) layer even when it has the budget to itself. */
export const MAX_PER_PANEL: Record<GpuTier, number> = {
  desktop: 8_000,
  mobile: 4_000,
}

/**
 * Particle count for one (panel, flow) layer: an equal share of the global
 * budget across every active layer page-wide, clamped by the per-layer cap and
 * an optional explicit request — the count the flow's hour window and
 * trips-per-particle ask for.
 *
 * @param activeLayers active (panel, flow) particle layers page-wide — every
 *   flow with particles > 0 in every panel, so two panels showing both flows
 *   count 4, not 2.
 * @param requested the count this layer wants; the share is only a ceiling.
 */
export function perPanelParticleCount(activeLayers: number, requested = Infinity): number {
  const tier = detectGpuTier()
  const share = Math.floor(GLOBAL_PARTICLE_BUDGET[tier] / Math.max(1, activeLayers))
  return Math.max(0, Math.min(requested, share, MAX_PER_PANEL[tier]))
}
