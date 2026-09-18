import type { DataSource, DatasetId } from '../types'
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
    kdeSigmaMeters: 600, // real relief; the 1800 default is tuned for density blobs
  }),
  staticSource({
    id: 'temperature',
    label: 'Temperature (기온)',
    description: 'Air temperature, 2023 yearly median per S-DoT sensor',
    unit: '°C',
    accent: '#4589ff', // IBM Blue 50
    kdeSigmaMeters: 1200, // ~12 sensors fall inside σ, enough to average out microsite scatter
  }),
  staticSource({
    id: 'noise',
    label: 'Noise (소음)',
    description: 'Ambient noise, 2023 yearly median per S-DoT sensor',
    unit: 'dB',
    accent: '#78a9ff', // IBM Blue 40
    kdeSigmaMeters: 700, // tight on purpose: keeps the road-corridor structure legible
  }),
  staticSource({
    id: 'humidity',
    label: 'Humidity (습도)',
    description: 'Relative humidity, 2023 yearly median per S-DoT sensor',
    unit: '%RH',
    accent: '#a6c8ff', // IBM Blue 30
    kdeSigmaMeters: 1000, // readings are coarsely quantized, so they need extra smoothing
  }),
  staticSource({
    id: 'population',
    label: 'Population (인구)',
    description: 'Resident population, 2024 SGIS 100 m grid',
    unit: 'people / 250 m cell',
    accent: '#0043ce', // IBM Blue 70
    kdeSigmaMeters: 800, // district-scale relief; keeps the Han and the mountains as gaps
  }),
  staticSource({
    id: 'companies',
    label: 'Businesses (사업체)',
    description: 'Business establishments, 2024 SGIS 100 m grid',
    unit: 'businesses / 250 m cell',
    accent: '#002d9c', // IBM Blue 80
    kdeSigmaMeters: 700, // tighter than population: commercial corridors are narrow
  }),
]

/**
 * Parked: synthetic placeholder datasets, kept out of the registry until real
 * data exists. Their adapters (`ttareungi`, `saenghwalIdong`, `subway`) and
 * public/data JSONs stay on disk, and their ids stay in `DatasetId`:
 *   ttareungi · saenghwal-idong · subway · saenghwal-ingu ·
 *   building-density · residential-density · commercial-density
 * To bring one back: re-import its adapter (or re-add its `staticSource({...})`
 * entry above) and list it in `SOURCES`.
 */

/**
 * Registry of available datasets. Add a new dataset by writing a `DataSource`
 * adapter and appending it here — the pipeline and UI pick it up automatically.
 * Order (dem first) sets the dashboard's default panel dataset.
 */
export const SOURCES: DataSource[] = [...preprocessedSources]

export const DEFAULT_SOURCE = SOURCES[0]

export const getSource = (id: DatasetId): DataSource | undefined =>
  SOURCES.find((s) => s.meta.id === id)
