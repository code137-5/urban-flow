import type { DataSource, DatasetId } from '../types'
import { ttareungiSource } from './ttareungi'
import { saenghwalIdongSource } from './saenghwalIdong'
import { subwaySource } from './subway'
import { staticSource } from './staticSource'

/**
 * Preprocessed datasets loaded from public/data/<id>.json (built by
 * scripts/preprocess). Each is a one-line `staticSource` — the domain field
 * mapping already happened in the preprocessing adapter, so here we only carry
 * display metadata. Accents stay in the IBM Blue family (DESIGN-ibm: one accent).
 */
const preprocessedSources: DataSource[] = [
  staticSource({
    id: 'dem',
    label: 'Elevation (DEM)',
    description: 'Seoul terrain elevation as contours',
    unit: 'meters',
    accent: '#0f62fe', // IBM Blue 60
  }),
  staticSource({
    id: 'saenghwal-ingu',
    label: 'Living population (생활인구)',
    description: 'De-facto population present by area',
    unit: 'people',
    accent: '#4589ff', // IBM Blue 50
  }),
  staticSource({
    id: 'jumin-ingu',
    label: 'Registered population (주민등록인구)',
    description: 'Resident population by home address',
    unit: 'residents',
    accent: '#78a9ff', // IBM Blue 40
  }),
  staticSource({
    id: 'building-density',
    label: 'Building floor-area density (건축연면적)',
    description: 'Gross building floor area per area',
    unit: 'ratio',
    accent: '#a6c8ff', // IBM Blue 30
  }),
  staticSource({
    id: 'residential-density',
    label: 'Residential floor-area density (주거면적)',
    description: 'Housing floor area per area',
    unit: 'ratio',
    accent: '#0043ce', // IBM Blue 70
  }),
  staticSource({
    id: 'commercial-density',
    label: 'Commercial floor-area density (상업면적)',
    description: 'Commercial floor area per area',
    unit: 'ratio',
    accent: '#d0e2ff', // IBM Blue 20
  }),
]

/**
 * Registry of available datasets. Add a new dataset by writing a `DataSource`
 * adapter and appending it here — the pipeline and UI pick it up automatically.
 * Order (ttareungi first) sets the dashboard's default panel dataset.
 */
export const SOURCES: DataSource[] = [
  ttareungiSource,
  saenghwalIdongSource,
  subwaySource,
  ...preprocessedSources,
]

export const DEFAULT_SOURCE = SOURCES[0]

export const getSource = (id: DatasetId): DataSource | undefined =>
  SOURCES.find((s) => s.meta.id === id)
