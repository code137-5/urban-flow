import type { DatasetJob } from '../job.ts'
import { sensorsPath, sensorsToCells } from '../sensors.ts'

/**
 * Temperature (기온, °C) — 2023 yearly median per S-DoT sensor, resampled from
 * ~800 scattered sites onto the grid by IDW (see sensors.ts). 'mean' is a
 * pass-through: the resampler already emits one sample per cell.
 * 500 m cells match the sensor spacing — finer would only interpolate air.
 * Not clipped, and padded: the whole range is ~13–21 °C, so a truncation rim at
 * the border would set the frontend's percentile floor and flatten the map.
 *
 * PAD_METERS covers the widest KDE cutoff (4σ, src/data/heightmap.ts) among the
 * sensor datasets — temperature's own σ = 1200 m (src/data/sources/index.ts) →
 * 4800 m. Raise it in step if any of those σ go above 1250 m.
 *
 * IDW reaches wider than the sensors.ts defaults: the city spans ~2 °C while
 * neighbouring sites disagree by ±0.5 °C, so a dozen-site average still carries
 * single-site scatter. 40 sites / ε = 800 m keeps the district-scale heat island
 * and drops the speckle.
 */
const CELL_METERS = 500
const PAD_METERS = 5000
const IDW = { neighbours: 40, epsilonMeters: 800 }

export const temperatureJob: DatasetJob = {
  id: 'temperature',
  cellMeters: CELL_METERS,
  aggregation: 'mean',
  clip: false,
  padMeters: PAD_METERS,
  toCells: (bounds) =>
    sensorsToCells(sensorsPath('temperature'), 'temperature_median', bounds, CELL_METERS, IDW),
}
