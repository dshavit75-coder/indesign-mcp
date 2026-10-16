/**
 * WriteMutex — unit tests (no InDesign, no files).
 *
 *   M1   immediate entry; no timer is created
 *   M2   strict FIFO
 *   M3   mutual exclusion
 *   M4   release after a rejection, and after a SYNCHRONOUS throw, for immediate entry
 *        and for entry after waiting; the original error is returned unchanged
 *   M5   timeout: the request does not run, and cannot enter later
 *   M6   a timed-out waiter in the middle does not disturb the others' order
 *   M7   grant before the timer fires: the request runs once, nothing is cancelled late
 *   M8   release is idempotent and cannot release a lock owned by someone else
 *   M9   timers are cleared on grant, on cancellation and on completion
 *   M10  invalid wait values are rejected before any state changes
 *   M11  a newcomer cannot barge in while the lock was just handed to a waiter
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { WriteMutex } from "../../src/write-mutex.js";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Let already-queued promise continuations run. */
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("WriteMutex — entry, order, exclusion", () => {
  it("M1: a free lock is entered immediately, returns the value, releases, and creates no timer", async () => {
    vi.useFakeTimers();
    const m = new WriteMutex();

    const r = await m.runExclusive(async () => 5, 1000);

    expect(r).toEqual({ acquired: true, value: 5 });
    expect(m.isLocked()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("M2: waiters run in strict arrival order", async () => {
    const m = new WriteMutex();
    const holder = await m.acquire(1000);
    const order: string[] = [];
    const run = (name: string) => m.runExclusive(async () => { order.push(name); }, 5000);

    const ps = [run("W1"), run("W2"), run("W3"), run("W4")];
    expect(m.queueLength()).toBe(4);
    holder!.release();
    await Promise.all(ps);

    expect(order).toEqual(["W1", "W2", "W3", "W4"]);
    expect(m.isLocked()).toBe(false);
  });

  it("M3: never more than one holder at a time", async () => {
    const m = new WriteMutex();
    let active = 0;
    let max = 0;
    const task = () => m.runExclusive(async () => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
    }, 5000);

    await Promise.all([task(), task(), task(), task(), task()]);

    expect(max).toBe(1);
    expect(m.isLocked()).toBe(false);
  });
});

describe("WriteMutex — release after failure", () => {
  it("M4a: released after a rejection; the next request enters; the error is the same object", async () => {
    const m = new WriteMutex();
    const err = new Error("boom");

    const caught = await m.runExclusive(async () => { throw err; }, 1000).catch((e) => e);

    expect(caught).toBe(err);
    expect(m.isLocked()).toBe(false);
    expect(await m.runExclusive(() => "next", 1000)).toEqual({ acquired: true, value: "next" });
  });

  it("M4b: a SYNCHRONOUS throw on immediate entry releases the lock and returns the same error", async () => {
    const m = new WriteMutex();
    const err = new Error("sync boom");

    const caught = await m.runExclusive((): string => { throw err; }, 1000).catch((e) => e);

    expect(caught).toBe(err);
    expect(m.isLocked()).toBe(false);
    expect(await m.runExclusive(() => "next", 1000)).toEqual({ acquired: true, value: "next" });
  });

  it("M4c: a SYNCHRONOUS throw after waiting releases the lock to the next waiter, same error", async () => {
    const m = new WriteMutex();
    const holder = await m.acquire(1000);
    const err = new Error("sync boom after wait");
    const order: string[] = [];

    const w1 = m.runExclusive((): void => { order.push("W1"); throw err; }, 5000).catch((e) => e);
    const w2 = m.runExclusive(() => { order.push("W2"); return "ok"; }, 5000);
    holder!.release();

    expect(await w1).toBe(err);
    expect(await w2).toEqual({ acquired: true, value: "ok" });
    expect(order).toEqual(["W1", "W2"]);
    expect(m.isLocked()).toBe(false);
  });
});

describe("WriteMutex — bounded wait", () => {
  it("M5: a request that times out does not run, returns acquired:false, and cannot enter later", async () => {
    vi.useFakeTimers();
    const m = new WriteMutex();
    const holder = await m.acquire(1000);
    const fn = vi.fn(async () => "should never run");

    const waiting = m.runExclusive(fn, 1000);
    expect(m.queueLength()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);

    expect(await waiting).toEqual({ acquired: false });
    expect(m.queueLength()).toBe(0);
    expect(fn).not.toHaveBeenCalled();

    holder!.release(); // releasing later must not resurrect the cancelled waiter
    await flush();
    expect(fn).not.toHaveBeenCalled();
    expect(m.isLocked()).toBe(false);
    expect(await m.runExclusive(() => "fresh", 1000)).toEqual({ acquired: true, value: "fresh" }); // free again
    expect(vi.getTimerCount()).toBe(0);
  });

  it("M6: a timed-out waiter in the middle does not disturb the order of the others", async () => {
    vi.useFakeTimers();
    const m = new WriteMutex();
    const holder = await m.acquire(1000);
    const order: string[] = [];
    const run = (name: string, wait: number) => m.runExclusive(async () => { order.push(name); }, wait);

    const w1 = run("W1", 5000);
    const w2 = run("W2", 1000);
    const w3 = run("W3", 5000);
    await vi.advanceTimersByTimeAsync(1000); // only W2 expires

    expect(await w2).toEqual({ acquired: false });
    expect(m.queueLength()).toBe(2);
    holder!.release();
    expect(await w1).toEqual({ acquired: true, value: undefined });
    expect(await w3).toEqual({ acquired: true, value: undefined });
    expect(order).toEqual(["W1", "W3"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("M7: granted just before the timer would fire → runs exactly once and is not cancelled afterwards", async () => {
    vi.useFakeTimers();
    const m = new WriteMutex();
    const holder = await m.acquire(1000);
    const fn = vi.fn(async () => "ran");

    const waiting = m.runExclusive(fn, 1000);
    await vi.advanceTimersByTimeAsync(999);
    holder!.release(); // grant happens first, synchronously
    await vi.advanceTimersByTimeAsync(5000); // the old deadline passes

    expect(await waiting).toEqual({ acquired: true, value: "ran" });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("WriteMutex — ownership", () => {
  it("M8: releasing twice, or with a stale lease, cannot release a lock owned by someone else", async () => {
    const m = new WriteMutex();
    const lease1 = (await m.acquire(1000))!;
    lease1.release();
    const lease2 = (await m.acquire(1000))!;

    lease1.release(); // stale: must be a no-op
    lease1.release();
    expect(m.isLocked()).toBe(true);

    const order: string[] = [];
    const other = m.runExclusive(async () => { order.push("other"); }, 5000);
    await flush();
    expect(order).toEqual([]); // still excluded: lease2 is the owner

    lease2.release();
    await other;
    expect(order).toEqual(["other"]);
    expect(m.isLocked()).toBe(false);
  });

  it("M11: a newcomer cannot overtake a waiter that was just handed the lock", async () => {
    const m = new WriteMutex();
    const holder = (await m.acquire(1000))!;
    const order: string[] = [];
    const w1Gate = deferred();

    const w1 = m.runExclusive(async () => { order.push("W1 start"); await w1Gate.promise; order.push("W1 end"); }, 5000);
    holder.release(); // ownership moves to W1 synchronously
    const newcomer = m.runExclusive(async () => { order.push("N"); }, 5000); // same tick, before W1's continuation ran

    await flush();
    expect(order).toEqual(["W1 start"]); // the newcomer is queued behind W1, not running
    w1Gate.resolve();
    await Promise.all([w1, newcomer]);
    expect(order).toEqual(["W1 start", "W1 end", "N"]);
  });
});

describe("WriteMutex — timers", () => {
  it("M9: the wait timer is cleared on grant and on completion", async () => {
    vi.useFakeTimers();
    const m = new WriteMutex();
    const holder = await m.acquire(1000);

    const waiting = m.runExclusive(async () => "x", 10_000);
    expect(vi.getTimerCount()).toBe(1);
    holder!.release(); // grant clears the timer
    expect(vi.getTimerCount()).toBe(0);
    await waiting;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("M9b: the timer is gone after a cancellation too", async () => {
    vi.useFakeTimers();
    const m = new WriteMutex();
    const holder = await m.acquire(1000);
    const waiting = m.runExclusive(async () => "x", 500);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(500);

    expect(await waiting).toEqual({ acquired: false });
    expect(vi.getTimerCount()).toBe(0);
    holder!.release();
  });
});

describe("WriteMutex — invalid arguments", () => {
  it.each([0, -1, NaN, Infinity, -Infinity])("M10: waitMs=%s is rejected before any state changes", async (bad) => {
    const m = new WriteMutex();
    const fn = vi.fn(async () => "x");

    await expect(m.runExclusive(fn, bad)).rejects.toThrow(RangeError);

    expect(fn).not.toHaveBeenCalled();
    expect(m.isLocked()).toBe(false);
    expect(m.queueLength()).toBe(0);
  });

  it("M10b: an invalid waitMs is rejected even while the lock is held, without joining the queue", async () => {
    const m = new WriteMutex();
    const holder = (await m.acquire(1000))!;

    await expect(m.runExclusive(async () => "x", 0)).rejects.toThrow(RangeError);

    expect(m.queueLength()).toBe(0);
    expect(m.isLocked()).toBe(true);
    holder.release();
  });
});
