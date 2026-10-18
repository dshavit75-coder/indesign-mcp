/**
 * save_document — F2 (real write-guard, mocked InDesign transport, mkdtemp only).
 *
 *   S1..S7   the generated save script: id/fullName, existence and size checks
 *            (F2-1, F2-2, F2-5). The script is executed in a node:vm sandbox that
 *            simulates only the few ExtendScript objects it touches, so these show
 *            the script's own logic — NOT InDesign's real behaviour (UNVERIFIED).
 *   T-B*     TOCTOU on path B: the file is changed between the decision and the
 *            send (F2-4, F2-7).
 *   T-A*     TOCTOU on path A: the placeholder is replaced between reservation and
 *            send; cleanup must not delete what is not ours (F2-4, F2-6, F2-7).
 *   F*       failure handling: exception before dispatch on path B, transport
 *            envelope failure, transport throw, registry state, retry
 *            (F2-3, F2-7, F2-8).
 *   C*       competing requests to the same path (F2-7). save_document runs calls one at a
 *            time (write-mutex), so a competing request waits for the earlier one and then
 *            decides on the registry state the earlier one left behind.
 *
 * The tamper layer wraps sendWriteScript and ALWAYS delegates to the real one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync, realpathSync, writeFileSync, appendFileSync, readFileSync,
  existsSync, lstatSync, utimesSync, chmodSync, unlinkSync, renameSync,
  symlinkSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { Script } from "node:vm";

vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

// Makes unlinkSync fail for ONE path with EACCES, whatever user runs the tests (a read-only
// directory would not stop root). write-guard.ts's cleanupPlaceholder imports unlinkSync from
// "node:fs", so it sees this fault; it swallows the error exactly as it would a real one.
const fsFault = vi.hoisted(() => ({ failUnlinkOf: null as string | null }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    unlinkSync: ((p: unknown, ...rest: unknown[]) => {
      if (fsFault.failUnlinkOf !== null && String(p) === fsFault.failUnlinkOf) {
        throw Object.assign(new Error(`EACCES: permission denied, unlink '${String(p)}'`), { code: "EACCES" });
      }
      return (actual.unlinkSync as (...a: unknown[]) => void)(p, ...rest);
    }) as typeof actual.unlinkSync,
  };
});

const hook = vi.hoisted(() => ({
  /** Runs after decideWrite (and reservePlaceholder), before the real sendWriteScript. */
  beforeSend: null as null | ((finalPath: string) => void),
  /** Runs inside the injected send function: after assertWriteAllowed, "during" the send. */
  duringSend: null as null | ((finalPath: string) => void),
  /** Makes the call throw before anything is dispatched. */
  throwBeforeSend: false,
}));

vi.mock("../../../src/write-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/write-guard.js")>();
  return {
    ...actual,
    sendWriteScript: ((...args: Parameters<typeof actual.sendWriteScript>) => {
      const [decision, request, sendFn, wrapFn] = args;
      if (hook.throwBeforeSend) throw new Error("injected failure before dispatch");
      hook.beforeSend?.(request.finalPath);
      const wrapped = hook.duringSend
        ? ((o: Parameters<typeof sendFn>[0]) => {
            hook.duringSend!(request.finalPath);
            return sendFn(o);
          })
        : sendFn;
      return actual.sendWriteScript(decision, request, wrapped as typeof sendFn, wrapFn);
    }) as typeof actual.sendWriteScript,
  };
});

import { saveDocumentTool } from "../../../src/tools/save-document.js";
import * as wg from "../../../src/write-guard.js";
import { runScriptWithResultFile } from "../../../src/transport/result-file.js";
import type { Envelope } from "../../../src/types.js";

const mockRun = vi.mocked(runScriptWithResultFile);

let dir: string;
let counter = 0;

beforeEach(() => {
  mockRun.mockReset();
  hook.beforeSend = null;
  hook.duringSend = null;
  hook.throwBeforeSend = false;
  fsFault.failUnlinkOf = null;
  wg.registryReset();
  dir = realpathSync(mkdtempSync(join(tmpdir(), "b8-f2-")));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ── helpers ──────────────────────────────────────────────────────────────────

function newPath(): { path: string; key: string } {
  const name = `f2_${++counter}_cod.indd`;
  return { path: join(dir, name), key: `${dir}/${name}` };
}

function failure(env: Envelope<unknown>) {
  expect(env.ok).toBe(false);
  if (env.ok) throw new Error("expected a failure envelope");
  return env.error;
}

/** Queue pre-query + write results for a save-as to a free path (path A). */
function queueSaveAs(path: string) {
  mockRun.mockResolvedValueOnce({ ok: true, result: { documentId: "42", fullName: "" } } as never);
  mockRun.mockResolvedValueOnce({ ok: true, result: { path } } as never);
}

/** Queue pre-query + write results for an in-place save of an owned file (path B). */
function queueInPlace(path: string) {
  mockRun.mockResolvedValueOnce({ ok: true, result: { documentId: "42", fullName: path } } as never);
  mockRun.mockResolvedValueOnce({ ok: true, result: { path } } as never);
}

function preQueryOnly(fullName: string) {
  mockRun.mockResolvedValueOnce({ ok: true, result: { documentId: "42", fullName } } as never);
}

/** Make `path` a server-owned file: content on disk + a matching registry record. */
function seedOwned(path: string, key: string) {
  writeFileSync(path, "0123456789");
  const st = lstatSync(path);
  const record = {
    state: "owned" as const,
    documentId: "42",
    tool: "save_document",
    fingerprint: { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs },
  };
  wg.registrySet(key, record);
  return record;
}

/** A failure that PROVES the save script never reached doc.save (the script's own pre-save check). */
const preSaveFailure = {
  ok: false,
  error: {
    kind: "io_error",
    entity: "save_precheck",
    message: "document changed between query and save: expected fullName , found /elsewhere.indd",
  },
};

function sleepMs(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeScriptOf(callIndex = 1): string {
  return (mockRun.mock.calls[callIndex][0] as { scriptTemplate: string }).scriptTemplate;
}

function innerSourceOf(scriptTemplate: string): string {
  const start = scriptTemplate.indexOf("indd.doScript(") + "indd.doScript(".length;
  const end = scriptTemplate.indexOf(", { language", start);
  return JSON.parse(scriptTemplate.slice(start, end)) as string;
}

interface Sim {
  fullName: string | "THROW";
  documents?: "present" | "closed";
  target: { exists: boolean; length: number };
}

/** Run the generated script in a vm sandbox that simulates only what it touches. */
function runScript(scriptTemplate: string, sim: Sim) {
  const saves: string[] = [];
  const doc = {
    id: 42,
    get fullName() {
      if (sim.fullName === "THROW") throw new Error("no fullName");
      return sim.fullName;
    },
    save(f: { path: string }) { saves.push(f.path); },
  };
  const app = {
    scriptPreferences: { userInteractionLevel: 0 },
    documents: sim.documents === "closed" ? [] : [doc],
  };
  const File = (p: string) => ({ path: p, exists: sim.target.exists, length: sim.target.length });
  const raw = new Script(innerSourceOf(scriptTemplate)).runInNewContext({
    app,
    UserInteractionLevels: { NEVER_INTERACT: 1 },
    File,
  });
  return { env: JSON.parse(raw as string), saves };
}

// ── S: the generated script ─────────────────────────────────────────────────

describe("save script — path A (F2-1, F2-2, F2-5)", () => {
  async function pathAScript() {
    const { path } = newPath();
    queueSaveAs(path);
    expect((await saveDocumentTool.handler({ path })).ok).toBe(true);
    return { path, tpl: writeScriptOf() };
  }

  it("S1: the checks appear before the save call, in order", async () => {
    const { tpl } = await pathAScript();
    const src = innerSourceOf(tpl);
    const iFull = src.indexOf("__fullName !==");
    const iTarget = src.indexOf("__target.length");
    const iSave = src.indexOf("doc.save(File(");
    expect(iFull).toBeGreaterThan(-1);
    expect(iFull).toBeLessThan(iTarget);
    expect(iTarget).toBeLessThan(iSave);
  });

  it("S2: matching document and empty placeholder → saves once", async () => {
    const { path, tpl } = await pathAScript();
    const { env, saves } = runScript(tpl, { fullName: "", target: { exists: true, length: 0 } });
    expect(env.ok).toBe(true);
    expect(saves).toEqual([path]);
  });

  it("S3: document fullName changed since the query → stops, no save (swapped document)", async () => {
    const { tpl } = await pathAScript();
    const { env, saves } = runScript(tpl, { fullName: "/Users/x/other.indd", target: { exists: true, length: 0 } });
    expect(env.ok).toBe(false);
    expect(env.error.kind).toBe("io_error");
    expect(env.error.entity).toBe("save_precheck"); // proof that nothing was written
    expect(saves).toEqual([]);
  });

  it("S4: placeholder missing or no longer empty → stops, no save", async () => {
    const { tpl } = await pathAScript();
    for (const target of [{ exists: false, length: 0 }, { exists: true, length: 5 }]) {
      const { env, saves } = runScript(tpl, { fullName: "", target });
      expect(env.ok).toBe(false);
      expect(env.error.kind).toBe("name_collision");
      expect(env.error.entity).toBe("save_precheck");
      expect(saves).toEqual([]);
    }
  });

  it("S5: document closed in InDesign since the query → not_found, no save", async () => {
    const { tpl } = await pathAScript();
    const { env, saves } = runScript(tpl, { fullName: "", documents: "closed", target: { exists: true, length: 0 } });
    expect(env.ok).toBe(false);
    expect(env.error.kind).toBe("not_found");
    expect(env.error.entity).toBe("document"); // findDocumentById runs before doc.save
    expect(saves).toEqual([]);
  });
});

describe("save script — path B (F2-1, F2-2, F2-5)", () => {
  async function pathBScript() {
    const { path, key } = newPath();
    seedOwned(path, key);
    queueInPlace(path);
    expect((await saveDocumentTool.handler({})).ok).toBe(true);
    return { path, tpl: writeScriptOf() };
  }

  it("S6: matching document, file exists with the recorded size → saves once", async () => {
    const { path, tpl } = await pathBScript();
    const { env, saves } = runScript(tpl, { fullName: path, target: { exists: true, length: 10 } });
    expect(env.ok).toBe(true);
    expect(saves).toEqual([path]);
  });

  it("S7: file missing, different size or document swapped → stops, no save", async () => {
    const { path, tpl } = await pathBScript();
    const cases: Array<[Sim, string]> = [
      [{ fullName: path, target: { exists: false, length: 0 } }, "name_collision"],
      [{ fullName: path, target: { exists: true, length: 11 } }, "name_collision"],
      [{ fullName: "/Users/x/other.indd", target: { exists: true, length: 10 } }, "io_error"],
    ];
    for (const [sim, kind] of cases) {
      const { env, saves } = runScript(tpl, sim);
      expect(env.ok).toBe(false);
      expect(env.error.kind).toBe(kind);
      expect(env.error.entity).toBe("save_precheck");
      expect(saves).toEqual([]);
    }
  });

  // Changed on purpose (live finding, 21.6.0.57): an UNKNOWN error while reading doc.fullName used to be
  // swallowed into "" and reported as "document changed" (io_error / save_precheck). It is no longer
  // swallowed: the original error comes back and nothing is saved. The recognised "never saved" case is
  // covered in save-document-unsaved.test.ts.
  it("S7b: fullName unreadable for an unknown reason → the original error, no save", async () => {
    const { tpl } = await pathBScript();
    const { env, saves } = runScript(tpl, { fullName: "THROW", target: { exists: true, length: 10 } });
    expect(env.ok).toBe(false);
    expect(env.error.message).toContain("no fullName");
    expect(saves).toEqual([]);
  });
});

// ── T-B: TOCTOU, path B ─────────────────────────────────────────────────────

describe("TOCTOU on path B — file changed between decision and send (F2-4, F2-7)", () => {
  const mutators: Record<string, (p: string, other: string) => void> = {
    "size changed": (p) => appendFileSync(p, "more"),
    "mtime changed": (p) => {
      const st = lstatSync(p);
      utimesSync(p, st.atime, new Date(st.mtimeMs - 5000));
    },
    "ctime changed (chmod only)": (p) => { sleepMs(5); chmodSync(p, 0o600); },
    "replaced by another file (new inode)": (p) => {
      const t = p + ".tmp";
      writeFileSync(t, readFileSync(p));
      renameSync(t, p);
    },
    "deleted": (p) => unlinkSync(p),
    "replaced by a symlink": (p, other) => { unlinkSync(p); symlinkSync(other, p); },
  };

  it.each(Object.keys(mutators))("T-B: %s → refused, zero write scripts, registry unchanged", async (name) => {
    const { path, key } = newPath();
    const seed = seedOwned(path, key);
    const other = join(dir, "other.txt");
    writeFileSync(other, "other file");
    preQueryOnly(path);
    hook.beforeSend = (p) => mutators[name](p, other);

    const error = failure(await saveDocumentTool.handler({}));

    expect(error.reason).toBe("fingerprint_mismatch");
    expect(mockRun).toHaveBeenCalledTimes(1); // pre-query only: nothing sent to InDesign
    expect(wg.registryGet(key)).toEqual(seed); // pre-existing record neither upgraded nor created anew
    if (name === "replaced by a symlink") {
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
      expect(readFileSync(other, "utf8")).toBe("other file"); // symlink target untouched
    }
  });
});

// ── T-A: TOCTOU, path A ─────────────────────────────────────────────────────

describe("TOCTOU on path A — placeholder changed between reservation and send (F2-4, F2-6, F2-7)", () => {
  async function settle() {
    await new Promise((r) => setTimeout(r, 100)); // let any (wrongly) scheduled unlink run
  }

  it("T-A1: placeholder replaced by another empty file (new inode) → refused, NOT deleted, no registry record", async () => {
    const { path, key } = newPath();
    preQueryOnly("");
    hook.beforeSend = (p) => { unlinkSync(p); writeFileSync(p, ""); };

    failure(await saveDocumentTool.handler({ path }));
    await settle();

    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(existsSync(path)).toBe(true); // not ours any more → left alone
    expect(wg.registryGet(key)).toBeUndefined();
  });

  it("T-A2: placeholder given content → refused, NOT deleted, content intact", async () => {
    const { path, key } = newPath();
    preQueryOnly("");
    hook.beforeSend = (p) => writeFileSync(p, "someone else's data");

    failure(await saveDocumentTool.handler({ path }));
    await settle();

    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(readFileSync(path, "utf8")).toBe("someone else's data");
    expect(wg.registryGet(key)).toBeUndefined();
  });

  it("T-A3: placeholder replaced by a symlink → refused, link and target untouched", async () => {
    const { path, key } = newPath();
    const other = join(dir, "other.txt");
    writeFileSync(other, "other file");
    preQueryOnly("");
    hook.beforeSend = (p) => { unlinkSync(p); symlinkSync(other, p); };

    failure(await saveDocumentTool.handler({ path }));
    await settle();

    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(other, "utf8")).toBe("other file");
    expect(wg.registryGet(key)).toBeUndefined();
  });
});

// ── F: failure handling ─────────────────────────────────────────────────────

describe("failure handling and registry (F2-3, F2-7, F2-8)", () => {
  it("F1: path B — exception before dispatch → normal error envelope, registry unchanged", async () => {
    const { path, key } = newPath();
    const seed = seedOwned(path, key);
    preQueryOnly(path);
    hook.throwBeforeSend = true;

    const error = failure(await saveDocumentTool.handler({})); // must resolve, not reject

    expect(error.kind).toBe("write_not_authorized");
    expect(error.message).toContain("injected failure");
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(wg.registryGet(key)).toEqual(seed);
  });

  it("F2: path B — retry after that failure succeeds with a fresh decision", async () => {
    const { path, key } = newPath();
    seedOwned(path, key);
    preQueryOnly(path);
    hook.throwBeforeSend = true;
    failure(await saveDocumentTool.handler({}));

    hook.throwBeforeSend = false;
    queueInPlace(path);
    const retry = await saveDocumentTool.handler({});

    expect(retry.ok).toBe(true);
    expect(wg.registryGet(key)?.state).toBe("owned");
  });

  it("F3: path B — transport envelope failure → record becomes uncertain with the PRIOR fingerprint, never refreshed", async () => {
    const { path, key } = newPath();
    const seed = seedOwned(path, key);
    preQueryOnly(path);
    mockRun.mockResolvedValueOnce({ ok: false, error: { kind: "io_error", message: "boom" } } as never);
    hook.duringSend = (p) => appendFileSync(p, "zz"); // the file changes while "InDesign" runs

    const env = await saveDocumentTool.handler({});

    expect(failure(env).kind).toBe("io_error"); // transport envelope propagated
    const record = wg.registryGet(key);
    expect(record?.state).toBe("uncertain");
    expect(record?.fingerprint).toEqual(seed.fingerprint);
    expect(lstatSync(path).size).not.toBe(seed.fingerprint.size); // proves it was not refreshed from disk

    // and the next write to that path is refused, not silently allowed
    preQueryOnly(path);
    hook.duringSend = null;
    const next = failure(await saveDocumentTool.handler({}));
    expect(next.kind).toBe("name_collision");
    expect(next.reason).toBe("uncertain");
  });

  it("F4: path A — a failure that PROVES nothing was written → not 'owned', placeholder removed", async () => {
    const { path, key } = newPath();
    preQueryOnly("");
    mockRun.mockResolvedValueOnce(preSaveFailure as never);

    const error = failure(await saveDocumentTool.handler({ path }));

    expect(error.message).not.toContain("was left in place");
    expect(wg.registryGet(key)?.state).toBe("uncertain");
    expect(existsSync(path)).toBe(false); // removal is synchronous
  });

  it("F5: path A — retry after a provable pre-save failure succeeds with a fresh decision", async () => {
    const { path, key } = newPath();
    preQueryOnly("");
    mockRun.mockResolvedValueOnce(preSaveFailure as never);
    failure(await saveDocumentTool.handler({ path }));
    expect(existsSync(path)).toBe(false);

    queueSaveAs(path);
    const retry = await saveDocumentTool.handler({ path });

    expect(retry.ok).toBe(true);
    expect(wg.registryGet(key)?.state).toBe("owned");
  });

  it("F6: path A — the transport throws after dispatch → outcome UNKNOWN: placeholder kept, uncertain, error says so", async () => {
    const { path, key } = newPath();
    preQueryOnly("");
    mockRun.mockRejectedValueOnce(new Error("osascript died"));

    const error = failure(await saveDocumentTool.handler({ path }));

    expect(error.kind).toBe("io_error");
    expect(error.reason).toBe("uncertain");
    expect(error.message).toContain("was left in place");
    expect(wg.registryGet(key)?.state).toBe("uncertain");
    expect(existsSync(path)).toBe(true); // not removed: the write may still be running
  });
});

// ── C: competing requests to the same path (F2-7) ───────────────────────────
// save_document serializes its calls: the second request does not even run its pre-query
// until the first has finished, then decides on what the first one left in the registry.

describe("competing requests to the same path — serialized by the save lock (F2-7)", () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  }
  const isWrite = (o: unknown) => (o as { scriptTemplate: string }).scriptTemplate.includes("doc.save(File(");
  const failedEnvelope = { ok: false, error: { kind: "io_error", message: "script failed inside InDesign" } };
  const settle = () => new Promise((r) => setTimeout(r, 40)); // real timers: lets a wrongly-started request show itself

  /** Transport calls, in order: "pre" = query, "write" = save script. */
  function installTransport(opts: { documentIds: string[]; fullName: string; firstWrite: Promise<unknown>; otherWrites?: unknown }) {
    const log: string[] = [];
    const writeScripts: string[] = [];
    let pres = 0;
    let writes = 0;
    mockRun.mockImplementation(((o: { scriptTemplate: string }) => {
      if (isWrite(o)) {
        log.push("write");
        writeScripts.push(o.scriptTemplate);
        writes++;
        return writes === 1 ? opts.firstWrite : Promise.resolve(opts.otherWrites ?? { ok: true, result: { path: "x" } });
      }
      log.push("pre");
      const documentId = opts.documentIds[Math.min(pres, opts.documentIds.length - 1)];
      pres++;
      return Promise.resolve({ ok: true, result: { documentId, fullName: opts.fullName } });
    }) as never);
    return { log, writeScripts, writes: () => writes };
  }

  /** R1 save-as (path A) fails inside InDesign; R2 (same path) is queued behind it. */
  async function secondQueuedBehindFailingFirst(opts: { secondDocumentId: string; beforeFirstSend?: (placeholderPath: string) => void }) {
    const { path, key } = newPath();
    const first = deferred<unknown>();
    const t = installTransport({ documentIds: ["42", opts.secondDocumentId], fullName: "", firstWrite: first.promise });
    if (opts.beforeFirstSend) hook.beforeSend = (p) => opts.beforeFirstSend!(p);

    const r1 = saveDocumentTool.handler({ path });
    await vi.waitFor(() => expect(t.writes()).toBe(1)); // R1 is inside its send; the record is "pending"
    hook.beforeSend = null;
    const r2 = saveDocumentTool.handler({ path });
    await settle();
    expect(t.log).toEqual(["pre", "write"]); // R2 has not started: not even its pre-query

    first.resolve(preSaveFailure); // a failure that proves nothing was written: the placeholder is cleaned up
    const [e1, e2] = await Promise.all([r1, r2]);
    return { path, key, e1, e2, t };
  }

  it("C0: two simultaneous save-as to a free path run one after the other; the second is a path-B save of the first's file", async () => {
    const { path, key } = newPath();
    const t = installTransport({ documentIds: ["42"], fullName: "", firstWrite: Promise.resolve({ ok: true, result: { path } }) });

    const [a, b] = await Promise.all([saveDocumentTool.handler({ path }), saveDocumentTool.handler({ path })]);

    expect([a.ok, b.ok]).toEqual([true, true]);
    expect(t.log).toEqual(["pre", "write", "pre", "write"]); // strictly sequential, never "pre", "pre"
    expect(t.writeScripts[0]).toContain("empty reserved placeholder"); // path A
    expect(t.writeScripts[1]).toContain("missing or changed size"); // path B: the first call's file is now owned
    expect(wg.registryGet(key)?.state).toBe("owned");
  });

  // A failed save-as removes its own placeholder BEFORE the lock is released, so the queued request
  // finds a free path and is an ordinary new save-as (exactly what two sequential calls would do).
  it("C1: a DIFFERENT document queued behind a failing save-as finds the path free and saves normally (path A)", async () => {
    const { key, e1, e2, t } = await secondQueuedBehindFailingFirst({ secondDocumentId: "43" });

    expect(failure(e1).kind).toBe("io_error"); // the first call's own failure
    expect(e2.ok).toBe(true);
    expect(t.log).toEqual(["pre", "write", "pre", "write"]); // second ran only after the first had finished and cleaned up
    expect(t.writeScripts[1]).toContain("empty reserved placeholder"); // a fresh path-A save, not a takeover of a leftover
    expect(wg.registryGet(key)?.state).toBe("owned");
    expect(wg.registryGet(key)?.documentId).toBe("43");
  });

  it("C2: the SAME document queued behind a failing save-as retries normally (path A) once the failure has cleaned up", async () => {
    const { path, key, e1, e2, t } = await secondQueuedBehindFailingFirst({ secondDocumentId: "42" });

    expect(failure(e1).kind).toBe("io_error");
    expect(e2.ok).toBe(true);
    expect(t.log).toEqual(["pre", "write", "pre", "write"]);
    expect(t.writeScripts[1]).toContain("empty reserved placeholder");
    expect(wg.registryGet(key)?.state).toBe("owned");
    expect(existsSync(path)).toBe(true); // the second call's own placeholder (the mock transport writes nothing)
  });

  it("C3: if the placeholder cannot be removed, the queued request for the same document is still refused", async () => {
    const { path, key, e1, e2, t } = await secondQueuedBehindFailingFirst({
      secondDocumentId: "42",
      beforeFirstSend: (p) => { fsFault.failUnlinkOf = p; }, // removing the placeholder will fail (EACCES), for any user
    });

    expect(failure(e1).kind).toBe("io_error");
    const second = failure(e2);
    expect(second.kind).toBe("name_collision");
    expect(second.reason).toBe("uncertain");
    expect(t.writes()).toBe(1);
    expect(existsSync(path)).toBe(true); // the placeholder really could not be removed
    expect(wg.registryGet(key)?.state).toBe("uncertain");
  });

  /** Two in-place saves of the same owned file; the first one's write is held in flight. */
  async function twoInPlaceSaves(opts: { firstSucceeds: boolean }) {
    const { path, key } = newPath();
    const seed = seedOwned(path, key); // "0123456789" = 10 bytes
    const first = deferred<unknown>();
    const t = installTransport({ documentIds: ["42"], fullName: path, firstWrite: first.promise });
    let sends = 0;
    hook.duringSend = (p) => { if (++sends === 2) appendFileSync(p, "SAVED-BY-SECOND"); };

    const r1 = saveDocumentTool.handler({});
    await vi.waitFor(() => expect(t.writes()).toBe(1));
    const r2 = saveDocumentTool.handler({});
    await settle();
    expect(t.log).toEqual(["pre", "write"]); // the second call waits; it has not queried anything yet

    if (opts.firstSucceeds) {
      appendFileSync(path, "SAVED-BY-FIRST"); // InDesign really saved: 10 + 14 = 24 bytes
      first.resolve({ ok: true, result: { path } });
    } else {
      first.resolve(failedEnvelope);
    }
    const [e1, e2] = await Promise.all([r1, r2]);
    return { path, key, seed, e1, e2, t };
  }

  it("C4: the first save fails → the queued second save is refused (uncertain) and the record keeps the verified fingerprint", async () => {
    const { key, seed, e1, e2, t } = await twoInPlaceSaves({ firstSucceeds: false });

    expect(failure(e1).kind).toBe("io_error");
    const second = failure(e2);
    expect(second.kind).toBe("name_collision");
    expect(second.reason).toBe("uncertain");
    expect(t.log).toEqual(["pre", "write", "pre"]); // the second wrote nothing
    expect(wg.registryGet(key)?.state).toBe("uncertain");
    expect(wg.registryGet(key)?.fingerprint).toEqual(seed.fingerprint); // never refreshed from disk
  });

  it("C5: the first save succeeds → the second one proceeds with the UPDATED fingerprint and ends owned", async () => {
    const { path, key, e1, e2, t } = await twoInPlaceSaves({ firstSucceeds: true });

    expect([e1.ok, e2.ok]).toEqual([true, true]);
    expect(t.log).toEqual(["pre", "write", "pre", "write"]); // strictly sequential
    expect(t.writeScripts[1]).toContain("__target.length !== 24"); // expects the size the FIRST save left (10 + 14), not the original 10
    expect(wg.registryGet(key)?.state).toBe("owned");
    expect(wg.registryGet(key)?.fingerprint.size).toBe(lstatSync(path).size); // 39: the second save's result
  });
});
