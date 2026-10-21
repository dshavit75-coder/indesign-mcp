/**
 * save_document — the call lock (src/write-mutex.ts used by src/tools/save-document.ts).
 * Real write-guard, mocked InDesign transport, mkdtemp only.
 *
 *   L0   the tool contract is unchanged by the wrapper: name, description, schema,
 *        registration in ToolRegistry
 *   L1   FIFO: calls run strictly one after another, in arrival order
 *   L2   the 90 s limit: a call that waits too long is not started, leaves no trace, and
 *        cannot start later; the timers are gone
 *   L3   the lock is released after an exception before dispatch
 *   L4   the lock is released after a transport rejection and after an ok:false envelope
 *   L5   consecutive calls: success, then failure, then a refusal
 *   L6   calls for different documents are serialized too (documented behaviour)
 *
 * The transport is mocked, so these tests do not show how InDesign behaves when two scripts
 * arrive together, and the lock does not synchronize against other tools or export_pdf.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync, realpathSync, writeFileSync, appendFileSync, existsSync, lstatSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

const hook = vi.hoisted(() => ({ calls: 0, throwOnFirstCall: false }));

vi.mock("../../../src/write-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/write-guard.js")>();
  return {
    ...actual,
    sendWriteScript: ((...args: Parameters<typeof actual.sendWriteScript>) => {
      hook.calls++;
      if (hook.throwOnFirstCall && hook.calls === 1) throw new Error("injected failure before dispatch");
      return actual.sendWriteScript(...args);
    }) as typeof actual.sendWriteScript,
  };
});

import { saveDocumentTool, SAVE_LOCK_WAIT_MS } from "../../../src/tools/save-document.js";
import { ToolRegistry } from "../../../src/tools/registry.js";
import * as wg from "../../../src/write-guard.js";
import { runScriptWithResultFile } from "../../../src/transport/result-file.js";
import type { Envelope } from "../../../src/types.js";

const mockRun = vi.mocked(runScriptWithResultFile);

let dir: string;
let counter = 0;

beforeEach(() => {
  mockRun.mockReset();
  hook.calls = 0;
  hook.throwOnFirstCall = false;
  wg.registryReset();
  dir = realpathSync(mkdtempSync(join(tmpdir(), "b8-lock-")));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

// ── helpers ──────────────────────────────────────────────────────────────────

function newPath() {
  const name = `lock_${++counter}_cod.indd`;
  return { path: join(dir, name), key: `${dir}/${name}` };
}

function seedOwned(path: string, key: string, documentId = "42") {
  writeFileSync(path, "0123456789");
  const st = lstatSync(path);
  const record = {
    state: "owned" as const,
    documentId,
    tool: "save_document",
    fingerprint: { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs },
  };
  wg.registrySet(key, record);
  return record;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Let queued promise continuations run (works with fake timers too). */
async function flush() {
  for (let i = 0; i < 200; i++) await Promise.resolve();
}

function failure(env: Envelope<unknown>) {
  expect(env.ok).toBe(false);
  if (env.ok) throw new Error("expected a failure envelope");
  return env.error;
}

const isWrite = (o: unknown) => (o as { scriptTemplate: string }).scriptTemplate.includes("doc.save(File(");

/** Transport mock. The first write is whatever `firstWrite` is; later writes succeed. */
function installTransport(opts: { pre: (n: number) => { documentId: string; fullName: string }; firstWrite: Promise<unknown> }) {
  const log: string[] = [];
  let pres = 0;
  let writes = 0;
  mockRun.mockImplementation(((o: { scriptTemplate: string }) => {
    if (isWrite(o)) {
      log.push("write");
      writes++;
      return writes === 1 ? opts.firstWrite : Promise.resolve({ ok: true, result: { path: "x" } });
    }
    log.push("pre");
    return Promise.resolve({ ok: true, result: opts.pre(pres++) });
  }) as never);
  return { log, writes: () => writes };
}

const failedEnvelope = { ok: false, error: { kind: "io_error", message: "script failed inside InDesign" } };
const realSettle = () => new Promise((r) => setTimeout(r, 40));

// ── L0: contract ────────────────────────────────────────────────────────────

describe("L0 — the wrapper does not change the tool contract", () => {
  it("name, description and schema are exactly the original ones", () => {
    expect(saveDocumentTool.name).toBe("save_document");
    expect(saveDocumentTool.description).toBe(
      "Saves an InDesign document to disk. " +
        "With `path`, performs a save-as to that path (must not exist unless owned by this session). " +
        "Without `path`, saves in-place (document must have been opened or created by this session). " +
        "Returns io_error if the document has no saved path and no `path` was provided. " +
        "Never overwrites a file not owned by this session; returns name_collision instead.",
    );
    expect(saveDocumentTool.inputSchema.safeParse({}).success).toBe(false);
    expect(saveDocumentTool.inputSchema.safeParse({ path: "/x/a.indd" }).success).toBe(false);
    expect(saveDocumentTool.inputSchema.safeParse({ document_id: "42" }).success).toBe(true);
    expect(saveDocumentTool.inputSchema.safeParse({ overwrite: true }).success).toBe(false); // still .strict()
    expect(typeof saveDocumentTool.handler).toBe("function");
  });

  it("registers in ToolRegistry under its name, and cannot be registered twice", () => {
    const registry = new ToolRegistry();
    registry.register(saveDocumentTool);

    expect(registry.get("save_document")).toBe(saveDocumentTool);
    expect(registry.list().map((t) => t.name)).toEqual(["save_document"]);
    expect(() => registry.register(saveDocumentTool)).toThrow("already registered");
  });

  it("the limit is 90 seconds", () => {
    expect(SAVE_LOCK_WAIT_MS).toBe(90_000);
  });
});

// ── L1: FIFO ────────────────────────────────────────────────────────────────

describe("L1 — calls run one after another, in arrival order", () => {
  it("three in-place saves: only the first is active; then pre/write pairs strictly in sequence; results in arrival order", async () => {
    const { path, key } = newPath();
    seedOwned(path, key);
    const first = deferred<unknown>();
    const t = installTransport({ pre: () => ({ documentId: "42", fullName: path }), firstWrite: first.promise });
    const done: number[] = [];

    const r1 = saveDocumentTool.handler({ document_id: "doc-1" }).then((v) => { done.push(1); return v; });
    await vi.waitFor(() => expect(t.writes()).toBe(1));
    const r2 = saveDocumentTool.handler({ document_id: "doc-1" }).then((v) => { done.push(2); return v; });
    const r3 = saveDocumentTool.handler({ document_id: "doc-1" }).then((v) => { done.push(3); return v; });
    await realSettle();
    expect(t.log).toEqual(["pre", "write"]); // calls 2 and 3 have not even queried

    appendFileSync(path, "SAVED"); // InDesign really saved
    first.resolve({ ok: true, result: { path } });
    const results = await Promise.all([r1, r2, r3]);

    expect(results.map((r) => r.ok)).toEqual([true, true, true]);
    expect(t.log).toEqual(["pre", "write", "pre", "write", "pre", "write"]); // never "pre", "pre"
    expect(done).toEqual([1, 2, 3]);
    expect(wg.registryGet(key)?.state).toBe("owned");
  });
});

// ── L2: the 90 s limit ──────────────────────────────────────────────────────

describe("L2 — a call that waits too long is not started and cannot start later", () => {
  it("times out at 90 s without any effect; the first call and later calls are unaffected; no timers remain", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { path: path1, key: key1 } = newPath();
    seedOwned(path1, key1);
    const { path: path2, key: key2 } = newPath(); // free path the timed-out call wanted
    const first = deferred<unknown>();
    const t = installTransport({ pre: () => ({ documentId: "42", fullName: path1 }), firstWrite: first.promise });

    const r1 = saveDocumentTool.handler({ document_id: "doc-1" });
    await flush();
    expect(t.log).toEqual(["pre", "write"]); // the first call is in flight and holds the lock

    let r2Result: Envelope<unknown> | undefined;
    const r2 = saveDocumentTool.handler({ document_id: "doc-1", path: path2 }).then((v) => { r2Result = v; });
    await flush();
    await vi.advanceTimersByTimeAsync(SAVE_LOCK_WAIT_MS - 1);
    expect(r2Result).toBeUndefined(); // still waiting one millisecond before the limit

    await vi.advanceTimersByTimeAsync(1);
    await r2;
    const error = failure(r2Result!);
    expect(error.kind).toBe("timeout");
    expect(error.message).toContain("90 seconds");
    expect(error.message).toContain("was not started");
    expect(t.log).toEqual(["pre", "write"]); // the timed-out call made no query and no write
    expect(existsSync(path2)).toBe(false); // no placeholder
    expect(wg.registryGet(key2)).toBeUndefined(); // no registry entry
    expect(wg.registryGet(key1)?.state).toBe("pending"); // the first call's record is untouched

    const r3 = saveDocumentTool.handler({ document_id: "doc-1", path: path2 }); // a NEW call for the same path, queued behind the first
    await flush();
    first.resolve({ ok: true, result: { path: path1 } });
    const [e1, e3] = await Promise.all([r1, r3]);

    expect(e1.ok).toBe(true);
    expect(e3.ok).toBe(true);
    expect(t.log).toEqual(["pre", "write", "pre", "write"]); // exactly one more pair: the third call; the timed-out one never ran
    expect(wg.registryGet(key2)?.state).toBe("owned"); // the path was really free
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ── L3, L4: release after failures ──────────────────────────────────────────

describe("L3 — released after an exception before dispatch", () => {
  it("the first call fails with a normal envelope, the queued call then runs and succeeds", async () => {
    const { path, key } = newPath();
    seedOwned(path, key);
    const t = installTransport({ pre: () => ({ documentId: "42", fullName: path }), firstWrite: Promise.resolve({ ok: true, result: { path } }) });
    hook.throwOnFirstCall = true; // the first sendWriteScript call throws before anything is sent

    const [e1, e2] = await Promise.all([saveDocumentTool.handler({ document_id: "doc-1" }), saveDocumentTool.handler({ document_id: "doc-1" })]);

    expect(failure(e1).kind).toBe("write_not_authorized"); // normal envelope, not a rejection
    expect(failure(e1).message).toContain("injected failure");
    expect(e2.ok).toBe(true); // the lock was released and the second call ran
    expect(t.log).toEqual(["pre", "pre", "write"]); // the first never wrote; the second queried only after the first was done
    expect(wg.registryGet(key)?.state).toBe("owned");
  });
});

describe("L4 — released after a transport rejection and after an ok:false envelope", () => {
  const failures: Array<[string, () => Promise<unknown>]> = [
    ["the transport rejects", () => Promise.reject(new Error("osascript died"))],
    ["the transport answers ok:false", () => Promise.resolve(failedEnvelope)],
  ];

  it.each(failures)("%s → the queued call runs (the lock was released) and is refused as uncertain, without writing", async (_label, firstWrite) => {
    const { path, key } = newPath();
    const seed = seedOwned(path, key);
    const gate = deferred<void>();
    const t = installTransport({ pre: () => ({ documentId: "42", fullName: path }), firstWrite: gate.promise.then(firstWrite) });

    const r1 = saveDocumentTool.handler({ document_id: "doc-1" });
    await vi.waitFor(() => expect(t.writes()).toBe(1));
    const r2 = saveDocumentTool.handler({ document_id: "doc-1" });
    await realSettle();
    expect(t.log).toEqual(["pre", "write"]);
    gate.resolve();
    const [e1, e2] = await Promise.all([r1, r2]);

    expect(e1.ok).toBe(false);
    const second = failure(e2);
    expect(second.kind).toBe("name_collision");
    expect(second.reason).toBe("uncertain");
    expect(t.log).toEqual(["pre", "write", "pre"]); // the second call ran its query and stopped
    expect(wg.registryGet(key)?.state).toBe("uncertain");
    expect(wg.registryGet(key)?.fingerprint).toEqual(seed.fingerprint);
  });
});

// ── L5: consecutive calls ───────────────────────────────────────────────────

describe("L5 — consecutive calls: success, failure, refusal", () => {
  it("success keeps the file owned; a failing call makes it uncertain; the next call is refused", async () => {
    const { path, key } = newPath();
    seedOwned(path, key);
    const log: string[] = [];
    let writes = 0;
    mockRun.mockImplementation(((o: { scriptTemplate: string }) => {
      if (!isWrite(o)) { log.push("pre"); return Promise.resolve({ ok: true, result: { documentId: "42", fullName: path } }); }
      log.push("write");
      writes++;
      return Promise.resolve(writes === 1 ? { ok: true, result: { path } } : failedEnvelope);
    }) as never);

    const e1 = await saveDocumentTool.handler({ document_id: "doc-1" });
    expect(e1.ok).toBe(true);
    expect(wg.registryGet(key)?.state).toBe("owned");

    const e2 = await saveDocumentTool.handler({ document_id: "doc-1" });
    expect(failure(e2).kind).toBe("io_error"); // the transport's own failure envelope
    expect(wg.registryGet(key)?.state).toBe("uncertain");

    const e3 = await saveDocumentTool.handler({ document_id: "doc-1" });
    const refused = failure(e3);
    expect(refused.kind).toBe("name_collision");
    expect(refused.reason).toBe("uncertain");
    expect(log).toEqual(["pre", "write", "pre", "write", "pre"]); // the third wrote nothing
  });
});

// ── L6: different documents ─────────────────────────────────────────────────

describe("L6 — calls for different documents are serialized too", () => {
  it("the second document's call does not start until the first document's call has finished", async () => {
    const a = newPath();
    const b = newPath();
    seedOwned(a.path, a.key, "42");
    seedOwned(b.path, b.key, "43");
    const first = deferred<unknown>();
    const t = installTransport({
      pre: (n) => (n === 0 ? { documentId: "42", fullName: a.path } : { documentId: "43", fullName: b.path }),
      firstWrite: first.promise,
    });

    const r1 = saveDocumentTool.handler({ document_id: "42" });
    await vi.waitFor(() => expect(t.writes()).toBe(1));
    const r2 = saveDocumentTool.handler({ document_id: "43" });
    await realSettle();
    expect(t.log).toEqual(["pre", "write"]); // serialization is global to save_document, by design

    first.resolve({ ok: true, result: { path: a.path } });
    const [e1, e2] = await Promise.all([r1, r2]);

    expect([e1.ok, e2.ok]).toEqual([true, true]);
    expect(t.log).toEqual(["pre", "write", "pre", "write"]);
    expect(wg.registryGet(a.key)?.documentId).toBe("42");
    expect(wg.registryGet(b.key)?.documentId).toBe("43");
  });
});
