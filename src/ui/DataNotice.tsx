import { useEffect, useRef, useState } from 'react'
import { Button } from './Button'
import styles from './DataNotice.module.css'

/**
 * Load-time notice: every dataset on the dashboard is currently synthetic,
 * to be swapped for real Seoul open data one by one. Shown on EVERY page
 * load / new window (no dismissal persistence — per product decision).
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
          Sample data, for now
        </h2>
        <p className={styles.body}>
          Every dataset on this dashboard is currently <strong>synthetic</strong> — generated
          to demonstrate the contour terrain and particle flow. It will be replaced with real
          Seoul open data (따릉이 bike share, living migration, subway ridership, and more),
          one dataset at a time.
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
