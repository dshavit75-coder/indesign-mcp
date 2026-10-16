/**
 * WriteMutex — in-process FIFO mutex with a bounded wait.
 *
 * Leaf module: no imports from src/.
 *
 * Purpose: serialize operations that must not interleave (save_document). Waiters
 * are served strictly in arrival order; a newcomer never overtakes a waiter.
 *
 * Ownership:
 *   - Every grant creates its own Lease. `release()` only has an effect while that
 *     very Lease is the current owner; a second call, or a call on a stale Lease, does
 *     nothing, so a request can never release a lock it does not hold.
 *   - Ownership is handed to the next waiter synchronously inside `release()`, before
 *     the waiter's continuation runs. There is no moment at which the lock is free but
 *     a queued waiter has not yet been given it, so nobody can barge in.
 *
 * Bounded wait (the timeout limits WAITING only, never the running operation):
 *   - Each queued waiter is in exactly one state: "waiting" -> "granted" | "cancelled".
 *     All transitions happen on the single JS thread, one after another.
 *   - When the wait expires while still "waiting": the waiter is marked "cancelled",
 *     removed from the queue by identity, and its promise resolves with null once. It
 *     can never be granted afterwards. The caller then returns without running `fn`.
 *   - The timer is cleared on grant and on cancellation; a callback that fires after a
 *     grant sees a state other than "waiting" and does nothing.
 *
 * Known limit: there is no forced release of a holder whose `fn` never settles (that
 * would break mutual exclusion). Holders are bounded only by what they await.
 * Not re-entrant: calling runExclusive from inside `fn` on the same mutex waits for itself.
 */

export interface Lease {
  /** Release this lease. Idempotent; has no effect unless this lease is the current owner. */
  release(): void;
}

type WaiterState = "waiting" | "granted" | "cancelled";

interface Waiter {
  state: WaiterState;
  resolve: (lease: Lease | null) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export type ExclusiveResult<T> = { acquired: true; value: T } | { acquired: false };

export class WriteMutex {
  private owner: Lease | null = null;
  private readonly queue: Waiter[] = [];

  /** Diagnostics for tests. */
  isLocked(): boolean {
    return this.owner !== null;
  }

  /** Diagnostics for tests: number of requests waiting in the queue. */
  queueLength(): number {
    return this.queue.length;
  }

  private newLease(): Lease {
    const lease: Lease = {
      release: () => {
        if (this.owner !== lease) return; // already released, or never ours
        this.owner = null;
        this.grantNext();
      },
    };
    return lease;
  }

  /** Hand the lock to the first request that is still waiting. Synchronous. */
  private grantNext(): void {
    while (this.owner === null) {
      const waiter = this.queue.shift();
      if (waiter === undefined) return;
      if (waiter.state !== "waiting") continue; // defensive: cancelled waiters are already removed
      waiter.state = "granted";
      if (waiter.timer !== undefined) {
        clearTimeout(waiter.timer);
        waiter.timer = undefined;
      }
      const lease = this.newLease();
      this.owner = lease;
      waiter.resolve(lease);
    }
  }

  /**
   * Acquire the lock, waiting at most `waitMs`. Resolves with a Lease, or with null if the
   * wait expired (the request is then cancelled and can never enter later).
   * Throws RangeError for an invalid `waitMs` before touching any state.
   */
  acquire(waitMs: number): Promise<Lease | null> {
    if (typeof waitMs !== "number" || !Number.isFinite(waitMs) || waitMs <= 0) {
      throw new RangeError(`WriteMutex: waitMs must be a finite number greater than 0, got ${String(waitMs)}`);
    }
    if (this.owner === null && this.queue.length === 0) {
      const lease = this.newLease();
      this.owner = lease;
      return Promise.resolve(lease);
    }
    return new Promise<Lease | null>((resolve) => {
      const waiter: Waiter = { state: "waiting", resolve, timer: undefined };
      waiter.timer = setTimeout(() => {
        if (waiter.state !== "waiting") return; // granted in the meantime
        waiter.state = "cancelled";
        waiter.timer = undefined;
        const index = this.queue.indexOf(waiter);
        if (index !== -1) this.queue.splice(index, 1);
        resolve(null);
      }, waitMs);
      (waiter.timer as { unref?: () => void }).unref?.();
      this.queue.push(waiter);
    });
  }

  /**
   * Run `fn` while holding the lock. The lock is released in `finally`, after a
   * synchronous throw, a rejection or a normal return, for immediate entry and for entry
   * after waiting alike. The original error reaches the caller unchanged.
   * If the wait expires, `fn` is never run and `{ acquired: false }` is returned.
   */
  async runExclusive<T>(fn: () => T | Promise<T>, waitMs: number): Promise<ExclusiveResult<T>> {
    const lease = await this.acquire(waitMs);
    if (lease === null) return { acquired: false };
    try {
      return { acquired: true, value: await fn() };
    } finally {
      lease.release();
    }
  }
}
