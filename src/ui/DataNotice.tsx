import { useEffect, useRef, useState } from 'react'
import { Button } from './Button'
import styles from './DataNotice.module.css'

/**
 * Load-time data-source notice: where the four dashboard datasets come from —
 * Seoul's elevation contour lines, and 2023 yearly medians from the S-DoT
 * sensor network interpolated between sensors. Shown on EVERY page load /
 * new window (no dismissal persistence — per product decision).
 * Carbon Gray 100 dialog — flat 0px corners, hairline border, no shadow.
 */
export function DataNotice() {
  const [open, setOpen] = useState(true)
  const buttonRef = useRef<HTMLDivElement | null>(null)

  const dismiss = () => setOpen(false)

  // Focus the confirm button on open; ESC dismisses.
  useEffect(() => {
    if (!open) return
    buttonRef.current?.querySelector('button')?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null

  return (
    <div className={styles.overlay} role="presentation" onClick={dismiss}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="data-notice-title"
        onClick={(e) => e.stopPropagation()}
      >
        <p className={styles.eyebrow}>Notice</p>
        <h2 id="data-notice-title" className={styles.title}>
          Where this data comes from
        </h2>
        <p className={styles.body}>
          <strong>Elevation (DEM)</strong> is rasterized from Seoul's elevation contour
          lines. <strong>Temperature</strong>, <strong>Noise</strong> and{' '}
          <strong>Humidity</strong> are 2023 yearly medians from the S-DoT city sensor
          network, interpolated between roughly 800–900 sensors. Values far from any sensor
          — the mountains, the airport, the river margins — are therefore estimates.
        </p>
        <div className={styles.actions} ref={buttonRef}>
          <Button variant="primary" onClick={dismiss}>
            Got it
          </Button>
        </div>
      </div>
    </div>
  )
}
