/**
 * Best-effort browser/platform sniffing, used only to phrase the WebGL-failure
 * fallback (see TerrainPanel). Some mobile GPU drivers — most notably Chrome on
 * Android via ANGLE — reject the ANGLE-translated terrain shaders even though the
 * source is spec-valid. When that happens we keep the SVG fallback on screen and
 * suggest a browser more likely to render the 3D terrain.
 *
 * UA sniffing is intentionally coarse: it never gates rendering (the real probe
 * in terrainSupport.ts does that), it only picks friendlier copy for the notice.
 */

export type Platform = 'ios' | 'android' | 'macos' | 'windows' | 'other'
export type Browser = 'chrome' | 'edge' | 'safari' | 'firefox' | 'samsung' | 'other'

function ua(): string {
  return typeof navigator !== 'undefined' ? navigator.userAgent : ''
}

export function detectPlatform(): Platform {
  const s = ua()
  // iPadOS 13+ reports a desktop-Mac UA, so also treat a touch-capable Mac as iOS.
  const touchMac =
    /Macintosh/.test(s) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1
  if (/iPad|iPhone|iPod/.test(s) || touchMac) return 'ios'
  if (/Android/.test(s)) return 'android'
  if (/Mac OS X|Macintosh/.test(s)) return 'macos'
  if (/Windows/.test(s)) return 'windows'
  return 'other'
}

export function isMobile(): boolean {
  const p = detectPlatform()
  return p === 'ios' || p === 'android'
}

/**
 * Which browser the page is running in. Order matters: Edge/Samsung UA strings
 * also contain "Chrome" and "Safari", and Chrome's contains "Safari", so the more
 * specific tokens must be tested first.
 */
export function currentBrowser(): Browser {
  const s = ua()
  if (/Edg(A|iOS)?\//.test(s)) return 'edge' // Edg/ (desktop), EdgA/ (Android), EdgiOS/
  if (/SamsungBrowser/.test(s)) return 'samsung'
  if (/Firefox|FxiOS/.test(s)) return 'firefox'
  if (/CriOS|Chrome|CrMo/.test(s)) return 'chrome'
  if (/Safari/.test(s)) return 'safari'
  return 'other'
}

const DISPLAY_NAME: Record<Browser, string> = {
  chrome: 'Chrome',
  edge: 'Microsoft Edge',
  safari: 'Safari',
  firefox: 'Firefox',
  samsung: 'Samsung Internet',
  other: 'this browser',
}

/**
 * Alternative browsers to recommend when the terrain shader won't compile here,
 * tailored to the platform and excluding the one already in use. Safari is only
 * offered where it exists (Apple platforms); Edge is the cross-platform pick.
 */
export function suggestedBrowsers(): string[] {
  const platform = detectPlatform()
  const current = currentBrowser()
  const base =
    platform === 'ios' || platform === 'macos'
      ? ['Safari', 'Microsoft Edge']
      : ['Microsoft Edge', 'Firefox']
  const filtered = base.filter((name) => name !== DISPLAY_NAME[current])
  return filtered.length ? filtered : base
}

/** Human-readable "A or B" list of the suggested browsers. */
export function suggestedBrowsersText(): string {
  const list = suggestedBrowsers()
  if (list.length <= 1) return list[0] ?? 'another browser'
  return `${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}`
}
