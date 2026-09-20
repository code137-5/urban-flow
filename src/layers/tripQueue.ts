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
 *
 * `flush()` throws the pool away when what the source would answer has changed
 * (the page-wide OD hour window); everything in flight at that moment belongs to
 * the old answer and is discarded too, which `generation` keeps track of.
 */
export class TripQueue {
  private pool: Trip[] = []
  private inFlight: Promise<void> | null = null
  private disposed = false
  /** Set once the source has returned an empty batch — stop hammering it. */
  private exhausted = false
  private warned = false
  /** Bumped by `flush()`; a request from an older generation is thrown away. */
  private generation = 0
  /** True from a `flush()` until its refill lands — an empty pool is expected then. */
  private flushing = false
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
    if (trip === null && !this.warned && !this.flushing) {
      this.warned = true
      console.warn('[urban-flow] trip source has no trips ready; particles re-loop their last trip')
    }
    return trip
  }

  /** Initial fill: resolves once at least `n` trips are pooled or the source dries up. */
  async prime(n: number): Promise<void> {
    const gen = this.generation
    while (this.pool.length < n && !this.exhausted && !this.disposed && gen === this.generation) {
      await this.refill(n - this.pool.length)
    }
  }

  /**
   * Drop every prefetched trip because the source now answers something else —
   * today, the page-wide OD hour window moved. A request already in flight was
   * asked under the old window, so its result is discarded when it lands, and a
   * fresh one goes out immediately. Particles already flying are untouched: they
   * finish their trip and pick up the new window afterwards.
   *
   * The pool is legitimately empty for one round trip afterwards, so `flushing`
   * keeps the dry-source warning quiet until the refill lands.
   */
  flush(): void {
    this.generation += 1
    this.flushing = true
    this.pool = []
    this.exhausted = false
    this.inFlight = null
    void this.refill()
  }

  dispose(): void {
    this.disposed = true
    this.pool = []
  }

  private refill(count = this.opts.batchSize ?? 200): Promise<void> {
    if (this.inFlight) return this.inFlight
    if (this.exhausted || this.disposed) return Promise.resolve()
    const gen = this.generation
    this.inFlight = this.source
      .next(Math.max(count, this.opts.batchSize ?? 200))
      .then(
        (trips) => {
          if (this.disposed || gen !== this.generation) return
          this.flushing = false
          if (trips.length === 0) this.exhausted = true
          // Reverse so `pop()` hands trips out in source order.
          for (let i = trips.length - 1; i >= 0; i--) this.pool.push(trips[i])
        },
        (err: unknown) => {
          console.warn('[urban-flow] trip source failed:', err)
        },
      )
      .finally(() => {
        // Only our own generation may clear the slot: a stale request landing
        // after a flush would otherwise null the *new* inFlight and let a second
        // request go out for the same batch.
        if (gen === this.generation) this.inFlight = null
      })
    return this.inFlight
  }
}
