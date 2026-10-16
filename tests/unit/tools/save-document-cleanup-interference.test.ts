/**
 * save_document path A — clean-up classification when something outside interferes WHILE the
 * clean-up runs. Real write-guard, mocked InDesign transport, real files in mkdtemp. No InDesign.
 *
 * save-document-cleanup.test.ts (K1-K6) changes the world before the clean-up starts. Here the
 * write-guard mock wraps cleanupPlaceholder (which itself is NOT changed and is still the real
 * one) so that a file can be swapped at exactly two moments:
 *
 *    before-stat -> [ beforeInner ] -> cleanupPlaceholder's own lstat/unlink -> [ afterInner ] -> after-stat
 *
 *   I1  a foreign file replaces the placeholder at beforeInner -> cleanupPlaceholder refuses to
 *       delete it; the tool must say "not ours", never "could not be removed"
 *   I2  our placeholder is removed, then a foreign file is created at afterInner -> "not ours",
 *       never "could not be removed" (ours is gone)
 *   I3  control: our placeholder is still there and cannot be removed -> "failed"
 *   I4  the placeholder vanishes at beforeInner (a third party removed it) -> nothing to report
 *   I5  nothing was there before, a foreign file appears -> "not ours"
 *
 * Not covered, and not coverable here: a swap between cleanupPlaceholder's own lstat and its
 * unlinkSync (inside write-guard.ts, unchanged). There the foreign file would be removed and the
 * tool would report "removed".
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
  beforeInner: null as null | ((path: string) => void),
  afterInner: null as null | ((path: string) => void),
}));

vi.mock("../../../src/write-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/write-guard.js")>();
  return {
    ...actual,
    // Same behaviour as the real cleanupPlaceholder; only the two interference points are added.
    cleanupPlaceholder: ((path: string, inode: number) => {
      hook.beforeInner?.(path);
      actual.cleanupPlaceholder(path, inode);
      hook.afterInner?.(path);
    }) as typeof actual.cleanupPlaceholder,
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
  hook.beforeInner = null;
  hook.afterInner = null;
  fsFault.failUnlinkOf = null;
  wg.registryReset();
  dir = realpathSync(mkdtempSync(join(tmpdir(), "b8-interf-")));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function newPath() {
  const name = `interf_${++counter}_cod.indd`;
  return join(dir, name);
}

function failure(env: Envelope<unknown>) {
  expect(env.ok).toBe(false);
  if (env.ok) throw new Error("expected a failure envelope");
  return env.error;
}

const isWrite = (o: unknown) => (o as { scriptTemplate: string }).scriptTemplate.includes("doc.save(File(");
const PRE_SAVE_MESSAGE = "document changed between query and save: expected fullName , found /elsewhere.indd";
/** A failure that PROVES the script never reached doc.save, so the clean-up runs. */
const preSaveFailure = { ok: false, error: { kind: "io_error", entity: "save_precheck", id: "42", message: PRE_SAVE_MESSAGE } };

function installTransport() {
  mockRun.mockImplementation(((o: { scriptTemplate: string }) => {
    if (!isWrite(o)) return Promise.resolve({ ok: true, result: { documentId: "42", fullName: "" } });
    return Promise.resolve(preSaveFailure);
  }) as never);
}

const NOTE_FAILED = "could not be removed and is still in place";
const NOTE_NOT_OURS = "no longer the empty file this call reserved";

describe("I1 — a foreign file replaces the placeholder just before cleanupPlaceholder looks at it", () => {
  const replacements: Array<[string, (p: string) => void, (p: string) => void]> = [
    ["a file with content", (p) => { unlinkSync(p); writeFileSync(p, "FOREIGN CONTENT"); },
      (p) => expect(readFileSync(p, "utf8")).toBe("FOREIGN CONTENT")],
    ["another EMPTY file (different inode)", (p) => { unlinkSync(p); writeFileSync(p, ""); },
      (p) => expect(lstatSync(p).size).toBe(0)],
    ["a symlink", (p) => { unlinkSync(p); symlinkSync(join(dir, "target.txt"), p); },
      (p) => { expect(lstatSync(p).isSymbolicLink()).toBe(true); expect(readFileSync(join(dir, "target.txt"), "utf8")).toBe("target"); }],
  ];

  it.each(replacements)("%s → classified not-ours (not 'could not be removed'); the foreign file is untouched", async (_label, swap, verify) => {
    const path = newPath();
    writeFileSync(join(dir, "target.txt"), "target");
    installTransport();
    let inodeSeen = -1;
    hook.beforeInner = (p) => { inodeSeen = lstatSync(p).ino; swap(p); }; // our placeholder was there; now it is swapped

    const error = failure(await saveDocumentTool.handler({ path }));

    expect(inodeSeen).toBeGreaterThan(0); // our placeholder really was there when the clean-up started
    expect(error.kind).toBe("io_error"); // the original classification
    expect(error.message.startsWith(`${PRE_SAVE_MESSAGE}. `)).toBe(true);
    expect(error.message).toContain(NOTE_NOT_OURS);
    expect(error.message).not.toContain(NOTE_FAILED); // the old classification said this, wrongly
    expect(existsSync(path)).toBe(true);
    verify(path);
  });
});

describe("I2 — our placeholder is removed, then a foreign file appears before the final check", () => {
  it("is classified not-ours (not 'could not be removed'); the new file is untouched and is not our old inode", async () => {
    const path = newPath();
    installTransport();
    let ourInode = -1;
    hook.beforeInner = (p) => { ourInode = lstatSync(p).ino; }; // record which file is OURS
    hook.afterInner = (p) => { writeFileSync(p, "FOREIGN CREATED AFTER OUR REMOVAL"); };

    const error = failure(await saveDocumentTool.handler({ path }));

    expect(error.kind).toBe("io_error");
    expect(error.message).toContain(NOTE_NOT_OURS);
    expect(error.message).not.toContain(NOTE_FAILED);
    expect(readFileSync(path, "utf8")).toBe("FOREIGN CREATED AFTER OUR REMOVAL");
    expect(lstatSync(path).ino).not.toBe(ourInode); // ours was removed; what is there is a different file
  });
});

describe("I3 — control: it is still our empty placeholder and cannot be removed", () => {
  it("is classified failed", async () => {
    const path = newPath();
    installTransport();
    hook.beforeInner = (p) => { fsFault.failUnlinkOf = p; }; // removing our placeholder will fail

    const error = failure(await saveDocumentTool.handler({ path }));

    expect(error.kind).toBe("io_error");
    expect(error.message).toContain(NOTE_FAILED);
    expect(error.message).not.toContain(NOTE_NOT_OURS);
    expect(lstatSync(path).size).toBe(0);
  });
});

describe("I4 / I5 — a third party removes it, or a file appears where nothing was", () => {
  it("I4: the placeholder vanishes just before the clean-up looks → nothing to report", async () => {
    const path = newPath();
    installTransport();
    hook.beforeInner = (p) => unlinkSync(p);

    const error = failure(await saveDocumentTool.handler({ path }));

    expect(error.message).toBe(PRE_SAVE_MESSAGE); // the original error, unchanged
    expect(existsSync(path)).toBe(false);
  });

  it("I5: nothing was there before the clean-up, then a foreign file appears → not-ours", async () => {
    const path = newPath();
    mockRun.mockImplementation(((o: { scriptTemplate: string }) => {
      if (!isWrite(o)) return Promise.resolve({ ok: true, result: { documentId: "42", fullName: "" } });
      unlinkSync(path); // the placeholder is gone before the clean-up starts (the transport "removed" it)
      return Promise.resolve(preSaveFailure);
    }) as never);
    hook.beforeInner = (p) => writeFileSync(p, "FOREIGN APPEARED");

    const error = failure(await saveDocumentTool.handler({ path }));

    expect(error.message).toContain(NOTE_NOT_OURS);
    expect(readFileSync(path, "utf8")).toBe("FOREIGN APPEARED");
  });
});
