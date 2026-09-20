import { useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import styles from './RangeSlider.module.css'

export interface RangeSliderProps {
  min: number
  max: number
  step?: number
  /** Smallest allowed distance between the two thumbs. Defaults to `step`. */
  minGap?: number
  value: readonly [number, number]
  /** Fires only when a clamped value actually changes. */
  onChange: (next: [number, number]) => void
  disabled?: boolean
  /** aria-valuetext + bound labels. Default String(v). */
  formatValue?: (v: number) => string
  /** Flanking min/max labels, when they want to read shorter than the thumbs. */
  formatBound?: (v: number) => string
  /** Accessible names for [lower, upper] thumbs. */
  ariaLabels: readonly [string, string]
  /** Hairline marks at these values. No labels drawn. */
  ticks?: readonly number[]
  /** Flanking min/max labels (Carbon slider). Default true. */
  showBounds?: boolean
  /** Called on a double-click of the track; omit to disable reset. */
  onReset?: () => void
  className?: string
}

/**
 * Snap `raw` onto the step grid anchored at `min`, then clamp into [lo, hi].
 * The toFixed round-trip keeps fractional steps clean (0.1 + 3 * 0.1 is not 0.4
 * in binary floating point); the gap clamp wins over the grid, so a thumb pushed
 * against its neighbour parks exactly `minGap` away even off-grid.
 */
function snapClamp(raw: number, min: number, step: number, lo: number, hi: number): number {
  const snapped = Number((min + Math.round((raw - min) / step) * step).toFixed(6))
  return Math.min(hi, Math.max(lo, snapped))
}

/**
 * Two-thumb range slider, Carbon dark: 2px rail, 14px square thumbs, 0px corners.
 *
 * Fully controlled — it holds no copy of the value, only which thumb was touched
 * last (that one is lifted so its focus ring is not clipped when the thumbs
 * touch). The track owns all pointer work and the thumbs are `pointer-events:
 * none`, so a press anywhere grabs the nearest thumb and drags it; overlaid
 * native range inputs cannot do that (the top one swallows the other's hits).
 * Thumbs block against each other at `minGap` — they never push.
 *
 * Renders bounds + track only. Labels and readouts are the caller's composition.
 */
export function RangeSlider({
  min,
  max,
  step = 1,
  minGap = step,
  value,
  onChange,
  disabled = false,
  formatValue = (v) => String(v),
  formatBound,
  ariaLabels,
  ticks,
  showBounds = true,
  onReset,
  className,
}: RangeSliderProps) {
  const [lower, upper] = value
  const [active, setActive] = useState<0 | 1 | null>(null)
  const geometryRef = useRef<HTMLDivElement | null>(null)
  const thumbRefs = useRef<Array<HTMLDivElement | null>>([null, null])
  // Set between pointerdown and pointerup/-cancel: which thumb is being dragged
  // and the pointer that grabbed it, so a second finger cannot hijack the drag.
  const dragRef = useRef<{ index: 0 | 1; pointerId: number } | null>(null)

  const span = max - min
  const pct = (v: number) => (span > 0 ? ((v - min) / span) * 100 : 0)
  const boundLabel = formatBound ?? formatValue

  /** Move one thumb, clamped by the other, and report only a real change. */
  const commit = (index: 0 | 1, raw: number) => {
    const next: [number, number] = [lower, upper]
    next[index] =
      index === 0
        ? snapClamp(raw, min, step, min, upper - minGap)
        : snapClamp(raw, min, step, lower + minGap, max)
    if (next[0] !== lower || next[1] !== upper) onChange(next)
  }

  /** Un-snapped value under a client x, measured against the geometry box. */
  const valueAt = (clientX: number): number => {
    const box = geometryRef.current?.getBoundingClientRect()
    if (!box || box.width === 0) return lower
    const ratio = Math.min(1, Math.max(0, (clientX - box.left) / box.width))
    return min + ratio * span
  }

  /**
   * Left of the window grabs the lower thumb, right of it the upper; inside, the
   * nearer one — a tie goes to the upper thumb, which also keeps a press on two
   * coincident thumbs from deadlocking against the lower one's gap clamp.
   */
  const nearestThumb = (v: number): 0 | 1 => {
    if (v <= lower) return 0
    if (v >= upper) return 1
    return v - lower < upper - v ? 0 : 1
  }

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return
    const raw = valueAt(e.clientX)
    const index = nearestThumb(raw)
    dragRef.current = { index, pointerId: e.pointerId }
    e.currentTarget.setPointerCapture(e.pointerId)
    setActive(index)
    thumbRefs.current[index]?.focus()
    commit(index, raw)
  }

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (disabled || drag === null || drag.pointerId !== e.pointerId) return
    commit(drag.index, valueAt(e.clientX))
  }

  const handlePointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== e.pointerId) return
    dragRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  // Arrows one step, Page keys three, Home/End the whole way — `commit` clamps
  // each against the other thumb, so Home/End land on this thumb's own bound.
  const handleKeyDown = (index: 0 | 1) => (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return
    const current = value[index]
    let target: number
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        target = current - step
        break
      case 'ArrowRight':
      case 'ArrowUp':
        target = current + step
        break
      case 'PageDown':
        target = current - 3 * step
        break
      case 'PageUp':
        target = current + 3 * step
        break
      case 'Home':
        target = min
        break
      case 'End':
        target = max
        break
      default:
        return
    }
    e.preventDefault()
    setActive(index)
    commit(index, target)
  }

  const handleDoubleClick = () => {
    if (!disabled) onReset?.()
  }

  const renderThumb = (index: 0 | 1) => {
    const v = value[index]
    return (
      <div
        key={index}
        ref={(el) => {
          thumbRefs.current[index] = el
        }}
        className={`${styles.thumb}${active === index ? ` ${styles.thumbActive}` : ''}`}
        style={{ left: `${pct(v)}%` }}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={ariaLabels[index]}
        aria-orientation="horizontal"
        aria-valuemin={index === 0 ? min : lower + minGap}
        aria-valuemax={index === 0 ? upper - minGap : max}
        aria-valuenow={v}
        aria-valuetext={formatValue(v)}
        aria-disabled={disabled || undefined}
        onKeyDown={handleKeyDown(index)}
        onFocus={() => setActive(index)}
      />
    )
  }

  const rootClass = [styles.root, disabled ? styles.disabled : '', className ?? '']
    .filter(Boolean)
    .join(' ')

  return (
    <div className={rootClass} role="group">
      {showBounds ? <span className={styles.bound}>{boundLabel(min)}</span> : null}
      <div
        className={styles.track}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
      >
        <div className={styles.geometry} ref={geometryRef}>
          <div className={styles.rail} />
          <div
            className={styles.fill}
            style={{ left: `${pct(lower)}%`, right: `${100 - pct(upper)}%` }}
          />
          {ticks?.map((t) => (
            <span key={t} className={styles.tick} style={{ left: `${pct(t)}%` }} aria-hidden="true" />
          ))}
          {renderThumb(0)}
          {renderThumb(1)}
        </div>
      </div>
      {showBounds ? <span className={styles.bound}>{boundLabel(max)}</span> : null}
    </div>
  )
}
