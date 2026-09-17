import type { DatasetJob } from '../job.ts'
import { sensorsPath, sensorsToCells } from '../sensors.ts'

/**
 * Humidity (습도, %RH) — 2023 yearly median per S-DoT sensor, resampled from
 * ~780 scattered sites onto the grid by IDW (see sensors.ts). Same shape as the
 * temperature job: 'mean' is a pass-through, 500 m cells match the sensor
 * spacing, unclipped + padded so the KDE has samples past the 자치구 border
 * (PAD_METERS kept uniform across the three — see temperature.ts).
 */
const CELL_METERS = 500
const PAD_METERS = 5000

export const humidityJob: DatasetJob = {
  id: 'humidity',
  cellMeters: CELL_METERS,
  aggregation: 'mean',
  clip: false,
  padMeters: PAD_METERS,
  toCells: (bounds) =>
    sensorsToCells(sensorsPath('humidity'), 'humidity_median', bounds, CELL_METERS),
}
