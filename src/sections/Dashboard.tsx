import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Container, Section, Eyebrow } from '../ui/layout'
import { DEFAULT_SOURCE, SOURCES, getSource } from '../data/sources'
import type { DatasetId } from '../data/types'
import { FLOWS, loadOdHourTotals, odConfigured } from '../data/odTrips'
import type { FlowId } from '../data/odTrips'
import { PanelControls } from './PanelControls'
import { DEFAULT_PANEL_FLOWS, resolvePanelFlows } from './panelSettings'
import type { FlowSettings, PanelFlow, PanelFlows } from './panelSettings'
import { TerrainPanel } from './TerrainPanel'
import type { PanelCamera } from './TerrainPanel'
import styles from './Dashboard.module.css'

/**
 * A dashboard panel is described by a stable key, the id of the dataset it
 * shows and its particle-flow settings. The key is a monotonically-increasing
 * counter (never Math.random / Date.now — those break reconciliation and are
 * forbidden in this env), so React keeps each panel's deck.gl instance stable
 * across add/remove. `sourceId` drives which `DataSource` the panel renders and
 * its header copy, selectable per panel via the header dropdown. `flows` holds
 * the COMMITTED per-flow settings (on/off, hour window, trips per particle) —
 * PanelControls debounces the thumbs itself, so mid-drag values never land here.
 */
interface PanelDescriptor {
  key: number
  sourceId: DatasetId
  flows: PanelFlows
}

/** Two full rows of three. */
const MAX_PANELS = 6

const NO_TOTALS = Object.fromEntries(FLOWS.map((f) => [f.id, null])) as Record<
  FlowId,
  number[] | null
>

/**
 * Carbon responsive column cap by viewport width (md = 672, lg = 1056):
 * mobile → 1, tablet → 2, desktop → up to 3. The actual column count is then
 * `min(cap, itemCount)` so the grid never leaves empty stretched tracks.
 */
function columnCapForWidth(width: number): number {
  if (width <= 672) return 1
  if (width <= 1056) return 2
  return 3
}

/** Track viewport width so the grid re-picks its column count on resize. */
function useViewportWidth(): number {
  const [width, setWidth] = useState(() =>
    typeof window === 'undefined' ? 1440 : window.innerWidth,
  )
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return width
}

/**
 * Dashboard section — the interactive comparison surface (P5).
 *
 * Starts with one real contour-terrain panel (deck.gl, technique from
 * Aete/seoul-terrain-animation) and grows: "Add a dataset" appends panels into a
 * responsive grid that caps at 3 columns and wraps onto new rows (up to 6 panels
 * total). Panels are removable down to a minimum of one. The global particle
 * budget re-splits across every active (panel, flow) layer on each change (see
 * particleBudget.ts).
 *
 * Particle settings are PER PANEL: each panel's control strip (PanelControls)
 * picks, per flow, whether it is drawn, which hours of the day its OD pairs come
 * from, and how many trips one particle stands for — so "bike 07–10" can sit
 * beside "bike 17–20". Panels whose settings are identical share one trip
 * schedule (layers/tripSchedule.ts) and move in lockstep; a panel with its own
 * window runs its own. A new panel copies the previous panel's settings, so it
 * joins that panel's swarm mid-flight until the user changes something.
 */
export function Dashboard() {
  const [panels, setPanels] = useState<PanelDescriptor[]>(() => [
    { key: 0, sourceId: DEFAULT_SOURCE.meta.id, flows: DEFAULT_PANEL_FLOWS },
  ])
  // Next stable key to hand out. Kept in a ref so it survives re-renders without
  // triggering one; StrictMode may skip a value, which is harmless (uniqueness,
  // not contiguity, is what matters for React keys).
  const nextKey = useRef(1)

  const width = useViewportWidth()
  const canAdd = panels.length < MAX_PANELS

  // Camera (center/zoom/bearing/pitch) per panel, keyed by panel.key; null = "use
  // the size-fitted view" (also the reset target). When `linked` is on, every
  // panel reads and writes the FIRST panel's entry instead of its own, so all
  // views pan/zoom/rotate together — the "sync views" option.
  const [cameras, setCameras] = useState<Record<number, PanelCamera | null>>({})
  // Sync-views on by default: added panels start locked to panel 1's camera so
  // comparisons line up out of the box. The toggle stays disabled until a second
  // panel exists (nothing to sync with one panel).
  const [linked, setLinked] = useState(true)

  // Trips per hour of day, per flow — 24 numbers each, page-wide (the totals
  // are a property of the dataset, not of any panel). Both flows load on mount
  // so a panel switching a flow on gets its proportional count at once. null =
  // not loaded, or Supabase can't supply them.
  const [hourTotals, setHourTotals] = useState(NO_TOTALS)
  useEffect(() => {
    let alive = true
    for (const flow of FLOWS) {
      void loadOdHourTotals(flow.id).then((totals) => {
        if (alive && totals) setHourTotals((prev) => ({ ...prev, [flow.id]: totals }))
      })
    }
    return () => {
      alive = false
    }
  }, [])

  // The one updater every PanelControls reports through. Stable (no deps) so the
  // strips' debounce effects don't re-arm on every dashboard render, and it
  // returns `prev` when the patch changes nothing — a repeated or
  // StrictMode-doubled commit must not re-key anything.
  const changeFlow = useCallback((key: number, flowId: FlowId, patch: Partial<FlowSettings>) => {
    setPanels((prev) => {
      const panel = prev.find((p) => p.key === key)
      if (!panel) return prev
      const cur = panel.flows[flowId]
      const next: FlowSettings = {
        on: patch.on ?? cur.on,
        hours: patch.hours ?? cur.hours,
        tripsPerParticle: patch.tripsPerParticle ?? cur.tripsPerParticle,
      }
      if (
        next.on === cur.on &&
        next.tripsPerParticle === cur.tripsPerParticle &&
        next.hours[0] === cur.hours[0] &&
        next.hours[1] === cur.hours[1]
      ) {
        return prev
      }
      const flows: PanelFlows = { ...panel.flows, [flowId]: next }
      return prev.map((p) => (p.key === key ? { ...p, flows } : p))
    })
  }, [])

  // What each panel actually draws: particles per flow (0 = off; ∝ the trips in
  // its window ÷ its trips per particle once the totals are known) plus the
  // window itself. Memoised as one map so a panel's `flows` prop keeps its
  // identity between commits that touch neither the panels nor the totals —
  // TerrainPanel keys its schedules on it.
  const resolved = useMemo(() => {
    const map = new Map<number, Record<FlowId, PanelFlow>>()
    for (const p of panels) map.set(p.key, resolvePanelFlows(p.flows, hourTotals))
    return map
  }, [panels, hourTotals])
  // Every (panel, flow) layer that draws splits the global particle budget.
  let activeLayers = 0
  for (const r of resolved.values()) {
    for (const flow of FLOWS) if (r[flow.id].particles > 0) activeLayers += 1
  }

  // Without Supabase env the flows fall back to random trips, where an hour
  // window (and a trips-per-particle) means nothing — so say so and lock those
  // controls. Optimistic until the check resolves, which keeps the common
  // (configured) path from flickering.
  const [odLive, setOdLive] = useState(true)
  useEffect(() => {
    let alive = true
    // A rejection here means the Supabase client chunk itself failed to load,
    // which is just as unavailable as a missing key.
    void odConfigured()
      .catch(() => false)
      .then((ok) => {
        if (alive) setOdLive(ok)
      })
    return () => {
      alive = false
    }
  }, [])

  const firstKey = panels[0]?.key ?? 0

  const cameraFor = (key: number): PanelCamera | null => cameras[linked ? firstKey : key] ?? null

  const handleCameraChange = (key: number) => (next: PanelCamera) => {
    const target = linked ? firstKey : key
    setCameras((prev) => ({ ...prev, [target]: next }))
  }

  // Reset a panel back to its size-fitted view (null camera). Honors `linked` so
  // resetting one synced panel re-fits them all.
  const handleResetCamera = (key: number) => () => {
    const target = linked ? firstKey : key
    setCameras((prev) => ({ ...prev, [target]: null }))
  }

  const toggleLinked = () => {
    setLinked((prevLinked) => {
      // On unlink, seed every panel with the shared camera so nothing jumps;
      // they then diverge as each is dragged independently.
      if (prevLinked) {
        setCameras((prev) => {
          const shared = prev[firstKey] ?? null
          const next = { ...prev }
          for (const p of panels) next[p.key] = shared
          return next
        })
      }
      return !prevLinked
    })
  }

  // A new panel copies the previous panel's flow settings (user decision): the
  // most likely next comparison is "the same, but one thing different". Sharing
  // the settings object is safe — every update replaces it immutably.
  const addPanel = () => {
    setPanels((prev) => {
      if (prev.length >= MAX_PANELS) return prev
      const key = nextKey.current
      nextKey.current += 1
      const flows = prev[prev.length - 1]?.flows ?? DEFAULT_PANEL_FLOWS
      return [...prev, { key, sourceId: DEFAULT_SOURCE.meta.id, flows }]
    })
  }

  const removePanel = (key: number) => {
    // Keep at least one panel so the dashboard is never empty.
    setPanels((prev) => (prev.length <= 1 ? prev : prev.filter((p) => p.key !== key)))
  }

  // Switch a single panel's dataset. State is keyed per panel, so mapping over
  // `prev` and replacing only the matching key leaves every other panel — and its
  // deck.gl instance — untouched; that panel's TerrainPanel then recomputes its
  // heightmap from the new `source` prop.
  const changeSource = (key: number, sourceId: DatasetId) => {
    setPanels((prev) => prev.map((p) => (p.key === key ? { ...p, sourceId } : p)))
  }

  // Grid children = panels + (the trailing add tile, when below the cap). Column
  // count is min(width cap, children) so panels stay readable and never overflow.
  const itemCount = panels.length + (canAdd ? 1 : 0)
  const columns = Math.max(1, Math.min(columnCapForWidth(width), itemCount))
  const gridStyle: CSSProperties = {
    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
  }

  return (
    <Section id="dashboard" divided>
      <Container>
        <Eyebrow>Dashboard</Eyebrow>
        <h2 className={styles.headline}>Compare contours and particles side by side</h2>
        <p className={styles.lead}>
          Add datasets to build a live comparison. The grid starts with one panel and grows to
          three across, then wraps to a second row — up to six panels. Remove any panel to refocus.
        </p>

        {/* One thin row: the no-Supabase hint (only when it applies — the cause
            is the build's missing env, the same for every panel and flow) on the
            left, the view option on the right. Everything per flow lives in each
            panel's own strip. */}
        <div className={styles.toolbar}>
          {odLive ? null : <span className={styles.hourHint}>Live OD data unavailable</span>}
          <label className={`${styles.syncToggle} ${styles.syncViews}`}>
            <input
              type="checkbox"
              className={styles.syncCheckbox}
              checked={linked}
              onChange={toggleLinked}
              disabled={panels.length < 2}
            />
            <span>Sync all views to panel 1</span>
          </label>
        </div>

        <div className={styles.panels} style={gridStyle}>
          {panels.map((panel, index) => {
            const source = getSource(panel.sourceId) ?? DEFAULT_SOURCE
            const { meta } = source
            const flows = resolved.get(panel.key) ?? resolvePanelFlows(panel.flows, hourTotals)
            const particles = Object.fromEntries(
              FLOWS.map((f) => [f.id, flows[f.id].particles]),
            ) as Record<FlowId, number>
            return (
              <article className={styles.panel} key={panel.key}>
                <header className={styles.panelHead}>
                  <span className={styles.dot} aria-hidden="true" />
                  <div className={styles.panelTitleGroup}>
                    {/* Per-panel dataset selector — a native <select> of all
                        SOURCES. Changing it updates only THIS panel's sourceId
                        (state is keyed per panel), which re-renders its terrain
                        and header copy. It doubles as the panel title. */}
                    <div className={styles.selectorSlot}>
                      <select
                        className={styles.select}
                        value={panel.sourceId}
                        aria-label={`Dataset for panel ${index + 1}`}
                        onChange={(e) => changeSource(panel.key, e.target.value as DatasetId)}
                      >
                        {SOURCES.map((s) => (
                          <option key={s.meta.id} value={s.meta.id}>
                            {s.meta.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <p className={styles.panelSub}>{meta.description}</p>
                  </div>
                  <button
                    className={styles.remove}
                    type="button"
                    onClick={() => removePanel(panel.key)}
                    disabled={panels.length <= 1}
                    aria-label={`Remove ${meta.label} panel`}
                    title={panels.length <= 1 ? 'At least one panel is required' : 'Remove panel'}
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </header>

                <PanelControls
                  panelKey={panel.key}
                  panelIndex={index}
                  settings={panel.flows}
                  particles={particles}
                  live={odLive}
                  onChange={changeFlow}
                />

                <div className={styles.canvas}>
                  <TerrainPanel
                    source={source}
                    flows={flows}
                    activeLayers={Math.max(1, activeLayers)}
                    camera={cameraFor(panel.key)}
                    onCameraChange={handleCameraChange(panel.key)}
                    onResetCamera={handleResetCamera(panel.key)}
                  />
                </div>

                <footer className={styles.panelMeta}>
                  <span>Unit · {meta.unit}</span>
                  <span>Contour terrain (KDE) · GPU particle flow</span>
                </footer>
              </article>
            )
          })}

          {canAdd ? (
            <button className={styles.addPanel} type="button" onClick={addPanel}>
              <span className={styles.plus} aria-hidden="true">
                +
              </span>
              <span className={styles.addLabel}>Add a dataset</span>
              <span className={styles.addHint}>Up to {MAX_PANELS} panels</span>
            </button>
          ) : (
            <div className={`${styles.addPanel} ${styles.addPanelMax}`} aria-disabled="true">
              <span className={styles.addLabel}>Maximum reached</span>
              <span className={styles.addHint}>{MAX_PANELS} panels is the limit</span>
            </div>
          )}
        </div>
      </Container>
    </Section>
  )
}
