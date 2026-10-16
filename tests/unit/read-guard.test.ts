/**
 * Stage 7B — read-guard.ts unit tests
 *
 * Tests G1–G8: verify that sendReadScript issues a ReadToken, passes it through
 * wrapFn, and that consumeReadToken fires exactly once (single-use enforcement).
 *
 * These tests do NOT exercise InDesign or result-file.ts. sendFn is a stub that
 * captures the opts it receives and returns a resolved promise.
 */

import { describe, it, expect, vi } from "vitest";
import { sendReadScript } from "../../src/read-guard.js";
import { consumeReadToken } from "../../src/read-capability.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A stub sendFn that records the last scriptTemplate it received. */
function makeSendFn<R>(returnValue: R) {
  let lastOpts: { scriptTemplate: string } | null = null;
  const fn = vi.fn(async (opts: { scriptTemplate: string }) => {
    lastOpts = opts;
    return returnValue;
  });
  return { fn, getLastOpts: () => lastOpts };
}

/** A wrapFn that embeds the token reference into the script body as a marker,
 *  then returns the body unchanged (the token object reference is what matters,
 *  not the script text).
 */
function captureWrapFn(
  captured: { tok: object | null; documentId: string | null | undefined },
) {
  return (body: string, tok: object, documentId: string | null): string => {
    captured.tok = tok;
    captured.documentId = documentId;
    return body;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sendReadScript", () => {
  // G1: sendReadScript resolves to whatever sendFn returns
  it("G1: resolves to the value returned by sendFn", async () => {
    const expected = { ok: true, result: { version: "2026" } };
    const { fn } = makeSendFn(expected);
    const captured = { tok: null as object | null, documentId: undefined as string | null | undefined };

    const result = await sendReadScript(
      null,
      "test_tool",
      { bodyFn: () => "return 1;" },
      fn,
      captureWrapFn(captured),
    );

    expect(result).toBe(expected);
  });

  // G2: wrapFn receives a non-null token object
  it("G2: wrapFn receives a non-null token object", async () => {
    const { fn } = makeSendFn(undefined);
    const captured = { tok: null as object | null, documentId: undefined as string | null | undefined };

    await sendReadScript(
      null,
      "test_tool",
      { bodyFn: () => "return 2;" },
      fn,
      captureWrapFn(captured),
    );

    expect(captured.tok).not.toBeNull();
    expect(typeof captured.tok).toBe("object");
  });

  // G3: wrapFn receives the correct documentId (null)
  it("G3: wrapFn receives documentId: null for global queries", async () => {
    const { fn } = makeSendFn(undefined);
    const captured = { tok: null as object | null, documentId: undefined as string | null | undefined };

    await sendReadScript(
      null,
      "test_tool",
      { bodyFn: () => "return 3;" },
      fn,
      captureWrapFn(captured),
    );

    expect(captured.documentId).toBeNull();
  });

  // G4: wrapFn receives the correct documentId (non-null string)
  it("G4: wrapFn receives documentId string when provided", async () => {
    const { fn } = makeSendFn(undefined);
    const captured = { tok: null as object | null, documentId: undefined as string | null | undefined };

    await sendReadScript(
      "doc-abc-123",
      "test_tool",
      { bodyFn: () => "return 4;" },
      fn,
      captureWrapFn(captured),
    );

    expect(captured.documentId).toBe("doc-abc-123");
  });

  // G5: the token issued by sendReadScript is valid at the time wrapFn runs
  //     — consumeReadToken must NOT throw inside wrapFn
  it("G5: token is valid (consumable) inside wrapFn", async () => {
    const { fn } = makeSendFn(undefined);
    let errorInWrap: Error | null = null;

    await sendReadScript(
      null,
      "test_tool",
      { bodyFn: () => "return 5;" },
      fn,
      (body, tok, docId) => {
        try {
          consumeReadToken(tok, docId, "G5-test");
        } catch (e) {
          errorInWrap = e as Error;
        }
        return body;
      },
    );

    expect(errorInWrap).toBeNull();
  });

  // G6: token is single-use — a second consumeReadToken call throws
  it("G6: token is single-use — second consume throws read_not_authorized", async () => {
    const { fn } = makeSendFn(undefined);
    let capturedTok: object | null = null;
    let capturedDocId: string | null = null;

    await sendReadScript(
      null,
      "test_tool",
      { bodyFn: () => "return 6;" },
      fn,
      (body, tok, docId) => {
        // First consume inside wrapFn (simulates wrapExtendScript behavior)
        consumeReadToken(tok, docId, "G6-first");
        capturedTok = tok;
        capturedDocId = docId;
        return body;
      },
    );

    // Second consume must throw
    expect(() => consumeReadToken(capturedTok!, capturedDocId, "G6-second")).toThrow(
      "read_not_authorized",
    );
  });

  // G7: a forged token (plain object, not issued by issueReadToken) is rejected
  it("G7: a forged token not issued by issueReadToken is rejected by consumeReadToken", () => {
    const forged = { documentId: null, issuedBy: "attacker", issuedAt: Date.now() };
    expect(() => consumeReadToken(forged, null, "G7-test")).toThrow("read_not_authorized");
  });

  // G8: bodyFn is called exactly once per sendReadScript invocation
  it("G8: bodyFn is called exactly once", async () => {
    const { fn } = makeSendFn(undefined);
    const bodyFn = vi.fn(() => "return 8;");

    await sendReadScript(
      null,
      "test_tool",
      { bodyFn },
      fn,
      (body, _tok, _docId) => body,
    );

    expect(bodyFn).toHaveBeenCalledTimes(1);
  });
});
