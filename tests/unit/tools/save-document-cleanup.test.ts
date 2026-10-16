/**
 * save_document path A — reporting what the placeholder clean-up really did.
 * Real write-guard, mocked InDesign transport, real files in mkdtemp. No InDesign.
 *
 * After a failure that PROVES nothing was written (or a refusal before dispatch) the tool removes
 * its empty placeholder. The outcome is one of:
 *
 *   K1  removed       -> the original error, unchanged
 *   K2  already gone  -> the original error, unchanged
 *   K3  failed        -> still ours (same inode, empty) but not removable: the error says so
 *   K4  not ours      -> replaced / has content / symlink: left untouched, the error says so
 *   K5  guard refusal before dispatch, K6 exception before dispatch: the same reporting
 *   K7  the error's kind and other fields are never changed, only the message gains a sentence
 *
 * A file whose inode no longer matches is never deleted (K4 checks content and links survive).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync, realpathSync, writeFileSync, existsSync, lstatSync, readFileSync, unlinkSync,
  symlinkSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  calls: 0,
  throwOnFirstCall: false,
  /** Runs inside the sendWriteScript wrapper: after the placeholder exists, before the guard checks it. */
  beforeGuard: null as null | ((finalPath: string) => void),
}));

vi.mock("../../../src/write-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/write-guard.js")>();
  return {
    ...actual,
    sendWriteScript: ((...args: Parameters<typeof actual.sendWriteScript>) => {
      hook.calls++;
      hook.beforeGuard?.(args[1].finalPath);
      if (hook.throwOnFirstCall && hook.calls === 1) throw new Error("injected failure before dispatch");
      return actual.sendWriteScript(...args);
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
  hook.calls = 0;
  hook.throwOnFirstCall = false;
  hook.beforeGuard = null;
  fsFault.failUnlinkOf = null;
  wg.registryReset();
  dir = realpathSync(mkdtempSync(join(tmpdir(), "b8-cleanup-")));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function newPath() {
  const name = `cleanup_${++counter}_cod.indd`;
  return { path: join(dir, name), key: `${dir}/${name}` };
}

function failure(env: Envelope<unknown>) {
  expect(env.ok).toBe(false);
  if (env.ok) throw new Error("expected a failure envelope");
  return env.error;
}

const isWrite = (o: unknown) => (o as { scriptTemplate: string }).scriptTemplate.includes("doc.save(File(");

const PRE_SAVE_MESSAGE = "document changed between query and save: expected fullName , found /elsewhere.indd";
/** A failure that PROVES the script never reached doc.save, so the placeholder is meant to be removed. */
const preSaveFailure = { ok: false, error: { kind: "io_error", entity: "save_precheck", id: "42", message: PRE_SAVE_MESSAGE } };

/** The first write script runs `first(path)` (to change the world, as InDesign or another process might) and fails provably. */
function installTransport(path: string, first: (path: string) => void) {
  const log: string[] = [];
  let writes = 0;
  mockRun.mockImplementation(((o: { scriptTemplate: string }) => {
    if (!isWrite(o)) {
      log.push("pre");
      return Promise.resolve({ ok: true, result: { documentId: "42", fullName: "" } });
    }
    log.push("write");
    writes++;
    if (writes === 1) { first(path); return Promise.resolve(preSaveFailure); }
    return Promise.resolve({ ok: true, result: { path } });
  }) as never);
  return { log };
}

const NOTE_FAILED = "could not be removed and is still in place";
const NOTE_NOT_OURS = "no longer the empty file this call reserved";

/** From now on removing `path` fails (EACCES) even though lstat still works. Independent of the user running the tests. */
function makeUnlinkFail(path: string) {
  fsFault.failUnlinkOf = path;
}

// ── K1, K2: nothing to report ───────────────────────────────────────────────

describe("K1/K2 — the placeholder is gone: the original error, unchanged", () => {
  it("K1: removed → the message is exactly the original one", async () => {
    const { path } = newPath();
    installTransport(path, () => {});

    const error = failure(await saveDocumentTool.handler({ path }));

    expect(error.message).toBe(PRE_SAVE_MESSAGE);
    expect(existsSync(path)).toBe(false);
  });

  it("K2: it had already disappeared before the clean-up → still exactly the original message", async () => {
    const { path } = newPath();
    installTransport(path, (p) => unlinkSync(p));

    const error = failure(await saveDocumentTool.handler({ path }));

    expect(error.message).toBe(PRE_SAVE_MESSAGE);
    expect(existsSync(path)).toBe(false);
  });
});

// ── K3: failed ──────────────────────────────────────────────────────────────

describe("K3 — still ours but not removable", () => {
  it("the error says the file is still in place and the path stays blocked; kind and fields are unchanged", async () => {
    const { path, key } = newPath();
    const t = installTransport(path, (p) => makeUnlinkFail(p));

    const error = failure(await saveDocumentTool.handler({ path }));

    expect(error.kind).toBe("io_error"); // the original classification
    expect(error.entity).toBe("save_precheck");
    expect(error.id).toBe("42");
    expect(error.message.startsWith(`${PRE_SAVE_MESSAGE}. `)).toBe(true);
    expect(error.message).toContain(NOTE_FAILED);
    expect(error.message).toContain(path);
    expect(existsSync(path)).toBe(true);
    expect(lstatSync(path).size).toBe(0);
    expect(wg.registryGet(key)?.state).toBe("uncertain");

    const next = failure(await saveDocumentTool.handler({ path })); // the path really is blocked
    expect(next.kind).toBe("name_collision");
    expect(next.reason).toBe("uncertain");
    expect(t.log).toEqual(["pre", "write", "pre"]);
  });
});

// ── K4: not ours ────────────────────────────────────────────────────────────

describe("K4 — something else is there now: it is left untouched and the error says so", () => {
  it("K4a: it gained content → untouched", async () => {
    const { path } = newPath();
    installTransport(path, (p) => writeFileSync(p, "REAL INDD CONTENT"));

    const error = failure(await saveDocumentTool.handler({ path }));

    expect(error.kind).toBe("io_error");
    expect(error.message.startsWith(`${PRE_SAVE_MESSAGE}. `)).toBe(true);
    expect(error.message).toContain(NOTE_NOT_OURS);
    expect(readFileSync(path, "utf8")).toBe("REAL INDD CONTENT");
  });

  it("K4b: it was replaced by another EMPTY file (different inode) → not deleted", async () => {
    const { path } = newPath();
    let originalInode = -1;
    installTransport(path, (p) => {
      unlinkSync(p);
      writeFileSync(p, "");
      originalInode = lstatSync(p).ino;
    });

    const error = failure(await saveDocumentTool.handler({ path }));

    expect(error.message).toContain(NOTE_NOT_OURS);
    expect(existsSync(path)).toBe(true);
    expect(lstatSync(path).ino).toBe(originalInode); // the same replacement file, never touched again
  });

  it("K4c: it became a symlink → the link and its target survive", async () => {
    const { path } = newPath();
    const other = join(dir, "other.txt");
    writeFileSync(other, "other file");
    installTransport(path, (p) => { unlinkSync(p); symlinkSync(other, p); });

    const error = failure(await saveDocumentTool.handler({ path }));

    expect(error.message).toContain(NOTE_NOT_OURS);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(other, "utf8")).toBe("other file");
  });
});

// ── K5, K6: the branches before dispatch ────────────────────────────────────

describe("K5 — refused by the guard before dispatch", () => {
  it("the placeholder was modified before the guard looked at it: the refusal keeps its kind and reports the file left behind", async () => {
    const { path } = newPath();
    mockRun.mockImplementation((() => Promise.resolve({ ok: true, result: { documentId: "42", fullName: "" } })) as never);
    hook.beforeGuard = (p) => writeFileSync(p, "someone else's data");

    const error = failure(await saveDocumentTool.handler({ path }));

    expect(error.kind).toBe("io_error"); // the guard refusal's own classification
    expect(error.message).toContain(NOTE_NOT_OURS);
    expect(readFileSync(path, "utf8")).toBe("someone else's data");
    expect(mockRun.mock.calls.filter((c) => isWrite(c[0])).length).toBe(0); // nothing was dispatched
  });
});

describe("K6 — an exception before the transport is called", () => {
  it("failed clean-up is reported, and the kind stays write_not_authorized", async () => {
    const { path } = newPath();
    mockRun.mockImplementation((() => Promise.resolve({ ok: true, result: { documentId: "42", fullName: "" } })) as never);
    hook.throwOnFirstCall = true;
    hook.beforeGuard = (p) => makeUnlinkFail(p);

    const error = failure(await saveDocumentTool.handler({ path }));

    expect(error.kind).toBe("write_not_authorized");
    expect(error.message.startsWith("injected failure before dispatch. ")).toBe(true);
    expect(error.message).toContain(NOTE_FAILED);
    expect(existsSync(path)).toBe(true);
  });

  it("not-ours is reported too", async () => {
    const { path } = newPath();
    mockRun.mockImplementation((() => Promise.resolve({ ok: true, result: { documentId: "42", fullName: "" } })) as never);
    hook.throwOnFirstCall = true;
    hook.beforeGuard = (p) => writeFileSync(p, "REAL CONTENT");

    const error = failure(await saveDocumentTool.handler({ path }));

    expect(error.kind).toBe("write_not_authorized");
    expect(error.message).toContain(NOTE_NOT_OURS);
    expect(readFileSync(path, "utf8")).toBe("REAL CONTENT");
  });

  it("a normal clean-up adds nothing", async () => {
    const { path } = newPath();
    mockRun.mockImplementation((() => Promise.resolve({ ok: true, result: { documentId: "42", fullName: "" } })) as never);
    hook.throwOnFirstCall = true;

    const error = failure(await saveDocumentTool.handler({ path }));

    expect(error.message).toBe("injected failure before dispatch");
    expect(existsSync(path)).toBe(false);
  });
});
