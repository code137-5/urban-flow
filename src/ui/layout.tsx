import type { CSSProperties, ReactNode } from 'react'
import styles from './layout.module.css'

/** Max-width (1584px Carbon grid) centered wrapper with gutter padding. */
export function Container({
  children,
  className = '',
  style,
}: {
  children: ReactNode
  className?: string
  style?: CSSProperties
}) {
  return (
    <div className={`${styles.container} ${className}`} style={style}>
      {children}
    </div>
  )
}

/**
 * Vertical page section. `divided` adds a top hairline; `id` enables anchor
 * scrolling (e.g. the Hero CTA scrolling to the dashboard).
 */
export function Section({
  children,
  id,
  divided = false,
  className = '',
  style,
}: {
  children: ReactNode
  id?: string
  divided?: boolean
  className?: string
  style?: CSSProperties
}) {
  return (
    <section
      id={id}
      className={`${styles.section} ${divided ? styles.divided : ''} ${className}`}
      style={style}
    >
      {children}
    </section>
  )
}

/** Sentence-case eyebrow label (Carbon resists all-caps tracked eyebrows). */
export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className={styles.eyebrow}>{children}</p>
}
