import type { DataSource, DatasetId } from '../types'
import { ttareungiSource } from './ttareungi'
import { saenghwalIdongSource } from './saenghwalIdong'
import { subwaySource } from './subway'

/**
 * Registry of available datasets. Add a new dataset by writing a `DataSource`
 * adapter and appending it here — the pipeline and UI pick it up automatically.
 */
export const SOURCES: readonly DataSource[] = [
  ttareungiSource,
  saenghwalIdongSource,
  subwaySource,
]

export const DEFAULT_SOURCE = SOURCES[0]

export const getSource = (id: DatasetId): DataSource | undefined =>
  SOURCES.find((s) => s.meta.id === id)
