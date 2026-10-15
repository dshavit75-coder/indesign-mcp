/**
 * Stage 4 unit tests for export-pdf.ts (write-guard integration).
 *
 * Tests cover:
 *   P1 — successful export: partPath unique, sendWriteScript writes to partPath,
 *         publishPdfPart links to finalPath → { path, page_count }
 *   P7 — existing PDF target: decideWrite returns name_collision with existing_path
 *         → error converted to pdf_replace_blocked
 *
 * Additional edge-case tests:
 *   P-pre-query-fail — pre-query not_found propagated, no write attempted
 *   P-send-fail-zero  — sendWriteScript fails, partPath size=0 → io_error (no orphan)
 *   P-send-fail-nonzero — sendWriteScript fails, partPath has content → io_error
 *                         with partPath path reported (cleanup skipped)
 *   P-publish-fail-eexist — publishPdfPart fails (EEXIST race) after export wrote
 *                           content → pdf_replace_blocked reported with partPath
 *
 * Strategy: vi.mock the three boundary modules so no InDesign or real fs side-effects occur.
 * lstatSync is mocked via vi.spyOn on node:fs where needed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── lstatSync state shared between the mock factory and tests ─────────────────
// We need to control lstatSync behaviour per-test.  vi.spyOn fails here because
// node:fs lstatSync is non-configurable in Node 22.  Instead we mock the whole
// module and expose a mutable callback that each test can override.

let _lstatImpl: (path: string) => { isFile: () => boolean; size: number } = () => {
  const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  throw err;  // default: file absent
};

// ── Mocks must be hoisted before any import of the module under test ──────────

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    lstatSync: (path: string) => _lstatImpl(path),
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

const mockDecideWrite = vi.mocked(wg.decideWrite);
const mockSendWriteScript = vi.mocked(wg.sendWriteScript);
const mockPublishPdfPart = vi.mocked(wg.publishPdfPart);
const mockRunScript = vi.mocked(rf.runScriptWithResultFile);

// ── Shared fixtures ───────────────────────────────────────────────────────────

const DOC_ID = "77";
const FINAL_PATH = "/Users/test/export/output.pdf";
const FINAL_DIR = "/Users/test/export";

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

// ── Reset mocks before each test ──────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
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

    mockDecideWrite.mockResolvedValueOnce({
      ok: true,
      decision: makeDecision(),
    } as never);

    // partPath pre-check: ENOENT (file absent = ok to proceed)
    mockLstatEnoent();

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
    }

    // sendWriteScript must have been called with a bodyFn writing to partPath,
    // NOT to finalPath (bodyFn is called lazily — invoke it to check the body)
    const sendCall = mockSendWriteScript.mock.calls[0];
    expect(sendCall).toBeDefined();
    const bodyFn = sendCall[1].scriptOpts.bodyFn as () => string;
    expect(typeof bodyFn).toBe("function");
    const scriptBody = bodyFn();
    expect(scriptBody).not.toContain(FINAL_PATH);
    expect(scriptBody).toContain(".indesign-mcp-");

    // publishPdfPart must have been called with the same partPath that was in the script
    const publishCall = mockPublishPdfPart.mock.calls[0][0];
    expect(publishCall.finalPath).toBe(FINAL_PATH);
    // partPath must use the blocked prefix
    expect(publishCall.partPath).toContain(".indesign-mcp-");
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
    mockDecideWrite.mockResolvedValueOnce({
      ok: true,
      decision: makeDecision(),
    } as never);

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

  // P-send-fail-zero: sendWriteScript fails, partPath size=0 → io_error (cleanup ok)
  it("P-send-fail-zero: send fails, partPath zero-byte → io_error (cleanup)", async () => {
    mockPreQueryOk();
    mockDecideWrite.mockResolvedValueOnce({
      ok: true,
      decision: makeDecision(),
    } as never);

    // First lstatSync: ENOENT (pre-check ok); second: size=0 (cleanup path)
    mockLstatSequence(["enoent", 0]);

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
      // Should NOT mention a leftover partPath
      expect(result.error.message).not.toContain(".indesign-mcp-");
    }
  });

  // P-send-fail-nonzero: sendWriteScript fails, partPath has content → io_error + partPath reported
  it("P-send-fail-nonzero: send fails, partPath has content → io_error + partPath in message", async () => {
    mockPreQueryOk();
    mockDecideWrite.mockResolvedValueOnce({
      ok: true,
      decision: makeDecision(),
    } as never);

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
      expect(result.error.message).toContain(".indesign-mcp-");
    }
  });

  // P-transport-fail: transport returns script_error inside Envelope — propagated, not swallowed
  it("P-transport-fail: transport script_error inside Envelope is propagated (no double-wrap)", async () => {
    mockPreQueryOk();
    mockDecideWrite.mockResolvedValueOnce({
      ok: true,
      decision: makeDecision(),
    } as never);

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

  // P-publish-fail-eexist: publishPdfPart fails (EEXIST race) → pdf_replace_blocked
  it("P-publish-fail-eexist: publishPdfPart EEXIST race → pdf_replace_blocked + partPath reported", async () => {
    mockPreQueryOk();
    mockDecideWrite.mockResolvedValueOnce({
      ok: true,
      decision: makeDecision(),
    } as never);

    // First lstatSync: ENOENT (pre-check ok); second: 32768 (InDesign wrote content)
    mockLstatSequence(["enoent", 32768]);

    mockSendWriteScript.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, result: { path: FINAL_PATH, page_count: 2 } },
    } as never);

    mockPublishPdfPart.mockResolvedValueOnce({
      ok: false,
      message: "EEXIST: file already exists",
    } as never);

    const result = await exportPdfTool.handler({ path: FINAL_PATH });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("pdf_replace_blocked");
      // Message must mention the partPath leftover
      expect(result.error.message).toContain(".indesign-mcp-");
    }
  });

});
