/**
 * sendWriteScript — S2: what the registry records after the send (real write-guard,
 * mkdtemp only, no InDesign).
 *
 * Rule under test: the record becomes "owned" only when the send did not throw AND
 * sendFn returned an explicit Envelope success (an object with `ok === true`) AND
 * the target can be stat'ed. Anything else becomes "uncertain" with the fingerprint
 * the decision was verified against (never refreshed from disk). If the record is no
 * longer the "pending" record installed by this send, it belongs to someone else and
 * is left untouched. The returned value stays { ok: true, result }.
 *
 *   V*   returned value matrix, path B and path A
 *   P*   PDF operation
 *   R*   registry replaced / removed while the send is in flight
 *   X*   regressions: send throws, target disappears
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync, realpathSync, writeFileSync, existsSync, lstatSync, unlinkSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decideWrite, sendWriteScript, reservePlaceholder,
  registryGet, registrySet, registryReset,
  type Fingerprint, type RegistryRecord,
} from "../../src/write-guard.js";

let dir: string;
let n = 0;

beforeEach(() => {
  registryReset();
  dir = realpathSync(mkdtempSync(join(tmpdir(), "b8-s2-")));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ZERO: Fingerprint = { dev: 0, ino: 0, size: 0, mtimeMs: 0, ctimeMs: 0 };
const SAVE_BODY = 'doc.save(File("/tmp/x_cod.indd"));';
const EXPORT_BODY = 'doc.exportFile(ExportFormat.PDF_TYPE, File("/tmp/x.pdf.part"), false, preset);';
const wrap = () => vi.fn().mockReturnValue("/* wrapped */");

function fingerprintOf(path: string): Fingerprint {
  const st = lstatSync(path);
  return { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs };
}

function name(ext: string) {
  const file = `s${++n}_cod${ext}`;
  return { path: join(dir, file), key: `${dir}/${file}` };
}

/** Owned INDD + path-B decision for an in-place save. */
async function pathB() {
  const { path, key } = name(".indd");
  writeFileSync(path, "0123456789");
  const seed: RegistryRecord = { state: "owned", documentId: "42", tool: "save_document", fingerprint: fingerprintOf(path) };
  registrySet(key, seed);
  const dr = await decideWrite({ tool: "save_document", operation: "in-place-save", documentId: "42", path, expectedExtension: ".indd" });
  if (!dr.ok) throw new Error("setup: " + dr.reason);
  const send = <R>(sendFn: () => Promise<R>) =>
    sendWriteScript(
      dr.decision,
      { tool: "save_document", documentId: "42", finalPath: path, operation: "in-place-save", scriptOpts: { bodyFn: () => SAVE_BODY } },
      sendFn, wrap(),
    );
  return { path, key, seed, send };
}

/** Free INDD name + path-A decision with a reserved placeholder. */
async function pathA() {
  const { path, key } = name(".indd");
  const dr = await decideWrite({ tool: "save_document", operation: "save-as", documentId: "42", path, expectedExtension: ".indd" });
  if (!dr.ok) throw new Error("setup: " + dr.reason);
  const reserved = reservePlaceholder(path);
  if (!reserved.ok) throw new Error("setup: placeholder");
  const send = <R>(sendFn: () => Promise<R>) =>
    sendWriteScript(
      dr.decision,
      { tool: "save_document", documentId: "42", finalPath: path, operation: "save-as",
        reservedFingerprint: reserved.fingerprint, scriptOpts: { bodyFn: () => SAVE_BODY } },
      sendFn, wrap(),
    );
  return { path, key, send };
}

const failedEnvelope = { ok: false, error: { kind: "io_error", message: "script failed inside InDesign" } };

// Returned values that are NOT proof the write happened (anything but an object with ok === true).
const notProof: Array<[string, unknown]> = [
  ["an object without ok", { path: "x" }],
  ["an empty object", {}],
  ["ok as a string", { ok: "true" }],
  ["ok as a number", { ok: 1 }],
  ["ok undefined", { ok: undefined }],
  ["null", null],
  ["undefined", undefined],
  ["a string", "ok"],
  ["a number", 42],
  ["an array", [{ ok: true }]],
];

// ── V: returned value matrix ────────────────────────────────────────────────

describe("path B — what the returned value does to the record", () => {
  it("V1: explicit success → owned with a fresh fingerprint (file changed by the script)", async () => {
    const { path, key, seed, send } = await pathB();
    const value = { ok: true, result: { path } };

    const r = await send(async () => { writeFileSync(path, "0123456789 saved by InDesign"); return value; });

    expect(r).toEqual({ ok: true, result: value });
    if (r.ok) expect(r.result).toBe(value);
    expect(registryGet(key)?.state).toBe("owned");
    expect(registryGet(key)?.fingerprint.size).toBeGreaterThan(seed.fingerprint.size);
    expect(registryGet(key)?.fingerprint).toEqual(fingerprintOf(path));
  });

  it("V2: ok:false envelope → uncertain with the PRIOR fingerprint, not refreshed", async () => {
    const { path, key, seed, send } = await pathB();

    const r = await send(async () => { writeFileSync(path, "0123456789 changed meanwhile"); return failedEnvelope; });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result).toBe(failedEnvelope);
    expect(registryGet(key)?.state).toBe("uncertain");
    expect(registryGet(key)?.fingerprint).toEqual(seed.fingerprint);
    expect(lstatSync(path).size).not.toBe(seed.fingerprint.size);
  });

  it.each(notProof)("V3: %s → uncertain with the prior fingerprint, result returned unchanged", async (_label, value) => {
    const { key, seed, send } = await pathB();

    const r = await send(async () => value);

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result).toBe(value);
    expect(registryGet(key)?.state).toBe("uncertain");
    expect(registryGet(key)?.fingerprint).toEqual(seed.fingerprint);
  });

  it("V4: explicit success but the target vanished during the send → uncertain, prior fingerprint", async () => {
    const { path, key, seed, send } = await pathB();

    const r = await send(async () => { unlinkSync(path); return { ok: true, result: { path } }; });

    expect(r.ok).toBe(true);
    expect(registryGet(key)?.state).toBe("uncertain");
    expect(registryGet(key)?.fingerprint).toEqual(seed.fingerprint);
  });
});

describe("path A — what the returned value does to the record", () => {
  it("V5: explicit success → owned, fingerprint of the file InDesign wrote", async () => {
    const { path, key, send } = await pathA();

    const r = await send(async () => { writeFileSync(path, "INDD CONTENT"); return { ok: true, result: { path } }; });

    expect(r.ok).toBe(true);
    expect(registryGet(key)?.state).toBe("owned");
    expect(registryGet(key)?.fingerprint.size).toBe(12);
  });

  it("V6: ok:false envelope → uncertain with a zero fingerprint (nothing proven, nothing refreshed)", async () => {
    const { path, key, send } = await pathA();

    const r = await send(async () => { writeFileSync(path, "partial"); return failedEnvelope; });

    expect(r.ok).toBe(true);
    expect(registryGet(key)?.state).toBe("uncertain");
    expect(registryGet(key)?.fingerprint).toEqual(ZERO);
  });

  it.each(notProof)("V7: %s → uncertain with a zero fingerprint", async (_label, value) => {
    const { key, send } = await pathA();

    const r = await send(async () => value);

    expect(r.ok).toBe(true);
    expect(registryGet(key)?.state).toBe("uncertain");
    expect(registryGet(key)?.fingerprint).toEqual(ZERO);
  });
});

// ── P: PDF ──────────────────────────────────────────────────────────────────

describe("PDF operation", () => {
  async function pdf() {
    const { path, key } = name(".pdf");
    const dr = await decideWrite({ tool: "export_pdf", operation: "export-pdf", documentId: "42", path, expectedExtension: ".pdf" });
    if (!dr.ok) throw new Error("setup: " + dr.reason);
    const send = <R>(sendFn: () => Promise<R>) =>
      sendWriteScript(
        dr.decision,
        { tool: "export_pdf", documentId: "42", finalPath: path, operation: "export-pdf", scriptOpts: { bodyFn: () => EXPORT_BODY } },
        sendFn, wrap(),
      );
    return { path, key, send };
  }

  it("P1: explicit success → uncertain, because the final path does not exist yet (publish records owned later)", async () => {
    const { key, send } = await pdf();
    const r = await send(async () => ({ ok: true, result: { path: "x.part", page_count: 1 } }));
    expect(r.ok).toBe(true);
    expect(registryGet(key)?.state).toBe("uncertain");
  });

  it("P2: ok:false envelope → uncertain", async () => {
    const { key, send } = await pdf();
    const r = await send(async () => failedEnvelope);
    expect(r.ok).toBe(true);
    expect(registryGet(key)?.state).toBe("uncertain");
  });

  it("P3: ok:false envelope while a file appeared at the final path → still uncertain, never owned", async () => {
    const { path, key, send } = await pdf();
    const r = await send(async () => { writeFileSync(path, "%PDF-1.4"); return failedEnvelope; });
    expect(r.ok).toBe(true);
    expect(registryGet(key)?.state).toBe("uncertain");
  });
});

// ── R: registry replaced or removed while the send is in flight ─────────────

describe("the record changes while the send is in flight — it is not ours to overwrite", () => {
  const other: RegistryRecord = {
    state: "owned",
    documentId: "99",
    tool: "export_pdf",
    fingerprint: { dev: 7, ino: 7, size: 7, mtimeMs: 7, ctimeMs: 7 },
  };

  it.each([
    ["explicit success", async (p: string) => ({ ok: true, result: { path: p } })],
    ["an ok:false envelope", async () => failedEnvelope],
    ["a non-envelope value", async () => "whatever"],
  ] as const)("R1: another operation's record replaces ours (%s) → left exactly as it is", async (_label, produce) => {
    const { path, key, send } = await pathB();

    const r = await send(async () => { registrySet(key, other); return produce(path); });

    expect(r.ok).toBe(true);
    expect(registryGet(key)).toBe(other); // same object: not overwritten with owned or uncertain
  });

  it.each([
    ["explicit success", async (p: string) => ({ ok: true, result: { path: p } })],
    ["an ok:false envelope", async () => failedEnvelope],
  ] as const)("R2: the record is removed (%s) → stays removed: no owned, no uncertain written", async (_label, produce) => {
    const { path, key, send } = await pathB();

    const r = await send(async () => { registryReset(); return produce(path); });

    expect(r.ok).toBe(true);
    expect(registryGet(key)).toBeUndefined(); // "no record" = not owned = refused next time (path C)
  });

  it("R3: the send throws and another operation's record replaced ours → that record is left alone", async () => {
    const { key, send } = await pathB();

    const r = await send(async () => { registrySet(key, other); throw new Error("osascript died"); });

    expect(r.ok).toBe(false);
    expect(registryGet(key)).toBe(other);
  });

  it("R4: after R2 the next write to that path is refused (no record → path C), not allowed", async () => {
    const { path, key, send } = await pathB();
    await send(async () => { registryReset(); return { ok: true, result: { path } }; });
    expect(registryGet(key)).toBeUndefined();

    const next = await decideWrite({ tool: "save_document", operation: "in-place-save", documentId: "42", path, expectedExtension: ".indd" });
    expect(next.ok).toBe(false);
    if (!next.ok) expect(next.reason).toBe("not_owned");
  });
});

// ── X: regressions ──────────────────────────────────────────────────────────

describe("regressions", () => {
  it("X1: the send throws → uncertain with the prior fingerprint, and the guard returns the same failure shape", async () => {
    const { key, seed, send } = await pathB();

    const r = await send(async () => { throw new Error("osascript died"); });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("io_error");
      expect(r.reason).toBe("uncertain");
      expect(r.message).toContain("osascript died");
    }
    expect(registryGet(key)?.state).toBe("uncertain");
    expect(registryGet(key)?.fingerprint).toEqual(seed.fingerprint);
  });

  it("X2: while the send is in flight the record is 'pending'", async () => {
    const { key, send } = await pathB();
    let during: RegistryRecord | undefined;

    await send(async () => { during = registryGet(key); return { ok: true, result: {} }; });

    expect(during?.state).toBe("pending");
  });

  it("X3: a refusal before the send leaves the record untouched", async () => {
    const { path, key, seed, send } = await pathB();
    writeFileSync(path, "0123456789 changed before the send"); // fingerprint no longer matches

    const r = await send(async () => ({ ok: true, result: {} }));

    expect(r.ok).toBe(false);
    expect(registryGet(key)).toEqual(seed);
    expect(existsSync(path)).toBe(true);
  });
});
