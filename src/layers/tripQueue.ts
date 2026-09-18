import type { Trip, TripSource } from '../data/trips'

/**
 * Prefetch pool between a `TripSource` and the particle layer.
 *
 * Particles finish one at a time (~13/s for 400 particles on ~30 s trips), which
 * would be far too chatty as individual requests. The queue instead pulls
 * `batchSize` trips whenever it drops below `lowWater` — one request every
 * ~15 s at the default panel size — and hands them out synchronously via
 * `take()`. One request in flight at a time; a request that resolves after
 * `dispose()` is dropped.
 */
export class TripQueue {
  private pool: Trip[] = []
  private inFlight: Promise<void> | null = null
  private disposed = false
  /** Set once the source has returned an empty batch — stop hammering it. */
  private exhausted = false
  private warned = false
  private readonly source: TripSource
  private readonly opts: { batchSize?: number; lowWater?: number }

  constructor(source: TripSource, opts: { batchSize?: number; lowWater?: number } = {}) {
    this.source = source
    this.opts = opts
  }

  get size(): number {
    return this.pool.length
  }

  /** Pop one trip, or null if the pool is empty. Kicks off a refill when low. */
  take(): Trip | null {
    const lowWater = this.opts.lowWater ?? 100
    if (this.pool.length <= lowWater) void this.refill()
    const trip = this.pool.pop() ?? null
    if (trip === null && !this.warned) {
      this.warned = true
      console.warn('[urban-flow] trip source has no trips ready; particles re-loop their last trip')
    }
    return trip
  }

  /** Initial fill: resolves once at least `n` trips are pooled or the source dries up. */
  async prime(n: number): Promise<void> {
    while (this.pool.length < n && !this.exhausted && !this.disposed) {
      await this.refill(n - this.pool.length)
    }
  }

  dispose(): void {
    this.disposed = true
    this.pool = []
  }

  private refill(count = this.opts.batchSize ?? 200): Promise<void> {
    if (this.inFlight) return this.inFlight
    if (this.exhausted || this.disposed) return Promise.resolve()
    this.inFlight = this.source
      .next(Math.max(count, this.opts.batchSize ?? 200))
      .then(
        (trips) => {
          if (this.disposed) return
          if (trips.length === 0) this.exhausted = true
          // Reverse so `pop()` hands trips out in source order.
          for (let i = trips.length - 1; i >= 0; i--) this.pool.push(trips[i])
        },
        (err: unknown) => {
          console.warn('[urban-flow] trip source failed:', err)
        },
      )
      .finally(() => {
        this.inFlight = null
      })
    return this.inFlight
  }
}
