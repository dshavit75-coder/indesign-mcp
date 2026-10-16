/**
 * Unit tests for export-pdf.ts (write-guard integration and hardening).
 *
 * Stage 4 tests:
 *   P1 — successful export returns path and page_count
 *   P7 — existing PDF target → pdf_replace_blocked
 *   P-pre-query-fail, P-precheck-existing, P-send-fail-zero, P-send-fail-nonzero,
 *   P-transport-fail, P-publish-fail-eexist
 *
 * Hardening tests (PX*): the tool's own code never removes the temporary `.part` file and only reports
 * what it observes; an absent / non-regular / empty file is never published; guard refusals are told
 * apart from other exceptions; a publish failure is classified by the guard's own message.
 *
 *   PX1a/PX1a2  REAL guard (mkdtemp): capability mismatch / operation_body_mismatch → write_not_authorized
 *   PX1b/PX1c   other exception → rethrown unchanged; exception after the send began → io_error, unknown outcome
 *   PX2, PX3*   empty / absent / unreadable / non-regular temporary file → not published
 *   PX5*, PX6*  link failure classification (guard's message decides; target state is information only)
 *   PX8a/PX8b   no deletion by this tool: runtime matrix with state swaps between checks + static scan
 *   PX9, PX10   InDesign envelope failure keeps kind and fields
 *   PX11*       warnings after a successful publish (observed state only)
 *   PX12a       existing PDF refused before any send
 *   PX12b/PX12c REAL publishPdfPart on real files: EEXIST race / non-EEXIST link failure
 *   PX13        REAL publishPdfPart: successful publish
 *
 * NOT deletion-free overall: publishPdfPart (write-guard.ts) removes the temporary NAME with fs.unlink after
 * a successful link, by path and without inode verification. That is unchanged and outside this file's scope;
 * PX13 documents it. PX12b/PX12c only show that this removal is not reached on the failure paths they run.
 *
 * Strategy: boundary modules are mocked (InDesign transport always). Real-guard tests (PX1a, PX1a2, PX12b,
 * PX12c, PX13) use the real write-guard against an mkdtemp directory; no InDesign is involved.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";

// ── Shared mutable state for the mock factories ───────────────────────────────
// lstatSync is non-configurable in Node 22 (vi.spyOn fails), so the whole module is mocked and each test
// overrides a callback.

let _lstatImpl: (path: string) => { isFile: () => boolean; size: number } = () => {
  const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  throw err; // default: file absent
};

/** Spies on every way of deleting a file. They delegate to the real functions. */
const del = vi.hoisted(() => ({
  unlinkSync: vi.fn(),
  rmSync: vi.fn(),
  unlink: vi.fn(),
  rm: vi.fn(),
  pUnlink: vi.fn(),
  pRm: vi.fn(),
  /** When set, the next fs/promises link() rejects with it (root-independent fault injection). */
  linkFault: null as Error | null,
}));

// ── Mocks must be hoisted before any import of the module under test ──────────

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  type Fn = (...a: unknown[]) => unknown;
  del.unlinkSync.mockImplementation((...a: unknown[]) => (actual.unlinkSync as unknown as Fn)(...a));
  del.rmSync.mockImplementation((...a: unknown[]) => (actual.rmSync as unknown as Fn)(...a));
  del.pUnlink.mockImplementation((...a: unknown[]) => (actual.promises.unlink as unknown as Fn)(...a));
  del.pRm.mockImplementation((...a: unknown[]) => (actual.promises.rm as unknown as Fn)(...a));
  return {
    ...actual,
    lstatSync: (path: string) => _lstatImpl(path),
    unlinkSync: del.unlinkSync,
    rmSync: del.rmSync,
    promises: { ...actual.promises, unlink: del.pUnlink, rm: del.pRm },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  type Fn = (...a: unknown[]) => unknown;
  del.unlink.mockImplementation((...a: unknown[]) => (actual.unlink as unknown as Fn)(...a));
  del.rm.mockImplementation((...a: unknown[]) => (actual.rm as unknown as Fn)(...a));
  return {
    ...actual,
    unlink: del.unlink,
    rm: del.rm,
    link: ((a: string, b: string) =>
      del.linkFault !== null ? Promise.reject(del.linkFault) : actual.link(a, b)) as typeof actual.link,
  };
});

vi.mock("../../../src/write-guard.js", () => ({
  decideWrite: vi.fn(),
  sendWriteScript: vi.fn(),
  publishPdfPart: vi.fn(),
}));

vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

vi.mock("../../../src/path-utils.js", () => ({
  resolveUserPath: (p: string) => (p.startsWith("/") ? p : "/resolved/" + p),
}));

// ── Now import the module under test ─────────────────────────────────────────

import { exportPdfTool } from "../../../src/tools/export-pdf.js";
import * as wg from "../../../src/write-guard.js";
import * as rf from "../../../src/transport/result-file.js";

// The real modules, for the tests that run the real guard and for cleaning up test directories.
const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const realWg = await vi.importActual<typeof import("../../../src/write-guard.js")>("../../../src/write-guard.js");

const mockDecideWrite = vi.mocked(wg.decideWrite);
const mockSendWriteScript = vi.mocked(wg.sendWriteScript);
const mockPublishPdfPart = vi.mocked(wg.publishPdfPart);
const mockRunScript = vi.mocked(rf.runScriptWithResultFile);

// ── Shared fixtures ───────────────────────────────────────────────────────────

const DOC_ID = "77";
const FINAL_PATH = "/Users/test/export/output.pdf";
const FINAL_DIR = "/Users/test/export";
const MARKER = ".indesign-mcp-";
/** What publishPdfPart reports for an EEXIST on link (write-guard.ts:800). The real text is pinned by PX12b. */
const GUARD_EEXIST_MESSAGE = `final PDF path was taken during export: ${JSON.stringify(FINAL_PATH)}`;

function makeDecision() {
  return Object.freeze({
    savePath: "pdf" as const,
    finalPath: FINAL_PATH,
    registryKey: FINAL_PATH,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockPreQueryOk(documentId = DOC_ID) {
  mockRunScript.mockResolvedValueOnce({
    ok: true,
    result: { documentId },
  } as never);
}

function mockPreQueryNotFound() {
  mockRunScript.mockResolvedValueOnce({
    ok: false,
    error: { kind: "not_found", message: "no open document" },
  } as never);
}

function mockDecisionOk() {
  mockDecideWrite.mockResolvedValueOnce({ ok: true, decision: makeDecision() } as never);
}

/** Set lstatSync to throw ENOENT for every call (partPath absent = pre-check passes). */
function mockLstatEnoent() {
  _lstatImpl = () => {
    const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    throw err;
  };
}

/** Set lstatSync to return a stat with the given size (used for cleanup logic tests). */
function mockLstatSize(size: number) {
  _lstatImpl = () => ({ isFile: () => true, size });
}

/**
 * Set lstatSync with a sequence of behaviours.
 * Each element is either "enoent" or a numeric size.
 */
function mockLstatSequence(seq: Array<"enoent" | number>) {
  let i = 0;
  _lstatImpl = () => {
    const spec = seq[i++] ?? "enoent";
    if (spec === "enoent") {
      const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      throw err;
    }
    return { isFile: () => true, size: spec };
  };
}

type Spec = "absent" | "eacces" | "other" | number;

function statOf(spec: Spec) {
  if (spec === "absent") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  if (spec === "eacces") throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  if (spec === "other") return { isFile: () => false, size: 0 };
  return { isFile: () => true, size: spec };
}

/**
 * Path-aware lstat. The temporary path (".indesign-mcp-") and the final path each follow their own sequence
 * (the last entry repeats). Part sequence in the handler: [pre-check, then the inspections that follow].
 */
function mockLstatPaths(seqs: { part: Spec[]; final?: Spec[] }) {
  const idx = { part: 0, final: 0 };
  _lstatImpl = (p: string) => {
    const key = p.includes(MARKER) ? "part" : "final";
    const seq = key === "part" ? seqs.part : (seqs.final ?? ["absent"]);
    const spec = seq[Math.min(idx[key]++, seq.length - 1)];
    return statOf(spec);
  };
}

/** No deletion of any kind was attempted through any of the spied functions. */
function expectNoDeletion() {
  for (const f of [del.unlinkSync, del.rmSync, del.unlink, del.rm, del.pUnlink, del.pRm]) {
    expect(f).not.toHaveBeenCalled();
  }
}

const SEND_OK = { ok: true, result: { ok: true, result: { path: FINAL_PATH, page_count: 2 } } };

// ── Reset mocks before each test ──────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockDecideWrite.mockReset();
  mockSendWriteScript.mockReset();
  mockPublishPdfPart.mockReset();
  mockRunScript.mockReset();
  del.linkFault = null;
  // Reset lstatSync to default (ENOENT) between tests
  _lstatImpl = () => {
    const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    throw err;
  };
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("export_pdf — write-guard integration (Stage 4)", () => {

  // P1: successful export end-to-end
  it("P1: successful export returns path and page_count", async () => {
    mockPreQueryOk();

    mockDecisionOk();

    // part file: absent before the export; regular and non-empty when checked before publishing;
    // gone after publishPdfPart (which removes the temporary name).
    mockLstatPaths({ part: ["absent", 4096, "absent"] });

    // Mock returns Envelope<ScriptResult> as the inner result (what runScriptWithResultFile produces)
    mockSendWriteScript.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, result: { path: FINAL_PATH, page_count: 4 } },
    } as never);

    mockPublishPdfPart.mockResolvedValueOnce({ ok: true } as never);

    const result = await exportPdfTool.handler({ path: FINAL_PATH });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // MCP contract: single flat envelope — path and page_count at result level, not nested
      expect(result.result?.path).toBe(FINAL_PATH);
      expect(result.result?.page_count).toBe(4);
      // Confirm no double-wrapping: result must not have an inner 'ok' field
      expect((result.result as Record<string, unknown>).ok).toBeUndefined();
      // Nothing is left at the temporary path, so nothing is reported
      expect(result.warnings).toBeUndefined();
    }

    // sendWriteScript must have been called with a bodyFn writing to partPath,
    // NOT to finalPath (bodyFn is called lazily — invoke it to check the body)
    const sendCall = mockSendWriteScript.mock.calls[0];
    expect(sendCall).toBeDefined();
    const bodyFn = sendCall[1].scriptOpts.bodyFn as () => string;
    expect(typeof bodyFn).toBe("function");
    const scriptBody = bodyFn();
    expect(scriptBody).not.toContain(FINAL_PATH);
    expect(scriptBody).toContain(MARKER);

    // publishPdfPart must have been called with the same partPath that was in the script
    const publishCall = mockPublishPdfPart.mock.calls[0][0];
    expect(publishCall.finalPath).toBe(FINAL_PATH);
    // partPath must use the blocked prefix
    expect(publishCall.partPath).toContain(MARKER);
    expect(publishCall.partPath).toContain(FINAL_DIR);
  });

  // P7: existing PDF target → pdf_replace_blocked
  it("P7: existing PDF target → pdf_replace_blocked error", async () => {
    mockPreQueryOk();

    mockDecideWrite.mockResolvedValueOnce({
      ok: false,
      kind: "name_collision",
      message: "path already exists",
      existing_path: FINAL_PATH,
      suggested_path: "/Users/test/export/output-1.pdf",
      reason: "not_owned",
    } as never);

    const result = await exportPdfTool.handler({ path: FINAL_PATH });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("pdf_replace_blocked");
      expect(result.error.existing_path).toBe(FINAL_PATH);
    }

    expect(mockSendWriteScript).not.toHaveBeenCalled();
    expect(mockPublishPdfPart).not.toHaveBeenCalled();
  });

  // P-pre-query-fail: pre-query not_found propagated
  it("P-pre-query-fail: pre-query not_found → error propagated, no write attempted", async () => {
    mockPreQueryNotFound();

    const result = await exportPdfTool.handler({ path: FINAL_PATH });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("not_found");
    }
    expect(mockDecideWrite).not.toHaveBeenCalled();
    expect(mockSendWriteScript).not.toHaveBeenCalled();
  });

  // P-precheck-existing: partPath already exists (prior crashed export) → io_error
  it("P-precheck-existing: pre-existing partPath → io_error, no write sent", async () => {
    mockPreQueryOk();
    mockDecisionOk();

    // lstatSync succeeds (file exists) — simulates crashed export leftover
    mockLstatSize(1024);

    const result = await exportPdfTool.handler({ path: FINAL_PATH });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("io_error");
      expect(result.error.message).toMatch(/already exists/);
    }
    expect(mockSendWriteScript).not.toHaveBeenCalled();
  });

  // P-send-fail-zero: sendWriteScript fails, partPath size=0 → reported, NOT removed
  it("P-send-fail-zero: send fails, zero-byte part is reported and not removed", async () => {
    mockPreQueryOk();
    mockDecisionOk();

    // Pre-check: absent; after the failed send: a zero-byte file is there
    mockLstatPaths({ part: ["absent", 0] });

    mockSendWriteScript.mockResolvedValueOnce({
      ok: false,
      kind: "io_error",
      reason: "uncertain",
      message: "InDesign not available",
    } as never);

    const result = await exportPdfTool.handler({ path: FINAL_PATH });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("io_error");
      expect(result.error.message).toContain("InDesign not available");
      // The file is reported with what was observed, and the tool says it was not removed
      expect(result.error.message).toContain(MARKER);
      expect(result.error.message).toContain("0 bytes");
      expect(result.error.message).toContain("was not removed");
    }
    // Safety property: nothing was deleted by any route
    expectNoDeletion();
  });

  // P-send-fail-nonzero: sendWriteScript fails, partPath has content → io_error + partPath reported
  it("P-send-fail-nonzero: send fails, partPath has content → io_error + partPath in message", async () => {
    mockPreQueryOk();
    mockDecisionOk();

    // First lstatSync: ENOENT (pre-check ok); second: 8192 (InDesign wrote content)
    mockLstatSequence(["enoent", 8192]);

    mockSendWriteScript.mockResolvedValueOnce({
      ok: false,
      kind: "io_error",
      reason: "uncertain",
      message: "transport layer error",
    } as never);

    const result = await exportPdfTool.handler({ path: FINAL_PATH });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("io_error");
      // partPath with the blocked prefix must appear in the message for debugging
      expect(result.error.message).toContain(MARKER);
    }
  });

  // P-transport-fail: transport returns script_error inside Envelope — propagated, not swallowed
  it("P-transport-fail: transport script_error inside Envelope is propagated (no double-wrap)", async () => {
    mockPreQueryOk();
    mockDecisionOk();

    mockLstatEnoent();

    // sendFn returned a failure Envelope (script threw in InDesign)
    mockSendWriteScript.mockResolvedValueOnce({
      ok: true,
      result: { ok: false, error: { kind: "script_error", message: "InDesign script threw" } },
    } as never);

    const result = await exportPdfTool.handler({ path: FINAL_PATH });

    // Handler must surface the transport failure, not succeed with undefined page_count
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("script_error");
    }
    // publishPdfPart must NOT be called — export never completed
    expect(mockPublishPdfPart).not.toHaveBeenCalled();
  });

  // P-publish-fail-eexist: the guard reports EEXIST on link → pdf_replace_blocked; nothing is removed
  it("P-publish-fail-eexist: publishPdfPart EEXIST race → pdf_replace_blocked + partPath reported", async () => {
    mockPreQueryOk();
    mockDecisionOk();

    // part: absent, then non-empty before publishing, still there afterwards; final: now present
    mockLstatPaths({ part: ["absent", 32768, 32768], final: [100] });

    mockSendWriteScript.mockResolvedValueOnce(SEND_OK as never);

    // The message the REAL guard produces for EEXIST (write-guard.ts:800); PX12b pins it against the real code
    mockPublishPdfPart.mockResolvedValueOnce({
      ok: false,
      reason: "uncertain",
      message: GUARD_EEXIST_MESSAGE,
    } as never);

    const result = await exportPdfTool.handler({ path: FINAL_PATH });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("pdf_replace_blocked");
      expect(result.error.existing_path).toBe(FINAL_PATH);
      // The guard's message is kept verbatim, and the leftover temporary file is reported
      expect(result.error.message).toContain(GUARD_EEXIST_MESSAGE);
      expect(result.error.message).toContain(MARKER);
    }
    // Safety property: the publish was attempted once, towards the final path, and nothing was deleted
    expect(mockPublishPdfPart).toHaveBeenCalledTimes(1);
    expect(mockPublishPdfPart.mock.calls[0][0].finalPath).toBe(FINAL_PATH);
    expectNoDeletion();
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// Hardening (PX*): mocked guard
// ═════════════════════════════════════════════════════════════════════════════

describe("export_pdf — exceptions around sendWriteScript (PX1b, PX1c)", () => {
  it("PX1b: an exception that is not a guard refusal is rethrown unchanged (server.ts reports it)", async () => {
    mockPreQueryOk();
    mockDecisionOk();
    mockLstatEnoent();
    const boom = new TypeError("boom: unrelated");
    mockSendWriteScript.mockImplementationOnce((() => { throw boom; }) as never);

    let caught: unknown;
    try {
      await exportPdfTool.handler({ path: FINAL_PATH });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(boom); // the very same error, not wrapped and not re-classified
    expect(mockRunScript).toHaveBeenCalledTimes(1); // only the pre-query: nothing was sent
    expect(mockPublishPdfPart).not.toHaveBeenCalled();
  });

  it("PX1c: an exception after the send began → io_error with an unknown outcome, not write_not_authorized", async () => {
    mockPreQueryOk();
    mockDecisionOk();
    mockLstatPaths({ part: ["absent", "absent"] });
    mockRunScript.mockResolvedValueOnce({ ok: true, result: { path: "x", page_count: 1 } } as never);
    mockSendWriteScript.mockImplementationOnce((async (
      _d: unknown, _r: unknown, sendFn: (o: { scriptTemplate: string }) => Promise<unknown>,
    ) => {
      await sendFn({ scriptTemplate: "x" }); // the send begins
      throw new Error("after send");
    }) as never);

    const result = await exportPdfTool.handler({ path: FINAL_PATH });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("io_error");
      expect(result.error.message).toContain("after send");
      expect(result.error.message).toContain("had already begun");
      expect(result.error.message).toContain("unknown");
    }
    expect(mockPublishPdfPart).not.toHaveBeenCalled();
    expectNoDeletion();
  });

  it("PX1c-b: a guard-refusal message thrown after the send began is NOT re-classified (the flag decides first)", async () => {
    mockPreQueryOk();
    mockDecisionOk();
    mockLstatPaths({ part: ["absent", "absent"] });
    mockRunScript.mockResolvedValueOnce({ ok: true, result: { path: "x", page_count: 1 } } as never);
    mockSendWriteScript.mockImplementationOnce((async (
      _d: unknown, _r: unknown, sendFn: (o: { scriptTemplate: string }) => Promise<unknown>,
    ) => {
      await sendFn({ scriptTemplate: "x" });
      throw new Error("write_not_authorized: capability body mismatch");
    }) as never);

    const result = await exportPdfTool.handler({ path: FINAL_PATH });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("io_error");
  });
});

describe("export_pdf — the temporary file must be regular and non-empty (PX2, PX3)", () => {
  async function runWithPartState(spec: Spec) {
    mockPreQueryOk();
    mockDecisionOk();
    mockLstatPaths({ part: ["absent", spec] });
    mockSendWriteScript.mockResolvedValueOnce(SEND_OK as never);
    return exportPdfTool.handler({ path: FINAL_PATH });
  }

  it("PX2: an empty temporary file is not published; the message says 'empty file', not 'invalid PDF'", async () => {
    const result = await runWithPartState(0);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("io_error");
      expect(result.error.message).toContain("an empty file (0 bytes)");
      expect(result.error.message).toContain(MARKER);
      expect(result.error.message).toContain("Nothing was published");
      expect(result.error.message).not.toMatch(/invalid pdf|corrupt/i);
    }
    expect(mockPublishPdfPart).not.toHaveBeenCalled();
    expectNoDeletion();
  });

  it("PX3a: a temporary file that is absent when checked → not published", async () => {
    const result = await runWithPartState("absent");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("was not found when checked");
    expect(mockPublishPdfPart).not.toHaveBeenCalled();
  });

  it("PX3b: an inspection error (EACCES) is reported as unknown state, NOT as 'not found'", async () => {
    const result = await runWithPartState("eacces");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("could not be inspected");
      expect(result.error.message).toContain("EACCES");
      expect(result.error.message).toContain("its state is unknown");
      expect(result.error.message).not.toContain("not found");
    }
    expect(mockPublishPdfPart).not.toHaveBeenCalled();
  });

  it("PX3c: a temporary path that is not a regular file → not published, not removed", async () => {
    const result = await runWithPartState("other");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("is not a regular file");
    expect(mockPublishPdfPart).not.toHaveBeenCalled();
    expectNoDeletion();
  });
});

describe("export_pdf — publish failure classification (PX5, PX6)", () => {
  async function runPublishFailure(message: string, final: Spec[]) {
    mockPreQueryOk();
    mockDecisionOk();
    mockLstatPaths({ part: ["absent", 500, 500], final });
    mockSendWriteScript.mockResolvedValueOnce(SEND_OK as never);
    mockPublishPdfPart.mockResolvedValueOnce({ ok: false, reason: "uncertain", message } as never);
    return exportPdfTool.handler({ path: FINAL_PATH });
  }

  it("PX5a: a link failure that is not EEXIST, target absent → io_error with the guard's message; not 'blocked'", async () => {
    const result = await runPublishFailure("link failed: EPERM: operation not permitted", ["absent"]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("io_error");
      expect(result.error.message).toContain("link failed: EPERM: operation not permitted");
      expect(result.error.message).toContain(`No file is present at ${FINAL_PATH} now.`);
      expect(result.error.message).toContain(MARKER);
      expect(result.error.existing_path).toBeUndefined();
    }
    expectNoDeletion();
  });

  it("PX5b: the same failure with the target PRESENT is still io_error — the target's state is not the cause", async () => {
    const result = await runPublishFailure("link failed: EPERM: operation not permitted", [100]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("io_error");
      expect(result.error.message).toContain(`A file is present at ${FINAL_PATH} now.`);
    }
  });

  it("PX6b: the guard reports EEXIST but the target cannot be inspected → still pdf_replace_blocked, with the inspection error", async () => {
    const result = await runPublishFailure(GUARD_EEXIST_MESSAGE, ["eacces"]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("pdf_replace_blocked");
      expect(result.error.existing_path).toBe(FINAL_PATH);
      expect(result.error.message).toContain("could not be inspected");
    }
  });
});

describe("export_pdf — nothing is deleted by this tool (PX8)", () => {
  const swaps: Array<{ spec: Spec; shows: RegExp }> = [
    { spec: "other", shows: /not a regular file/ },
    { spec: "eacces", shows: /could not be inspected/ },
    { spec: 0, shows: /0 bytes/ },
    { spec: 5000, shows: /5000 bytes/ },
  ];

  // The temporary path is swapped between the checks: the LAST observed state is the one reported.
  for (const { spec, shows } of swaps) {
    it(`PX8a send-fail, state at report time: ${String(spec)}`, async () => {
      mockPreQueryOk();
      mockDecisionOk();
      mockLstatPaths({ part: ["absent", spec] });
      mockSendWriteScript.mockResolvedValueOnce(
        { ok: false, kind: "io_error", reason: "uncertain", message: "transport layer error" } as never,
      );

      const result = await exportPdfTool.handler({ path: FINAL_PATH });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toMatch(shows);
      expectNoDeletion();
    });

    it(`PX8a envelope-fail (timeout), state at report time: ${String(spec)}`, async () => {
      mockPreQueryOk();
      mockDecisionOk();
      mockLstatPaths({ part: ["absent", spec] });
      mockSendWriteScript.mockResolvedValueOnce(
        { ok: true, result: { ok: false, error: { kind: "timeout", message: "timed out" } } } as never,
      );

      const result = await exportPdfTool.handler({ path: FINAL_PATH });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("timeout");
        expect(result.error.message).toMatch(shows);
      }
      expectNoDeletion();
    });

    it(`PX8a publish-fail, regular (5000) when checked, then: ${String(spec)}`, async () => {
      mockPreQueryOk();
      mockDecisionOk();
      mockLstatPaths({ part: ["absent", 5000, spec] });
      mockSendWriteScript.mockResolvedValueOnce(SEND_OK as never);
      mockPublishPdfPart.mockResolvedValueOnce({ ok: false, reason: "uncertain", message: "link failed: EIO" } as never);

      const result = await exportPdfTool.handler({ path: FINAL_PATH });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toMatch(shows);
      expectNoDeletion();
    });

    if (spec !== 5000) {
      it(`PX8a refusal before publishing, state when checked: ${String(spec)}`, async () => {
        mockPreQueryOk();
        mockDecisionOk();
        mockLstatPaths({ part: ["absent", spec] });
        mockSendWriteScript.mockResolvedValueOnce(SEND_OK as never);

        const result = await exportPdfTool.handler({ path: FINAL_PATH });

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toMatch(shows);
        expect(mockPublishPdfPart).not.toHaveBeenCalled();
        expectNoDeletion();
      });
    }
  }

  it("PX8b: static scan — export-pdf.ts contains no deletion call and no fs/promises import", () => {
    // Scope: THIS FILE ONLY. publishPdfPart (write-guard.ts) removes the temporary name after a successful
    // link; that is outside this file and is documented by PX13.
    const source = realFs.readFileSync(
      fileURLToPath(new URL("../../../src/tools/export-pdf.ts", import.meta.url)),
      "utf8",
    );
    const forbidden =
      /\b(unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|rename|renameSync|truncate|truncateSync|writeFile|writeFileSync|copyFile)\b/;

    expect(source).not.toMatch(forbidden);
    expect(source).not.toContain("node:fs/promises");
    expect(source).not.toContain("promises");
    // The only thing imported from node:fs is lstatSync (a read-only look at a path)
    const fsImports = source.match(/import [^;]* from "node:fs";/g) ?? [];
    expect(fsImports).toEqual(['import { lstatSync } from "node:fs";']);
  });
});

describe("export_pdf — InDesign envelope failures keep kind and fields (PX9, PX10)", () => {
  it("PX9: a script_error with a temporary file left → kind and fields kept, the file is reported", async () => {
    mockPreQueryOk();
    mockDecisionOk();
    mockLstatPaths({ part: ["absent", 0] });
    mockSendWriteScript.mockResolvedValueOnce({
      ok: true,
      result: { ok: false, error: { kind: "script_error", message: "m", entity: "document", id: "77" } },
    } as never);

    const result = await exportPdfTool.handler({ path: FINAL_PATH });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("script_error");
      expect(result.error.entity).toBe("document");
      expect(result.error.id).toBe("77");
      expect(result.error.message.startsWith("m. A file is present at the temporary path (0 bytes)")).toBe(true);
    }
    expectNoDeletion(); // the former behaviour (silent removal of a zero-byte file) is gone
  });

  it("PX10: a failure envelope with nothing at the temporary path is returned identical", async () => {
    mockPreQueryOk();
    mockDecisionOk();
    mockLstatPaths({ part: ["absent", "absent"] });
    const envelope = { ok: false, error: { kind: "script_error", message: "InDesign script threw" } };
    mockSendWriteScript.mockResolvedValueOnce({ ok: true, result: envelope } as never);

    const result = await exportPdfTool.handler({ path: FINAL_PATH });

    expect(result).toEqual(envelope);
  });
});

describe("export_pdf — warnings after a successful publish (PX11)", () => {
  async function runSuccess(afterPublish: Spec) {
    mockPreQueryOk();
    mockDecisionOk();
    mockLstatPaths({ part: ["absent", 4096, afterPublish] });
    mockSendWriteScript.mockResolvedValueOnce(SEND_OK as never);
    mockPublishPdfPart.mockResolvedValueOnce({ ok: true } as never);
    return exportPdfTool.handler({ path: FINAL_PATH });
  }

  it("PX11a: something is still at the temporary path → success with a warning that states only what is observed", async () => {
    const result = await runSuccess(4096);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result?.path).toBe(FINAL_PATH);
      expect(result.result?.page_count).toBe(2);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings![0]).toContain("4096 bytes");
      expect(result.warnings![0]).toContain(MARKER);
      // No claim about a clean-up that this code did not attempt
      expect(result.warnings![0]).not.toMatch(/fail|removed/i);
    }
  });

  it("PX11b: the temporary path cannot be inspected → success with a warning that says so", async () => {
    const result = await runSuccess("eacces");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings![0]).toContain("could not be inspected");
      expect(result.warnings![0]).toContain("EACCES");
    }
  });

  it("PX11c: nothing at the temporary path → success without a warnings field", async () => {
    const result = await runSuccess("absent");

    expect(result.ok).toBe(true);
    expect("warnings" in result).toBe(false);
  });
});

describe("export_pdf — an existing PDF is refused before anything is sent (PX12a)", () => {
  it("PX12a: decideWrite refuses a regular file at the target → no send, no publish, no deletion, no look at the temporary path", async () => {
    mockPreQueryOk();
    mockDecideWrite.mockResolvedValueOnce({
      ok: false,
      kind: "name_collision",
      reason: "not_owned",
      message: "PDF file already exists and cannot be replaced",
      existing_path: FINAL_PATH,
      suggested_path: "/Users/test/export/output-1.pdf",
    } as never);
    const looked: string[] = [];
    _lstatImpl = (p: string) => { looked.push(p); return statOf("absent"); };

    const result = await exportPdfTool.handler({ path: FINAL_PATH });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("pdf_replace_blocked");
    expect(mockSendWriteScript).not.toHaveBeenCalled();
    expect(mockPublishPdfPart).not.toHaveBeenCalled();
    expect(looked).toEqual([]);
    expectNoDeletion();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// REAL write-guard on real files in an mkdtemp directory (PX1a, PX1a2, PX12b, PX12c, PX13)
// Only the InDesign transport is mocked (it also plays InDesign: it creates the temporary file).
// ═════════════════════════════════════════════════════════════════════════════

describe("export_pdf — with the REAL write-guard on real files", () => {
  const PDF_BYTES = "%PDF-1.4 test bytes (not a real document)";
  let dir: string;

  /** Removes ONLY the directory this test created: refuses anything else. Uses the REAL rmSync. */
  function removeOwnTempDir(d: string) {
    const root = realFs.realpathSync(tmpdir());
    if (!d.startsWith(root + "/") || !basename(d).startsWith("b8-export-")) {
      throw new Error(`refusing to clean a directory this test did not create: ${d}`);
    }
    realFs.rmSync(d, { recursive: true, force: true });
  }

  /**
   * The temporary path as the tool wrote it into the script. The directory is a known value (`d`), so it
   * is located by its ENCODED form, escaped for a regular expression: any directory name works (spaces,
   * brackets, `$`, quotes, backslashes). The path is written with lit() (JSON.stringify) and the whole
   * script is JSON.stringify'd again by wrapExtendScript, hence two encodings. Only the file-name suffix is
   * matched; the returned path is built from the real directory.
   */
  function findPartPath(scriptTemplate: string, d: string): string {
    const encode = (s: string) => JSON.stringify(s).slice(1, -1);
    const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Anchored on both sides: the path is a whole string literal, delimited by an escaped quote
    // (backslash + quote). A directory that is only the TAIL of a longer path does not match.
    const re = new RegExp('\\\\"' + escapeRegExp(encode(encode(d))) + "(/\\.indesign-mcp-[0-9a-f]{32}\\.pdf\\.part)" + '\\\\"');
    const m = re.exec(scriptTemplate);
    if (m === null) throw new Error("test harness: the temporary path was not found in the script");
    return d + m[1];
  }

  beforeEach(() => {
    realWg.registryReset();
    _lstatImpl = (p: string) => realFs.lstatSync(p);
    dir = realFs.realpathSync(realFs.mkdtempSync(join(tmpdir(), "b8-export-")));
  });

  afterEach(() => {
    removeOwnTempDir(dir);
  });

  /**
   * Real decideWrite / sendWriteScript / publishPdfPart. The mocked transport plays InDesign: it finds the
   * temporary path in the script, writes the file there, and optionally runs `afterExport`.
   */
  function arrange(finalName: string, afterExport?: (partPath: string, finalPath: string) => void) {
    const finalPath = join(dir, finalName);
    const seen: { partPath?: string } = {};
    mockPreQueryOk();
    mockDecideWrite.mockImplementationOnce(((...a: Parameters<typeof realWg.decideWrite>) => realWg.decideWrite(...a)) as never);
    mockSendWriteScript.mockImplementationOnce(((...a: Parameters<typeof realWg.sendWriteScript>) => realWg.sendWriteScript(...a)) as never);
    mockPublishPdfPart.mockImplementationOnce(((...a: Parameters<typeof realWg.publishPdfPart>) => realWg.publishPdfPart(...a)) as never);
    mockRunScript.mockImplementationOnce(((o: { scriptTemplate: string }) => {
      const partPath = findPartPath(o.scriptTemplate, dir);
      seen.partPath = partPath;
      realFs.writeFileSync(partPath, PDF_BYTES);
      afterExport?.(partPath, finalPath);
      return Promise.resolve({ ok: true, result: { path: partPath, page_count: 2 } });
    }) as never);
    return { finalPath, seen };
  }

  it("PX1a: the REAL capability check refuses a body that changed → write_not_authorized, nothing sent", async () => {
    const finalPath = join(dir, "out.pdf");
    mockPreQueryOk();
    mockDecideWrite.mockImplementationOnce(((...a: Parameters<typeof realWg.decideWrite>) => realWg.decideWrite(...a)) as never);
    mockSendWriteScript.mockImplementationOnce(((...[d, req, send, wrap]: Parameters<typeof realWg.sendWriteScript>) =>
      // the wrapper is handed a different body than the one the capability was issued for
      realWg.sendWriteScript(d, req, send, (body, cap, op) => wrap(body + " ", cap, op))) as never);

    const result = await exportPdfTool.handler({ path: finalPath });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("write_not_authorized");
      expect(result.error.message).toBe("write_not_authorized: capability body mismatch"); // the guard's own text
    }
    expect(mockRunScript).toHaveBeenCalledTimes(1); // the pre-query only: the export was never sent
    expect(mockPublishPdfPart).not.toHaveBeenCalled();
    expect(realFs.readdirSync(dir)).toEqual([]); // nothing was created in the directory
  });

  it("PX1a2: the REAL operation check refuses a body without exportFile( → write_not_authorized, nothing sent", async () => {
    const finalPath = join(dir, "out.pdf");
    mockPreQueryOk();
    mockDecideWrite.mockImplementationOnce(((...a: Parameters<typeof realWg.decideWrite>) => realWg.decideWrite(...a)) as never);
    mockSendWriteScript.mockImplementationOnce(((...[d, req, send, wrap]: Parameters<typeof realWg.sendWriteScript>) =>
      realWg.sendWriteScript(d, { ...req, scriptOpts: { bodyFn: () => "return 1;" } }, send, wrap)) as never);

    const result = await exportPdfTool.handler({ path: finalPath });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("write_not_authorized");
      expect(result.error.message.startsWith("operation_body_mismatch:")).toBe(true); // the guard's own text
    }
    expect(mockRunScript).toHaveBeenCalledTimes(1);
    expect(mockPublishPdfPart).not.toHaveBeenCalled();
  });

  it("PX12b: a competitor creates the target during the export → pdf_replace_blocked from the REAL guard message; target intact, temporary file kept, nothing deleted", async () => {
    const { finalPath, seen } = arrange("race.pdf", (_part, fin) => realFs.writeFileSync(fin, "COMPETITOR"));

    const result = await exportPdfTool.handler({ path: finalPath });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("pdf_replace_blocked");
      expect(result.error.existing_path).toBe(finalPath);
      expect(result.error.message.startsWith("final PDF path was taken during export:")).toBe(true); // pins the real wording
      expect(result.error.message).toContain(seen.partPath!);
    }
    expect(realFs.readFileSync(finalPath, "utf8")).toBe("COMPETITOR"); // the existing file was never overwritten
    expect(realFs.readFileSync(seen.partPath!, "utf8")).toBe(PDF_BYTES); // the temporary file was kept
    // On this failure path publishPdfPart returns before its removal step; this does NOT say anything
    // about the success path (PX13).
    expectNoDeletion();
  });

  it("PX12c: a link failure that is not EEXIST (injected EPERM) → io_error with the REAL guard message; temporary file kept, nothing deleted", async () => {
    del.linkFault = Object.assign(new Error("EPERM: operation not permitted, link"), { code: "EPERM" });
    const { finalPath, seen } = arrange("perm.pdf");

    const result = await exportPdfTool.handler({ path: finalPath });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("io_error");
      expect(result.error.message).toContain("link failed: EPERM"); // the real guard's wording for non-EEXIST
      expect(result.error.message).toContain(`No file is present at ${finalPath} now.`);
      expect(result.error.message).toContain(seen.partPath!);
      expect(result.error.existing_path).toBeUndefined();
    }
    expect(realFs.existsSync(finalPath)).toBe(false);
    expect(realFs.readFileSync(seen.partPath!, "utf8")).toBe(PDF_BYTES);
    expectNoDeletion();
  });

  it("PX13: a successful publish with the REAL guard → the target has the exported content and the temporary NAME is gone (removed by publishPdfPart, not by this tool)", async () => {
    const { finalPath, seen } = arrange("ok.pdf");

    const result = await exportPdfTool.handler({ path: finalPath });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result?.path).toBe(finalPath);
      expect(result.result?.page_count).toBe(2);
      expect("warnings" in result).toBe(false);
    }
    expect(realFs.readFileSync(finalPath, "utf8")).toBe(PDF_BYTES);
    expect(realFs.existsSync(seen.partPath!)).toBe(false);
    // The accepted behaviour, stated as a test: publishPdfPart removes the temporary name with fs.unlink after
    // a successful link, by path, without inode verification. It is unchanged and outside this tool's code.
    expect(del.unlink).toHaveBeenCalledTimes(1);
    expect(del.unlink.mock.calls[0][0]).toBe(seen.partPath);
    expect(realWg.registryGet(finalPath)?.state).toBe("owned");
  });
});
