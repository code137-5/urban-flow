import { DEFAULT_HOUR_RANGE, FLOWS, particlesForWindow } from '../data/odTrips'
import type { FlowId, HourRange } from '../data/odTrips'
import { PARTICLES_PER_FLOW } from '../layers/particleBudget'

/**
 * Per-panel particle-flow settings: each dashboard panel picks, per flow,
 * whether it is drawn, which hours of the day its OD pairs come from, and how
 * many trips one particle stands for. Types + pure helpers only — the controls
 * are `PanelControls.tsx`, the state lives in `Dashboard.tsx`.
 */

/** One flow's settings in one panel. Committed values only — never mid-drag. */
export interface FlowSettings {
  on: boolean
  /** Half-open [from, to) in whole hours. */
  hours: HourRange
  tripsPerParticle: number
}

export type PanelFlows = Readonly<Record<FlowId, FlowSettings>>

/** What a TerrainPanel draws for one flow: 0 particles = not drawn. */
export interface PanelFlow {
  particles: number
  hours: HourRange
}

/** The first panel's settings; later panels copy their predecessor's. */
export const DEFAULT_PANEL_FLOWS: PanelFlows = Object.fromEntries(
  FLOWS.map((f) => [
    f.id,
    { on: f.defaultOn, hours: DEFAULT_HOUR_RANGE, tripsPerParticle: f.tripsPerParticle },
  ]),
) as Record<FlowId, FlowSettings>

/** Trips-per-particle number input: bounds and step. */
export const TPP_MIN = 1_000
export const TPP_MAX = 100_000
export const TPP_STEP = 500

/**
 * Particles per flow for one panel: the trips in its window ÷ its trips per
 * particle, so a quiet window looks quiet; 0 when the flow is off. Until the
 * flow's hour totals arrive (and for good without Supabase) it is the fixed
 * fallback, which the default trips-per-particle are tuned to match at 07–10.
 */
export function resolvePanelFlows(
  s: PanelFlows,
  totals: Record<FlowId, number[] | null>,
): Record<FlowId, PanelFlow> {
  return Object.fromEntries(
    FLOWS.map((flow) => {
      const { on, hours, tripsPerParticle } = s[flow.id]
      const t = totals[flow.id]
      const particles = !on
        ? 0
        : t
          ? particlesForWindow(t, hours, tripsPerParticle)
          : PARTICLES_PER_FLOW
      return [flow.id, { particles, hours }]
    }),
  ) as Record<FlowId, PanelFlow>
}

/** Debounce on the hour thumbs: each committed change can mean a new reservoir fetch. */
export const HOUR_COMMIT_MS = 200
/** Quiet marks at 06 / 12 / 18 so the 0–24 track reads as a day. */
export const HOUR_TICKS = [6, 12, 18]
/** 7 → "07:00". The upper extreme reads "24:00" — the window is half-open. */
export const formatHour = (h: number) => `${String(h).padStart(2, '0')}:00`
/** Bound labels flanking the track stay to the bare 2-digit hour. */
export const formatHourBound = (h: number) => String(h).padStart(2, '0')
