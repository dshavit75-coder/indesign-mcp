/**
 * Stage 4 unit tests for save-document.ts (write-guard integration).
 *
 * Tests cover:
 *   I1  — new file save-as (path A): placeholder + sendWriteScript → ok
 *   I3  — in-place save (path B): no placeholder, sendWriteScript → ok
 *   I4  — path C (not owned existing file): decideWrite returns name_collision
 *   I5  — fingerprint mismatch: assertWriteAllowed detects TOCTOU via reservedFingerprint
 *         (simulated by sendWriteScript returning write_not_authorized)
 *   I7  — reservePlaceholder EEXIST: placeholder already exists → io_error
 *   I8  — sendWriteScript failure (path A): partPath is zero-byte → cleanup, io_error returned
 *   I9b — no document_id provided: pre-query uses app.activeDocument
 *   I10 — unsaved document (Untitled): fullName empty → io_error before decideWrite
 *   I11 — document not found by id: pre-query returns not_found
 *
 * Strategy: vi.mock the three boundary modules so no InDesign or fs side-effects occur.
 *   - ../../../src/write-guard.js   → mocked; all exports stubbed
 *   - ../../../src/transport/result-file.js → mocked; runScriptWithResultFile stubbed
 *   - ../../../src/path-utils.js    → thin pass-through (returns input unchanged)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks must be hoisted before any import of the module under test ──────────

vi.mock("../../../src/write-guard.js", () => ({
  decideWrite: vi.fn(),
  reservePlaceholder: vi.fn(),
  cleanupPlaceholder: vi.fn(),
  sendWriteScript: vi.fn(),
  registrySet: vi.fn(),
}));

vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

vi.mock("../../../src/path-utils.js", () => ({
  resolveUserPath: (p: string) => (p.startsWith("/") ? p : "/resolved/" + p),
}));

// ── Now import the module under test ─────────────────────────────────────────

import { saveDocumentTool } from "../../../src/tools/save-document.js";
import * as wg from "../../../src/write-guard.js";
import * as rf from "../../../src/transport/result-file.js";

const mockDecideWrite = vi.mocked(wg.decideWrite);
const mockReservePlaceholder = vi.mocked(wg.reservePlaceholder);
const mockCleanupPlaceholder = vi.mocked(wg.cleanupPlaceholder);
const mockSendWriteScript = vi.mocked(wg.sendWriteScript);
const mockRunScript = vi.mocked(rf.runScriptWithResultFile);

// ── Shared fixtures ───────────────────────────────────────────────────────────

const DOC_ID = "42";
const FINAL_PATH = "/Users/test/docs/output.indd";

/** A minimal frozen WriteAllowed+WriteDecision for path A (new file). */
function makeDecisionA() {
  return Object.freeze({
    savePath: "A" as const,
    finalPath: FINAL_PATH,
    registryKey: FINAL_PATH,
  });
}

/** A minimal frozen WriteAllowed+WriteDecision for path B (owned file). */
function makeDecisionB() {
  return Object.freeze({
    savePath: "B" as const,
    finalPath: FINAL_PATH,
    registryKey: FINAL_PATH,
  });
}

const FINGERPRINT = { dev: 1, ino: 99, size: 0, mtimeMs: 0, ctimeMs: 0 };

// ── Helpers to set up standard pre-query mock ─────────────────────────────────

function mockPreQueryOk(documentId = DOC_ID, fullName = FINAL_PATH) {
  mockRunScript.mockResolvedValueOnce({
    ok: true,
    result: { documentId, fullName },
  } as never);
}

function mockPreQueryNotFound() {
  mockRunScript.mockResolvedValueOnce({
    ok: false,
    error: { kind: "not_found", message: "document not found: 999" },
  } as never);
}

// ── Reset mocks before each test ──────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("save_document — write-guard integration (Stage 4)", () => {

  // I1: path A — new file save-as
  it("I1: save-as to a new path (path A) succeeds", async () => {
    mockPreQueryOk();
    mockDecideWrite.mockResolvedValueOnce({
      ok: true,
      decision: makeDecisionA(),
    } as never);
    mockReservePlaceholder.mockReturnValueOnce({
      ok: true,
      fingerprint: FINGERPRINT,
    } as never);
    // Mock returns the Envelope<ScriptResult> that sendFn (runScriptWithResultFile) produces
    mockSendWriteScript.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, result: { path: FINAL_PATH } },
    } as never);

    const result = await saveDocumentTool.handler({ document_id: DOC_ID, path: FINAL_PATH });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // result is Envelope<ScriptResult> returned directly — path at result.result.path
      expect(result.result?.path).toBe(FINAL_PATH);
    }
    expect(mockReservePlaceholder).toHaveBeenCalledWith(FINAL_PATH);
    expect(mockSendWriteScript).toHaveBeenCalledWith(
      expect.objectContaining({ savePath: "A" }),
      expect.objectContaining({
        reservedFingerprint: FINGERPRINT,
        finalPath: FINAL_PATH,
      }),
      expect.any(Function),
      expect.any(Function), // Stage 6: wrapFn injected as 4th arg
    );
    // cleanupPlaceholder must NOT be called on success
    expect(mockCleanupPlaceholder).not.toHaveBeenCalled();
  });

  // I3: path B — in-place save
  it("I3: in-place save (path B) succeeds without placeholder", async () => {
    mockPreQueryOk(DOC_ID, FINAL_PATH);
    mockDecideWrite.mockResolvedValueOnce({
      ok: true,
      decision: makeDecisionB(),
    } as never);
    mockSendWriteScript.mockResolvedValueOnce({
      ok: true,
      result: { ok: true, result: { path: FINAL_PATH } },
    } as never);

    // No path provided → in-place save
    const result = await saveDocumentTool.handler({ document_id: DOC_ID });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result?.path).toBe(FINAL_PATH);
    }
    expect(mockReservePlaceholder).not.toHaveBeenCalled();
    expect(mockSendWriteScript).toHaveBeenCalledWith(
      expect.objectContaining({ savePath: "B" }),
      expect.not.objectContaining({ reservedFingerprint: expect.anything() }),
      expect.any(Function),
      expect.any(Function), // Stage 6: wrapFn injected as 4th arg
    );
  });

  // I4: path C — foreign / not-owned file → name_collision
  it("I4: decideWrite refuses not-owned path → name_collision returned", async () => {
    mockPreQueryOk();
    mockDecideWrite.mockResolvedValueOnce({
      ok: false,
      kind: "name_collision",
      message: "path not owned by this session",
      existing_path: FINAL_PATH,
      reason: "not_owned",
    } as never);

    const result = await saveDocumentTool.handler({ document_id: DOC_ID, path: FINAL_PATH });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("name_collision");
      expect(result.error.reason).toBe("not_owned");
    }
    expect(mockReservePlaceholder).not.toHaveBeenCalled();
    expect(mockSendWriteScript).not.toHaveBeenCalled();
  });

  // I5: reservedFingerprint TOCTOU detection (simulated via sendWriteScript failure)
  it("I5: TOCTOU fingerprint mismatch → write_not_authorized, placeholder cleaned up", async () => {
    mockPreQueryOk();
    mockDecideWrite.mockResolvedValueOnce({
      ok: true,
      decision: makeDecisionA(),
    } as never);
    mockReservePlaceholder.mockReturnValueOnce({
      ok: true,
      fingerprint: FINGERPRINT,
    } as never);
    mockSendWriteScript.mockResolvedValueOnce({
      ok: false,
      kind: "write_not_authorized",
      reason: "fingerprint_mismatch",
      message: "path-A placeholder inode changed before send (TOCTOU detected)",
    } as never);

    const result = await saveDocumentTool.handler({ document_id: DOC_ID, path: FINAL_PATH });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("io_error");
    }
    // Placeholder cleanup must have been attempted
    expect(mockCleanupPlaceholder).toHaveBeenCalledWith(FINAL_PATH, FINGERPRINT.ino);
  });

  // I7: reservePlaceholder EEXIST (someone else created the file between gate and reserve)
  it("I7: reservePlaceholder fails (EEXIST) → io_error, no write script sent", async () => {
    mockPreQueryOk();
    mockDecideWrite.mockResolvedValueOnce({
      ok: true,
      decision: makeDecisionA(),
    } as never);
    mockReservePlaceholder.mockReturnValueOnce({
      ok: false,
      message: "cannot create placeholder: file already exists",
      reason: "uncertain",
    } as never);

    const result = await saveDocumentTool.handler({ document_id: DOC_ID, path: FINAL_PATH });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("io_error");
    }
    expect(mockSendWriteScript).not.toHaveBeenCalled();
  });

  // I8: sendWriteScript failure on path A → cleanup attempted
  it("I8: sendWriteScript fails (path A) → io_error returned, cleanupPlaceholder called", async () => {
    mockPreQueryOk();
    mockDecideWrite.mockResolvedValueOnce({
      ok: true,
      decision: makeDecisionA(),
    } as never);
    mockReservePlaceholder.mockReturnValueOnce({
      ok: true,
      fingerprint: FINGERPRINT,
    } as never);
    mockSendWriteScript.mockResolvedValueOnce({
      ok: false,
      kind: "io_error",
      reason: "uncertain",
      message: "InDesign timed out",
    } as never);

    const result = await saveDocumentTool.handler({ document_id: DOC_ID, path: FINAL_PATH });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("io_error");
    }
    expect(mockCleanupPlaceholder).toHaveBeenCalledWith(FINAL_PATH, FINGERPRINT.ino);
  });

  // I9b: no document_id — pre-query uses app.activeDocument
  it("I9b — schema rejects missing document_id before dispatch", async () => {
    const result = saveDocumentTool.inputSchema.safeParse({});
    expect(result.success).toBe(false);
    expect(mockDecideWrite).not.toHaveBeenCalled();
  });

  // I10: unsaved document — fullName is empty → io_error before decideWrite
  it("I10: unsaved document (fullName empty) → io_error, decideWrite never called", async () => {
    mockPreQueryOk(DOC_ID, ""); // fullName = ""

    const result = await saveDocumentTool.handler({ document_id: DOC_ID });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("io_error");
      expect(result.error.message).toMatch(/no saved path/);
    }
    expect(mockDecideWrite).not.toHaveBeenCalled();
  });

  // I11: document not found by id
  it("I11: pre-query not_found → error propagated, no write attempted", async () => {
    mockPreQueryNotFound();

    const result = await saveDocumentTool.handler({ document_id: "999" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("not_found");
    }
    expect(mockDecideWrite).not.toHaveBeenCalled();
    expect(mockSendWriteScript).not.toHaveBeenCalled();
  });

  // I-transport-fail: transport returns script_error inside Envelope — propagated, not swallowed
  it("I-transport-fail: transport script_error inside Envelope is propagated (no double-wrap)", async () => {
    mockPreQueryOk(DOC_ID, FINAL_PATH);
    mockDecideWrite.mockResolvedValueOnce({
      ok: true,
      decision: makeDecisionB(),
    } as never);
    // sendFn (runScriptWithResultFile) returned a failure Envelope
    mockSendWriteScript.mockResolvedValueOnce({
      ok: true,
      result: { ok: false, error: { kind: "script_error", message: "InDesign script threw" } },
    } as never);

    const result = await saveDocumentTool.handler({ document_id: DOC_ID });

    // The handler must surface the transport failure, not treat it as success
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("script_error");
    }
  });

});
