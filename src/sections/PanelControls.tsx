import { useEffect, useState } from 'react'
import { DEFAULT_HOUR_RANGE, FLOWS } from '../data/odTrips'
import type { FlowId, OdFlow } from '../data/odTrips'
import { NumberInput } from '../ui/NumberInput'
import { RangeSlider } from '../ui/RangeSlider'
import {
  HOUR_COMMIT_MS,
  HOUR_TICKS,
  TPP_MAX,
  TPP_MIN,
  TPP_STEP,
  formatHour,
  formatHourBound,
} from './panelSettings'
import type { FlowSettings, PanelFlows } from './panelSettings'
import dash from './Dashboard.module.css'
import styles from './PanelControls.module.css'

export interface PanelControlsProps {
  /** Stable panel key — passed back through `onChange`. */
  panelKey: number
  /** 0-based position, for the "Panel n" accessible names. */
  panelIndex: number
  settings: PanelFlows
  /** Resolved particle count per flow (0 = off), exposed as `data-particles`. */
  particles: Record<FlowId, number>
  /** Live OD data available; without it hours and trips-per-particle mean nothing. */
  live: boolean
  onChange: (key: number, flowId: FlowId, patch: Partial<FlowSettings>) => void
}

/**
 * One panel's particle-flow strip: per flow an on/off switch (its swatch is the
 * legend), its time-of-day window and what one particle stands for. Every row is
 * always rendered in full — disabled rather than hidden — so strips are the same
 * height in every panel and the canvases below them line up per grid row.
 */
export function PanelControls({
  panelKey,
  panelIndex,
  settings,
  particles,
  live,
  onChange,
}: PanelControlsProps) {
  const n = panelIndex + 1
  return (
    <div className={styles.flowRows} role="group" aria-label={`Panel ${n}: particle flows`}>
      {FLOWS.map((flow) => (
        <FlowRow
          key={flow.id}
          flow={flow}
          panelKey={panelKey}
          n={n}
          settings={settings[flow.id]}
          particles={particles[flow.id]}
          live={live}
          onChange={onChange}
        />
      ))}
    </div>
  )
}

interface FlowRowProps {
  flow: OdFlow
  panelKey: number
  n: number
  settings: FlowSettings
  particles: number
  live: boolean
  onChange: PanelControlsProps['onChange']
}

function FlowRow({ flow, panelKey, n, settings, particles, live, onChange }: FlowRowProps) {
  // Live thumbs while dragging; committed upward once they rest for
  // HOUR_COMMIT_MS, so the dashboard (and the reservoir fetch behind it) never
  // sees mid-drag values.
  const [draft, setDraft] = useState<[number, number] | null>(null)
  useEffect(() => {
    if (draft === null) return
    const id = setTimeout(() => {
      onChange(panelKey, flow.id, { hours: draft })
      setDraft(null)
    }, HOUR_COMMIT_MS)
    return () => clearTimeout(id)
  }, [draft, onChange, panelKey, flow.id])

  const shown = draft ?? settings.hours
  const pending =
    draft !== null && (draft[0] !== settings.hours[0] || draft[1] !== settings.hours[1])
  // The hours mean nothing for a flow that isn't drawn, and nothing at all
  // without Supabase (the fallback trips are synthetic). The switch stays live.
  const disabled = !live || !settings.on
  const label = `Panel ${n}: ${flow.label}`

  return (
    <div className={styles.flowRow} data-flow={flow.id}>
      <label className={`${dash.syncToggle} ${styles.toggle}`}>
        <input
          type="checkbox"
          className={dash.syncCheckbox}
          checked={settings.on}
          aria-label={label}
          onChange={() => onChange(panelKey, flow.id, { on: !settings.on })}
        />
        <span
          className={styles.flowSwatch}
          style={{ background: flow.color }}
          aria-hidden="true"
        />
        <span className={styles.flowLabel}>{flow.label}</span>
      </label>
      <div
        className={[styles.flowScale, disabled ? styles.hourDisabled : '']
          .filter(Boolean)
          .join(' ')}
        data-flow={flow.id}
        data-particles={particles}
        title={`One particle stands for about this many ${flow.tripUnit} in the selected hours. Fewer ${flow.tripUnit} per particle means more particles.`}
      >
        <span>1 particle ≈</span>
        <NumberInput
          className={styles.tpp}
          value={settings.tripsPerParticle}
          min={TPP_MIN}
          max={TPP_MAX}
          step={TPP_STEP}
          disabled={disabled}
          ariaLabel={`${label} trips per particle`}
          onChange={(v) => onChange(panelKey, flow.id, { tripsPerParticle: v })}
        />
        <span className={styles.unit}>{flow.tripUnit}</span>
      </div>
      {/* Double-click the track to send this flow back to 07–10 — this panel only. */}
      <RangeSlider
        className={styles.hourSlider}
        min={0}
        max={24}
        step={1}
        minGap={1}
        value={shown}
        onChange={setDraft}
        ticks={HOUR_TICKS}
        formatValue={formatHour}
        formatBound={formatHourBound}
        ariaLabels={[`${label} start hour`, `${label} end hour`]}
        onReset={() => setDraft([DEFAULT_HOUR_RANGE[0], DEFAULT_HOUR_RANGE[1]])}
        disabled={disabled}
        thumbLabels
      />
      {/* The window as one sentence for assistive tech (and the harness): the
          visible hours sit under the thumbs themselves. */}
      <span
        className={[
          styles.hourValue,
          pending ? styles.hourPending : '',
          disabled ? styles.hourDisabled : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {formatHour(shown[0])}–{formatHour(shown[1])}
      </span>
    </div>
  )
}
