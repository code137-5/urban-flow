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
 * PAD_METERS covers the widest 3σ among the sensor datasets — temperature's own
 * σ = 1200 m (src/data/sources/index.ts) → 3600 m. Raise it in step if any of
 * those σ go above ~1300 m; measured sample-density ripple inside SEOUL_BOUNDS
 * is 7.5% at 2000 m of pad and 0.25% at 4000 m.
 */
const CELL_METERS = 500
const PAD_METERS = 4000

export const temperatureJob: DatasetJob = {
  id: 'temperature',
  cellMeters: CELL_METERS,
  aggregation: 'mean',
  clip: false,
  padMeters: PAD_METERS,
  toCells: (bounds) =>
    sensorsToCells(sensorsPath('temperature'), 'temperature_median', bounds, CELL_METERS),
}
