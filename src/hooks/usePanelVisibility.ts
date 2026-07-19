import { useEffect, useState } from 'react'

/**
 * Gates a panel's particle animation: on only while the panel intersects the
 * viewport (±100px), the tab is visible, and the user hasn't asked for reduced
 * motion. With up to 6 dashboard panels this is what keeps off-screen contexts
 * completely idle — attach the ref to any element filling the panel.
 */
export function usePanelVisibility(): {
  ref: (node: HTMLElement | null) => void
  animate: boolean
} {
  const [node, setNode] = useState<HTMLElement | null>(null)
  const [inView, setInView] = useState(true)
  const [pageVisible, setPageVisible] = useState(
    () => typeof document === 'undefined' || !document.hidden,
  )
  const [reducedMotion, setReducedMotion] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )

  useEffect(() => {
    if (!node) return
    const observer = new IntersectionObserver(
      (entries) => setInView(entries[0]?.isIntersecting ?? true),
      { rootMargin: '100px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [node])

  useEffect(() => {
    const onVisibility = () => setPageVisible(!document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onMq = (e: MediaQueryListEvent) => setReducedMotion(e.matches)
    mq.addEventListener('change', onMq)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      mq.removeEventListener('change', onMq)
    }
  }, [])

  return { ref: setNode, animate: inView && pageVisible && !reducedMotion }
}
