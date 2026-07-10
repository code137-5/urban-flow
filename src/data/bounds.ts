// Explicit .ts extension so this module resolves under both the app project
// (bundler mode) and the scripts project (nodenext), which imports it.
import type { Bounds } from './types.ts'

/**
 * Seoul area of interest: [minLng, minLat, maxLng, maxLat].
 *
 * Lives in its own dependency-free module (no deck.gl) so the preprocessing
 * scripts under scripts/ can import it via tsx — src/config.ts pulls in
 * @deck.gl/core (WebMercatorViewport) and can't run in a plain Node context.
 * config.ts re-exports this so existing import paths keep working.
 */
export const SEOUL_BOUNDS: Bounds = [126.76, 37.42, 127.18, 37.7]
