import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { RawCell } from './grid.ts'

const RAW_DIR = fileURLToPath(new URL('../../data/raw/', import.meta.url))

/**
 * Read a raw CSV from data/raw/<name>.csv into RawCells.
 *
 * Header layout: `lng,lat,value` (+ optional `h0..h23` for hourly datasets).
 * This is the shared reader; each dataset adapter decides what `value` *means*
 * and how it's aggregated — the domain mapping lives in the adapter, not here.
 */
export function readRawCsv(name: string): RawCell[] {
  const text = readFileSync(`${RAW_DIR}${name}.csv`, 'utf8').trim()
  const lines = text.split(/\r?\n/)
  const hasHourly = lines[0].split(',').length >= 27 // lng,lat,value,h0..h23
  return lines.slice(1).map((line) => {
    const c = line.split(',').map(Number)
    const cell: RawCell = { lng: c[0], lat: c[1], value: c[2] }
    if (hasHourly) cell.valueByHour = c.slice(3, 27)
    return cell
  })
}
