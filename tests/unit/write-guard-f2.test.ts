/**
 * write-guard — F2 tests (real write-guard, mkdtemp only, no InDesign).
 *
 *   G-F*   assertWriteAllowed on path B, one test per fingerprint field (F2-4).
 *          `dev` cannot be changed on a real file, so every field is varied through
 *          a mocked lstatSync (simulation, stated in the test names).
 *   G-D*   refusal BEFORE the decision is consumed vs failure AFTER it is consumed (F2-8).
 *   G-R*   sendWriteScript and an ok:false transport envelope (F2-7, after S2): the
 *          record becomes "uncertain" with the PRIOR fingerprint. Broader coverage of
 *          return values and registry races is in write-guard-s2.test.ts.
 *   G-C*   cleanupPlaceholder: ownership proof (F2-6) and synchronous deletion (F2-9).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync, realpathSync, writeFileSync, existsSync, lstatSync, unlinkSync,
  symlinkSync, readFileSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const lstatOverride = vi.hoisted(() => ({ patch: null as null | Record<string, number> }));
// Makes unlinkSync fail for ONE path with EACCES, whatever user runs the tests (a read-only
// directory would not stop root). cleanupPlaceholder imports unlinkSync from "node:fs", so it
// sees this fault and swallows it exactly as it would a real one.
const fsFault = vi.hoisted(() => ({ failUnlinkOf: null as string | null }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: ((...a: unknown[]) => {
      const st = (actual.lstatSync as (...x: unknown[]) => import("node:fs").Stats)(...a);
      if (lstatOverride.patch === null || !st) return st;
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, lstatOverride.patch);
    }) as typeof actual.lstatSync,
    unlinkSync: ((p: unknown, ...rest: unknown[]) => {
      if (fsFault.failUnlinkOf !== null && String(p) === fsFault.failUnlinkOf) {
        throw Object.assign(new Error(`EACCES: permission denied, unlink '${String(p)}'`), { code: "EACCES" });
      }
      return (actual.unlinkSync as (...a: unknown[]) => void)(p, ...rest);
    }) as typeof actual.unlinkSync,
  };
});

import {
  decideWrite, sendWriteScript, reservePlaceholder, cleanupPlaceholder,
  registryGet, registrySet, registryReset,
  type Fingerprint,
} from "../../src/write-guard.js";

let dir: string;
let n = 0;

beforeEach(() => {
  registryReset();
  lstatOverride.patch = null;
  fsFault.failUnlinkOf = null;
  dir = realpathSync(mkdtempSync(join(tmpdir(), "b8-f2g-")));
});

afterEach(() => {
  lstatOverride.patch = null;
  rmSync(dir, { recursive: true, force: true });
});

const GOOD_BODY = 'doc.save(File("/tmp/x_cod.indd"));';

function newName() {
  const name = `g${++n}_cod.indd`;
  return { path: join(dir, name), key: `${dir}/${name}` };
}

function fingerprintOf(path: string): Fingerprint {
  const st = lstatSync(path);
  return { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs };
}

/** An owned file and a path-B decision for an in-place save. */
async function pathBDecision() {
  const { path, key } = newName();
  writeFileSync(path, "0123456789");
  const seed = { state: "owned" as const, documentId: "42", tool: "save_document", fingerprint: fingerprintOf(path) };
  registrySet(key, seed);
  const dr = await decideWrite({ tool: "save_document", operation: "in-place-save", documentId: "42", path, expectedExtension: ".indd" });
  if (!dr.ok) throw new Error("setup: expected a path-B decision, got " + dr.reason);
  return { path, key, seed, decision: dr.decision };
}

function request(path: string, bodyFn: () => string = () => GOOD_BODY) {
  return {
    tool: "save_document",
    documentId: "42",
    finalPath: path,
    operation: "in-place-save" as const,
    scriptOpts: { bodyFn },
  };
}

// ── G-F: per-field TOCTOU on assertWriteAllowed (path B) ─────────────────────

describe("assertWriteAllowed path B — each fingerprint field changed between decision and send", () => {
  it.each(["dev", "ino", "size", "mtimeMs", "ctimeMs"] as const)(
    "G-F: %s differs (simulated via mocked lstat) → fingerprint_mismatch, zero sends, registry unchanged",
    async (field) => {
      const { path, key, seed, decision } = await pathBDecision();
      const sendFn = vi.fn();
      const wrapFn = vi.fn();
      const bodyFn = vi.fn(() => GOOD_BODY);
      lstatOverride.patch = { [field]: seed.fingerprint[field] + 1 };

      const r = await sendWriteScript(decision, request(path, bodyFn), sendFn, wrapFn);

      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe("fingerprint_mismatch");
      expect(sendFn).not.toHaveBeenCalled();
      expect(wrapFn).not.toHaveBeenCalled();
      expect(bodyFn).not.toHaveBeenCalled(); // the body is not even built
      expect(registryGet(key)).toEqual(seed);
    },
  );
});

// ── G-D: decision state — refusal before consumption vs failure after it ────

describe("F2-8 — a refusal BEFORE the decision is consumed leaves it unused", () => {
  const sendFn = () => vi.fn().mockResolvedValue({ ok: true, result: { path: "x" } });

  it.each([
    ["the file changed (fingerprint)", "fingerprint"],
    ["the request names another document", "documentId"],
    ["the request names another operation", "operation"],
    ["the request names another path", "finalPath"],
  ] as const)("G-D1: %s → refused, decision not consumed, accepted once the request is right", async (_label, kind) => {
    const { path, seed, decision } = await pathBDecision();
    const send = sendFn();
    const wrap = vi.fn().mockReturnValue("/* wrapped */");
    const bad = { ...request(path) };
    if (kind === "documentId") bad.documentId = "43";
    if (kind === "operation") (bad as { operation: string }).operation = "save-as";
    if (kind === "finalPath") bad.finalPath = path + ".other";
    if (kind === "fingerprint") lstatOverride.patch = { size: seed.fingerprint.size + 1 };

    const refused = await sendWriteScript(decision, bad, send, wrap);
    expect(refused.ok).toBe(false);
    expect(send).not.toHaveBeenCalled();

    lstatOverride.patch = null;
    const accepted = await sendWriteScript(decision, request(path), send, wrap);
    expect(accepted.ok).toBe(true); // same decision object: it was never consumed
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("G-D2: while the file stays changed the unused decision keeps being refused for the fingerprint, not for 'already used'", async () => {
    const { path, seed, decision } = await pathBDecision();
    lstatOverride.patch = { size: seed.fingerprint.size + 1 };
    for (let i = 0; i < 2; i++) {
      const r = await sendWriteScript(decision, request(path), vi.fn(), vi.fn());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("fingerprint_mismatch");
    }
  });
});

describe("F2-8 — a failure AFTER the decision is consumed consumes it for good", () => {
  const okEnvelope = { ok: true, result: { path: "x" } };
  const failedEnvelope = { ok: false, error: { kind: "io_error", message: "script failed" } };

  type Case = {
    name: string;
    body?: () => string;
    send?: () => Promise<unknown>;
    wrap?: () => string;
    rejects: boolean; // does sendWriteScript itself throw?
  };
  const cases: Case[] = [
    { name: "the body builder throws", body: () => { throw new Error("body builder failed"); }, rejects: true },
    { name: "validateOperationBody rejects the body", body: () => "return 1;", rejects: true },
    { name: "wrapExtendScript / capability throws", wrap: () => { throw new Error("capability rejected"); }, rejects: true },
    { name: "the send itself throws", send: () => Promise.reject(new Error("osascript died")), rejects: false },
    { name: "the transport answers with an ok:false envelope", send: () => Promise.resolve(failedEnvelope), rejects: false },
  ];

  it.each(cases)("G-D3: $name → decision consumed; reuse is refused as 'already used'", async (c) => {
    const { path, decision } = await pathBDecision();
    const send = vi.fn(c.send ?? (() => Promise.resolve(okEnvelope)));
    const wrap = vi.fn(c.wrap ?? (() => "/* wrapped */"));
    const first = sendWriteScript(decision, request(path, c.body ?? (() => GOOD_BODY)), send, wrap);
    if (c.rejects) await expect(first).rejects.toThrow();
    else await first;

    const sendsBefore = send.mock.calls.length;
    const reuse = await sendWriteScript(decision, request(path), send, wrap);
    expect(reuse.ok).toBe(false);
    if (!reuse.ok) expect(reuse.message).toContain("already been used");
    expect(send.mock.calls.length).toBe(sendsBefore); // the reuse sent nothing
  });

  it("G-D4: the send throwing also leaves the record uncertain", async () => {
    const { path, key, decision } = await pathBDecision();
    const r = await sendWriteScript(decision, request(path), vi.fn().mockRejectedValue(new Error("osascript died")), vi.fn().mockReturnValue("/* wrapped */"));
    expect(r.ok).toBe(false);
    expect(registryGet(key)?.state).toBe("uncertain");
  });
});

// ── G-R: sendWriteScript and an ok:false envelope (after S2) ────────────────

describe("sendWriteScript and an ok:false transport envelope (F2-7, after S2)", () => {
  const failedEnvelope = { ok: false, error: { kind: "io_error", message: "script failed inside InDesign" } };

  it("G-R1: path B — returns ok (the envelope is just its result) but records 'uncertain' with the PRIOR fingerprint, never refreshed", async () => {
    const { path, key, seed, decision } = await pathBDecision();
    const sendFn = vi.fn().mockImplementation(async () => {
      writeFileSync(path, "0123456789 changed while the script ran");
      return failedEnvelope;
    });
    const wrapFn = vi.fn().mockReturnValue("/* wrapped */");

    const r = await sendWriteScript(decision, request(path), sendFn, wrapFn);

    expect(r.ok).toBe(true); // "the send completed"; callers inspect the envelope
    if (r.ok) expect(r.result).toBe(failedEnvelope);
    expect(registryGet(key)?.state).toBe("uncertain");
    expect(registryGet(key)?.fingerprint).toEqual(seed.fingerprint);
    expect(lstatSync(path).size).not.toBe(seed.fingerprint.size); // proves it was not refreshed from disk
  });

  it("G-R2: path A — records 'uncertain' with a zero fingerprint after a failed envelope", async () => {
    const { path, key } = newName();
    const dr = await decideWrite({ tool: "save_document", operation: "save-as", documentId: "42", path, expectedExtension: ".indd" });
    if (!dr.ok) throw new Error("setup");
    const reserved = reservePlaceholder(path);
    if (!reserved.ok) throw new Error("setup");
    const sendFn = vi.fn().mockResolvedValue(failedEnvelope);
    const wrapFn = vi.fn().mockReturnValue("/* wrapped */");

    const r = await sendWriteScript(
      dr.decision,
      { tool: "save_document", documentId: "42", finalPath: path, operation: "save-as",
        reservedFingerprint: reserved.fingerprint, scriptOpts: { bodyFn: () => GOOD_BODY } },
      sendFn, wrapFn,
    );

    expect(r.ok).toBe(true);
    expect(registryGet(key)?.state).toBe("uncertain");
    expect(registryGet(key)?.fingerprint).toEqual({ dev: 0, ino: 0, size: 0, mtimeMs: 0, ctimeMs: 0 });
  });
});

// ── G-C: cleanupPlaceholder ─────────────────────────────────────────────────

describe("cleanupPlaceholder — ownership proof (F2-6) and synchronous deletion (F2-9)", () => {
  function reserve() {
    const { path } = newName();
    const r = reservePlaceholder(path);
    if (!r.ok) throw new Error("setup");
    return { path, ino: r.fingerprint.ino };
  }

  it("G-C1: the placeholder we reserved (same inode, empty) is gone BEFORE the function returns", () => {
    const { path, ino } = reserve();
    cleanupPlaceholder(path, ino);
    expect(existsSync(path)).toBe(false); // checked immediately, no waiting
  });

  it("G-C2: a file that replaced it (different inode, also empty) is NOT removed", () => {
    const { path, ino } = reserve();
    unlinkSync(path);
    writeFileSync(path, "");
    expect(lstatSync(path).ino).not.toBe(ino);
    cleanupPlaceholder(path, ino);
    expect(existsSync(path)).toBe(true);
  });

  it("G-C3: a placeholder that gained content is NOT removed, content intact", () => {
    const { path, ino } = reserve();
    writeFileSync(path, "not ours any more");
    cleanupPlaceholder(path, ino);
    expect(readFileSync(path, "utf8")).toBe("not ours any more");
  });

  it("G-C4: a symlink at the path is NOT removed and its target is untouched", () => {
    const { path, ino } = reserve();
    const other = join(dir, "other.txt");
    writeFileSync(other, "other file");
    unlinkSync(path);
    symlinkSync(other, path);
    cleanupPlaceholder(path, ino);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(other, "utf8")).toBe("other file");
  });

  it("G-C5: a missing path is silently ignored", () => {
    const { path } = newName();
    expect(() => cleanupPlaceholder(path, 1)).not.toThrow();
  });

  it("G-C6: an unlink error (EACCES, injected) is swallowed and the file stays", () => {
    const { path } = newName();
    const r = reservePlaceholder(path);
    if (!r.ok) throw new Error("setup");
    fsFault.failUnlinkOf = path; // removing exactly this file fails, for any user

    expect(() => cleanupPlaceholder(path, r.fingerprint.ino)).not.toThrow();

    expect(existsSync(path)).toBe(true); // it was ours (same inode, empty): the removal really failed
    expect(lstatSync(path).size).toBe(0);
    fsFault.failUnlinkOf = null;
    cleanupPlaceholder(path, r.fingerprint.ino); // and without the fault the same call removes it
    expect(existsSync(path)).toBe(false);
  });
});
