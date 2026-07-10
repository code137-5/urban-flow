import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { GeoPoint } from '../../src/data/types.ts'

const OUT_DIR = fileURLToPath(new URL('../../public/data/', import.meta.url))

/** Round to `d` decimals to keep the JSON compact without visible precision loss. */
function round(n: number, d: number): number {
  const f = 10 ** d
  return Math.round(n * f) / f
}

/**
 * Write GeoPoints to public/data/<id>.json (fetched at runtime by staticSource).
 * Coordinates keep 6 decimals (~0.1 m), weights 4 — plenty for a KDE surface,
 * and far smaller than raw float strings. Logs cell count + byte size.
 */
export function writeDataset(id: string, points: GeoPoint[]): void {
  mkdirSync(OUT_DIR, { recursive: true })
  const compact = points.map((p) => {
    const out: GeoPoint = {
      lng: round(p.lng, 6),
      lat: round(p.lat, 6),
      weight: round(p.weight, 4),
    }
    if (p.weightByHour) out.weightByHour = p.weightByHour.map((v) => round(v, 4))
    return out
  })
  const json = JSON.stringify(compact)
  const path = `${OUT_DIR}${id}.json`
  writeFileSync(path, json)
  const kb = (Buffer.byteLength(json) / 1024).toFixed(1)
  console.log(`  ${id}: ${points.length} cells → public/data/${id}.json (${kb} KB)`)
}
