import { mulberry32 } from '../data/trips'
import type { Trip, TripSource } from '../data/trips'
import { TripQueue } from './tripQueue'

/**
 * Which trip every particle slot is playing, and since when — on one clock.
 *
 * A particle's position is a pure function of (trip, startAt, time), so layers
 * that mirror the same schedule draw the same particles at the same places at
 * the same moment, whichever panel they are in and whenever it was added. That
 * is what makes dashboard panels comparable: panels with identical flow
 * settings — the same (flow, hour window, speed, time scale), which is the
 * shared-schedule key — play one schedule and move in lockstep, so only the
 * terrain under the particles differs. A panel with its own window runs its own
 * schedule. Each WebGL context still runs its own transform — GPU buffers cannot
 * be shared across deck.gl instances — but every layer on a schedule evaluates
 * the same table.
 *
 * Schedules are refcounted by the panels that mirror them (`retainTripSchedule`
 * / `releaseTripSchedule`) and disposed — queue and source — once the last one
 * lets go, so a window nobody shows any more stops fetching.
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
  private readonly source: TripSource
  private readonly timeScale: number
  private readonly rand = mulberry32(0x5e0e1) // fixed seed — reproducible screenshots
  private growing: Promise<void> = Promise.resolve()
  private clock = 0
  private lastTick = performance.now() / 1000

  /** `timeScale` is a playback multiplier on trip durations: 2 = twice as fast. */
  constructor(source: TripSource, timeScale = 1) {
    this.source = source
    this.queue = new TripQueue(source)
    this.timeScale = timeScale
  }

  /**
   * Tear the schedule down: the queue stops fetching and hands out nothing more,
   * and the source lets go of whatever it holds page-wide (an OD reservoir lease
   * and its refresh timer). Layers still holding the object keep replaying their
   * last trips until they are rebuilt, which is harmless. Called by the shared
   * registry once the last panel has released it; idempotent.
   */
  dispose(): void {
    this.queue.dispose()
    this.source.dispose?.()
  }

  /** The source ran dry (an hour window that failed to load): see TripQueue.parked. */
  get parked(): boolean {
    return this.queue.parked
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
        // Spread the departures so new slots don't all leave at once. The first
        // swarm gets a head start (the page opens on traffic already under way);
        // slots added to a swarm that exists — a panel lowered its
        // trips-per-particle — leave from their origins over the coming
        // trip-length rather than popping up mid-route.
        const spread = this.rand() * this.playbackSeconds(trip)
        this.assign(p, trip, from === 0 ? this.clock - spread : this.clock + spread)
      }
    })
    return this.growing
  }

  /**
   * Throw away the prefetched trips so the next slot to finish gets one from the
   * source's new answer — today, the `?tune` scatter knob moved. (An hour window
   * change is not a flush: the window is part of the schedule key, so it is a
   * different schedule.)
   *
   * This is NOT a reset: the clock, the slot table and every trip in flight are
   * left alone, so the swarm never blanks and a slot simply switches answer when
   * it next lands. While the new batch loads, `queue.take()` returns null and
   * `tick()` replays the slot's current trip — nothing awaits, nothing stalls.
   *
   * Serialised behind `growing` so it cannot empty the pool underneath an
   * `ensure()` a just-added panel is awaiting. A schedule nothing plays yet stays
   * lazy: an empty slot table means no request goes out for it.
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
      if (this.endAt[p] > this.clock) continue
      this.assign(p, this.queue.take() ?? this.trips[p], this.clock)
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

/**
 * The page-wide schedule registry, keyed `${flow}|${from}-${to}|${speed}|${timeScale}`
 * — every panel setting that changes which trips are played or how fast. Panels
 * asking for the same key get the same schedule (lockstep); a panel with its own
 * hour window gets its own.
 *
 * Each entry counts the panels mirroring it. A fresh entry starts at 0 with the
 * reaper already armed, so a schedule that is made but never retained — a memo
 * whose component never committed — still goes away; the first `retain` cancels
 * it. The last `release` re-arms it, and after `SCHEDULE_GRACE_MS` the schedule
 * is disposed and dropped. The grace absorbs React StrictMode's mount → unmount
 * → mount and a panel's settings changing key twice in quick succession without
 * tearing down a reservoir lease that is about to be wanted again.
 */
interface SharedEntry {
  schedule: TripSchedule
  refs: number
  reaper: ReturnType<typeof setTimeout> | null
}

const shared = new Map<string, SharedEntry>()

/** How long an unreferenced schedule survives before it is disposed. */
export const SCHEDULE_GRACE_MS = 1000

function armReaper(key: string, entry: SharedEntry): void {
  if (entry.reaper !== null) return
  entry.reaper = setTimeout(() => {
    entry.reaper = null
    // Still ours and still unwanted? (A retain in the meantime cleared the timer,
    // but be safe against a stale closure either way.)
    if (shared.get(key) !== entry || entry.refs > 0) return
    shared.delete(key)
    entry.schedule.dispose()
  }, SCHEDULE_GRACE_MS)
}

/**
 * Get or create the schedule for `key`, so every panel asking for it plays
 * identical particles. Creating does not retain: pair it with
 * `retainTripSchedule` / `releaseTripSchedule` from an effect (effects balance
 * under StrictMode; memos don't), or the entry is reaped after the grace period.
 * A parked schedule (its window failed to load) that nobody holds is replaced
 * rather than handed back, so re-selecting that window retries; while a panel
 * still holds it, it stays parked.
 */
export function sharedTripSchedule(key: string, make: () => TripSchedule): TripSchedule {
  let entry = shared.get(key)
  if (entry && entry.refs === 0 && entry.schedule.parked) {
    if (entry.reaper !== null) clearTimeout(entry.reaper)
    shared.delete(key)
    entry.schedule.dispose()
    entry = undefined
  }
  if (!entry) {
    entry = { schedule: make(), refs: 0, reaper: null }
    shared.set(key, entry)
    armReaper(key, entry)
  }
  return entry.schedule
}

/** One more panel mirrors `key`: cancels a pending reap. No-op for an unknown key. */
export function retainTripSchedule(key: string): void {
  const entry = shared.get(key)
  if (!entry) return
  entry.refs += 1
  if (entry.reaper !== null) {
    clearTimeout(entry.reaper)
    entry.reaper = null
  }
}

/**
 * One panel stopped mirroring `key`. At zero the reaper is armed: unless
 * something retains it again within `SCHEDULE_GRACE_MS`, the schedule is
 * disposed and forgotten. No-op for an unknown key; never goes below zero.
 */
export function releaseTripSchedule(key: string): void {
  const entry = shared.get(key)
  if (!entry) return
  entry.refs = Math.max(0, entry.refs - 1)
  if (entry.refs === 0) armReaper(key, entry)
}

/**
 * Flush every shared schedule — how the `?tune` scatter knob applies a new
 * answer without touching the schedule keys, which would rebuild every
 * ParticleLayer and blank the swarm. `prefix` limits it to one flow's
 * schedules, e.g. `'bike|'`.
 */
export function flushSharedTripSchedules(prefix?: string): void {
  for (const [key, entry] of shared) {
    if (prefix === undefined || key.startsWith(prefix)) entry.schedule.flush()
  }
}
