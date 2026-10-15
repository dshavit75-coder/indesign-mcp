/**
 * Unit tests for Stage 6 write-guard additions:
 *   - write-capability.ts: issueWriteCapability / consumeWriteCapability
 *   - compose.ts: wrapExtendScript write track
 *   - tests/integration/helpers.ts: closeAllDocuments blocked
 */

import { describe, it, expect } from "vitest";
import { issueWriteCapability, consumeWriteCapability } from "../../src/write-capability.js";
import { wrapExtendScript } from "../../src/compose.js";
import { closeAllDocuments } from "../integration/helpers.js";

// ---------------------------------------------------------------------------
// 1. Forged capability is rejected
// ---------------------------------------------------------------------------
describe("consumeWriteCapability", () => {
  it("rejects an object not issued by issueWriteCapability", () => {
    const forgery = Object.freeze({ body: "doc.save()", operation: "in-place-save" });
    expect(() =>
      consumeWriteCapability(forgery, "doc.save()", "in-place-save"),
    ).toThrow("write_not_authorized: capability not issued by this guard");
  });

  // -------------------------------------------------------------------------
  // 2. Single-use: first consume succeeds; second throws
  // -------------------------------------------------------------------------
  it("allows exactly one consumption; second attempt throws", () => {
    const body = "doc.saveAs(File('/tmp/test.indd'));";
    const cap = issueWriteCapability(body, "save-as");

    // First consumption: succeeds
    expect(() => consumeWriteCapability(cap, body, "save-as")).not.toThrow();

    // Second consumption: capability removed from WeakSet
    expect(() => consumeWriteCapability(cap, body, "save-as")).toThrow(
      "write_not_authorized: capability not issued by this guard",
    );
  });

  // -------------------------------------------------------------------------
  // 3. Body mismatch: different body string rejected
  // -------------------------------------------------------------------------
  it("rejects when body does not match the issued body", () => {
    const issuedBody = "doc.saveAs(File('/tmp/test.indd'));";
    const differentBody = "doc.saveAs(File('/tmp/other.indd'));";
    const cap = issueWriteCapability(issuedBody, "save-as");

    expect(() =>
      consumeWriteCapability(cap, differentBody, "save-as"),
    ).toThrow("write_not_authorized: capability body mismatch");
  });

  // -------------------------------------------------------------------------
  // 4. Operation mismatch: different operation rejected
  // -------------------------------------------------------------------------
  it("rejects when operation does not match the issued operation", () => {
    const body = "doc.exportFile(ExportFormat.PDF_TYPE, File('/tmp/out.pdf'));";
    const cap = issueWriteCapability(body, "export-pdf");

    // Try to consume with wrong operation
    expect(() =>
      consumeWriteCapability(cap, body, "save-as"),
    ).toThrow("write_not_authorized: capability operation mismatch");
  });

  // -------------------------------------------------------------------------
  // 5. Two concurrent capabilities are isolated
  // Each can be consumed exactly once with its own matching arguments.
  // -------------------------------------------------------------------------
  it("two concurrent capabilities are isolated; each consumed exactly once", () => {
    const body1 = "doc.saveAs(File('/tmp/a.indd'));";
    const body2 = "doc.exportFile(ExportFormat.PDF_TYPE, File('/tmp/b.pdf'));";

    const cap1 = issueWriteCapability(body1, "save-as");
    const cap2 = issueWriteCapability(body2, "export-pdf");

    // Cross-consume: cap1 with body2 should fail (body mismatch)
    expect(() => consumeWriteCapability(cap1, body2, "save-as")).toThrow(
      "write_not_authorized: capability body mismatch",
    );

    // cap1 still valid after failed cross-consume (only successful consume removes from set)
    expect(() => consumeWriteCapability(cap1, body1, "save-as")).not.toThrow();

    // cap2 valid and consumed successfully
    expect(() => consumeWriteCapability(cap2, body2, "export-pdf")).not.toThrow();

    // Both now consumed
    expect(() => consumeWriteCapability(cap1, body1, "save-as")).toThrow(
      "write_not_authorized: capability not issued by this guard",
    );
    expect(() => consumeWriteCapability(cap2, body2, "export-pdf")).toThrow(
      "write_not_authorized: capability not issued by this guard",
    );
  });
});

// ---------------------------------------------------------------------------
// 6. wrapExtendScript write track: consumes the capability during wrapping
// ---------------------------------------------------------------------------
describe("wrapExtendScript write track", () => {
  it("consumes the capability and produces a script containing the body", () => {
    const body = "doc.saveAs(File('/tmp/out.indd'));";
    const cap = issueWriteCapability(body, "save-as");

    // wrapExtendScript should consume the capability without throwing
    let wrapped: string;
    expect(() => {
      wrapped = wrapExtendScript(body, { _writeCapability: cap, operation: "save-as" });
    }).not.toThrow();

    // Verify the body appears in the wrapped output
    expect(wrapped!).toContain(body);
    expect(wrapped!).toContain("Adobe InDesign 2026");

    // The capability is now consumed — calling wrapExtendScript again with the
    // same cap should fail (even though this would normally be prevented by
    // sendWriteScript's flow; this tests the raw mechanism).
    expect(() =>
      wrapExtendScript(body, { _writeCapability: cap, operation: "save-as" }),
    ).toThrow("write_not_authorized: capability not issued by this guard");
  });

  it("rejects a forged capability object passed via opts", () => {
    const body = "doc.save();";
    const forged = Object.freeze({ body, operation: "in-place-save" });

    expect(() =>
      wrapExtendScript(body, { _writeCapability: forged, operation: "in-place-save" }),
    ).toThrow("write_not_authorized: capability not issued by this guard");
  });
});

// ---------------------------------------------------------------------------
// 7. closeAllDocuments is blocked (Stage 6 hard block)
// ---------------------------------------------------------------------------
describe("closeAllDocuments", () => {
  it("throws with Stage 7 message — not accidentally callable from test helpers", async () => {
    await expect(closeAllDocuments()).rejects.toThrow(
      "closeAllDocuments is disabled until Stage 7",
    );
  });
});
