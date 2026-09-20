import { mulberry32 } from '../data/trips'
import type { Trip, TripSource } from '../data/trips'
import { TripQueue } from './tripQueue'

/**
 * Which trip every particle slot is playing, and since when — on one clock.
 *
 * A particle's position is a pure function of (trip, startAt, time), so layers
 * that mirror the same schedule draw the same particles at the same places at
 * the same moment, whichever panel they are in and whenever it was added. That
 * is what makes the dashboard panels comparable: only the terrain under the
 * particles differs. Each WebGL context still runs its own transform — GPU
 * buffers cannot be shared across deck.gl instances — but they all evaluate the
 * same table.
 *
 * The clock only advances while some layer is ticking it (dt clamped like the
 * old per-layer simTime), so it freezes when every panel is paused and nothing
 * jumps on resume. A layer that was paused alone catches up by re-reading the
 * slots whose `versions` moved on.
 */
export class TripSchedule {
  /** Per slot: current trip, its playback seconds, clock time it started, change counter. */
  readonly trips: Trip[] = []
  readonly durations: number[] = []
  readonly startAt: number[] = []
  readonly versions: number[] = []
  private readonly endAt: number[] = []
  private readonly queue: TripQueue
  private readonly timeScale: number
  private readonly rand = mulberry32(0x5e0e1) // fixed seed — reproducible screenshots
  private growing: Promise<void> = Promise.resolve()
  private clock = 0
  private lastTick = performance.now() / 1000

  /** `timeScale` is a playback multiplier on trip durations: 2 = twice as fast. */
  constructor(source: TripSource, timeScale = 1) {
    this.queue = new TripQueue(source)
    this.timeScale = timeScale
  }

  /** Resolves once slots [0, n) are playing (or the source had nothing to give). */
  ensure(n: number): Promise<void> {
    this.growing = this.growing.then(async () => {
      const from = this.trips.length
      if (n <= from) return
      await this.queue.prime(n - from)
      let last: Trip | null = this.trips[from - 1] ?? null
      for (let p = from; p < n; p++) {
        const trip: Trip | null = this.queue.take() ?? last
        if (!trip) break
        last = trip
        // Random head start so new slots don't all depart at once.
        this.assign(p, trip, this.clock - this.rand() * this.playbackSeconds(trip))
      }
    })
    return this.growing
  }

  /**
   * Throw away the prefetched trips so the next slot to finish gets one from the
   * source's new answer — today, the page-wide OD hour window moved.
   *
   * This is NOT a reset: the clock, the slot table and every trip in flight are
   * left alone, so the swarm never blanks and a slot simply switches window when
   * it next lands. While the new reservoir loads, `queue.take()` returns null and
   * `tick()` replays the slot's current trip — nothing awaits, nothing stalls.
   *
   * Serialised behind `growing` so it cannot empty the pool underneath an
   * `ensure()` a just-added panel is awaiting. A schedule nothing plays yet stays
   * lazy: TerrainPanel builds one per flow, including flows that are toggled off,
   * and an empty slot table means no request goes out for them.
   */
  flush(): void {
    this.growing = this.growing.then(() => {
      if (this.trips.length === 0) return
      this.queue.flush()
    })
  }

  /**
   * Advance the clock and hand finished slots their next trip. Every layer calls
   * this each step; the deltas between calls add up to real time. Without a trip
   * ready, a slot replays its current one.
   */
  tick(): number {
    const real = performance.now() / 1000
    this.clock += Math.min(Math.max(real - this.lastTick, 0), 0.05)
    this.lastTick = real
    for (let p = 0; p < this.trips.length; p++) {
      if (this.endAt[p] <= this.clock) this.assign(p, this.queue.take() ?? this.trips[p], this.clock)
    }
    return this.clock
  }

  private playbackSeconds(trip: Trip): number {
    return Math.max(trip.durationSec, 1e-3) / this.timeScale
  }

  private assign(p: number, trip: Trip, startAt: number) {
    const duration = this.playbackSeconds(trip)
    this.trips[p] = trip
    this.durations[p] = duration
    this.startAt[p] = startAt
    this.endAt[p] = startAt + duration
    this.versions[p] = (this.versions[p] ?? 0) + 1
  }
}

const shared = new Map<string, TripSchedule>()

/** Same key → same schedule, so every panel asking for it plays identical particles. */
export function sharedTripSchedule(key: string, make: () => TripSchedule): TripSchedule {
  let schedule = shared.get(key)
  if (!schedule) {
    schedule = make()
    shared.set(key, schedule)
  }
  return schedule
}

/**
 * Flush every shared schedule — how the dashboard applies a new OD hour window
 * without touching the schedule keys (`${flow}|${speed}|${timeScale}`), which
 * would rebuild every ParticleLayer and blank the swarm. `prefix` limits it to one
 * flow's schedules, e.g. `'bike|'`.
 */
export function flushSharedTripSchedules(prefix?: string): void {
  for (const [key, schedule] of shared) {
    if (prefix === undefined || key.startsWith(prefix)) schedule.flush()
  }
}
