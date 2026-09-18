import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Container, Section, Eyebrow } from '../ui/layout'
import { DEFAULT_SOURCE, SOURCES, getSource } from '../data/sources'
import type { DatasetId } from '../data/types'
import { FLOWS } from '../data/odTrips'
import type { FlowId } from '../data/odTrips'
import { TerrainPanel } from './TerrainPanel'
import type { PanelCamera } from './TerrainPanel'
import styles from './Dashboard.module.css'

/**
 * A dashboard panel is described by a stable key plus the id of the dataset it
 * shows. The key is a monotonically-increasing counter (never Math.random /
 * Date.now — those break reconciliation and are forbidden in this env), so React
 * keeps each panel's deck.gl instance stable across add/remove. `sourceId`
 * drives which `DataSource` the panel renders and its header copy, selectable
 * per panel via the header dropdown.
 */
interface PanelDescriptor {
  key: number
  sourceId: DatasetId
}

/** Two full rows of three. */
const MAX_PANELS = 6

/**
 * Particles per flow per panel. The ceiling keeps the worst case — 6 panels × 2
 * flows — inside the desktop particle budget (24,000), so the slider never lies.
 */
const DEFAULT_FLOW_COUNTS: Record<FlowId, number> = { bike: 400, migration: 400 }
const DEFAULT_FLOWS_ON = Object.fromEntries(FLOWS.map((f) => [f.id, f.defaultOn])) as Record<
  FlowId,
  boolean
>
const FLOW_COUNT_MIN = 100
const FLOW_COUNT_MAX = 2000
const FLOW_COUNT_STEP = 100
const COUNT_COMMIT_MS = 150

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
 * budget re-splits across panels on every add/remove (see particleBudget.ts).
 * Every panel plays the same particles in lockstep (layers/tripSchedule.ts); which
 * OD flows they are is one dashboard-wide choice, so panels stay comparable.
 */
export function Dashboard() {
  const [panels, setPanels] = useState<PanelDescriptor[]>(() => [
    { key: 0, sourceId: DEFAULT_SOURCE.meta.id },
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
  // Particle flows drawn in every panel, each its own color: on/off plus a
  // particles-per-panel count. `flowCounts` tracks the slider thumbs live;
  // `committedCounts` follows once the drag settles, because a new count rebuilds
  // every panel's particle buffers.
  const [flowsOn, setFlowsOn] = useState<Record<FlowId, boolean>>(DEFAULT_FLOWS_ON)
  const [flowCounts, setFlowCounts] = useState<Record<FlowId, number>>(DEFAULT_FLOW_COUNTS)
  const [committedCounts, setCommittedCounts] = useState(flowCounts)
  useEffect(() => {
    const id = setTimeout(() => setCommittedCounts(flowCounts), COUNT_COMMIT_MS)
    return () => clearTimeout(id)
  }, [flowCounts])
  const flows = useMemo<Record<FlowId, number>>(
    () => ({
      bike: flowsOn.bike ? committedCounts.bike : 0,
      migration: flowsOn.migration ? committedCounts.migration : 0,
    }),
    [flowsOn, committedCounts],
  )
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

  const addPanel = () => {
    setPanels((prev) => {
      if (prev.length >= MAX_PANELS) return prev
      const key = nextKey.current
      nextKey.current += 1
      return [...prev, { key, sourceId: DEFAULT_SOURCE.meta.id }]
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

        <div className={styles.toolbar}>
          <div className={styles.flowToggles} role="group" aria-label="Particle flows">
            {FLOWS.map((flow) => (
              <div className={styles.flowControl} key={flow.id}>
                <label className={styles.syncToggle}>
                  <input
                    type="checkbox"
                    className={styles.syncCheckbox}
                    checked={flowsOn[flow.id]}
                    onChange={() => setFlowsOn((prev) => ({ ...prev, [flow.id]: !prev[flow.id] }))}
                  />
                  <span
                    className={styles.flowSwatch}
                    style={{ background: flow.color }}
                    aria-hidden="true"
                  />
                  <span>{flow.label}</span>
                </label>
                <input
                  type="range"
                  className={styles.slider}
                  min={FLOW_COUNT_MIN}
                  max={FLOW_COUNT_MAX}
                  step={FLOW_COUNT_STEP}
                  value={flowCounts[flow.id]}
                  disabled={!flowsOn[flow.id]}
                  aria-label={`${flow.label} particles per panel`}
                  onChange={(e) =>
                    setFlowCounts((prev) => ({ ...prev, [flow.id]: Number(e.target.value) }))
                  }
                  onDoubleClick={() =>
                    setFlowCounts((prev) => ({ ...prev, [flow.id]: DEFAULT_FLOW_COUNTS[flow.id] }))
                  }
                />
                <span className={styles.flowCount}>{flowCounts[flow.id]}</span>
              </div>
            ))}
          </div>
          <label className={styles.syncToggle}>
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

                <div className={styles.canvas}>
                  <TerrainPanel
                    source={source}
                    flows={flows}
                    activePanels={panels.length}
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
