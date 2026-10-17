/**
 * Stage 7C: Unit tests for mutate-guard.ts — sendMutateScript
 *
 * MG1: happy path end-to-end
 * MG2: bodyFn throws before the token is issued → error propagates, sendFn not called
 * MG3: wrapFn throws BEFORE consuming → sendFn not called and the issued token is revoked (cannot be consumed later)
 * MG4: sendFn throws AFTER wrapFn consumed the token → error propagates; no usable token remains (revoke is a silent no-op here)
 * MG5: bodyFn called before issueMutateToken (ordering)
 * MG6: wrapFn receives the token from issueMutateToken (not a different object)
 * MG7: tamper body-swap in wrapFn → enforcement throws; sendFn not called
 * MG8: tamper documentId swap → enforcement throws; sendFn not called
 */

import { describe, it, expect, vi } from "vitest";
import { sendMutateScript } from "../../src/mutate-guard.js";
import { wrapExtendScript } from "../../src/compose.js";
import { issueMutateToken, consumeMutateToken } from "../../src/mutate-capability.js";

const DOC = "doc-A";
const BODY = `var x = 1; return { x: x };`;

// ---------------------------------------------------------------------------
// MG1: happy path
// ---------------------------------------------------------------------------
describe("MG1: sendMutateScript happy path", () => {
  it("calls sendFn exactly once and returns its result", async () => {
    const sendFn = vi.fn().mockResolvedValue({ result: "ok" });
    const result = await sendMutateScript(
      DOC,
      () => BODY,
      (body, tok, docId) => wrapExtendScript(body, { _mutateToken: tok, documentId: docId }),
      sendFn,
      "MG1",
    );
    expect(sendFn).toHaveBeenCalledOnce();
    expect(result).toEqual({ result: "ok" });
  });
});

// ---------------------------------------------------------------------------
// MG2: bodyFn throws before the token is issued → error propagates, sendFn not called
// (no token exists yet, so there is nothing to revoke in this path)
// ---------------------------------------------------------------------------
describe("MG2: bodyFn throws before issue", () => {
  it("propagates bodyFn error and never calls sendFn", async () => {
    const sendFn = vi.fn();
    await expect(
      sendMutateScript(
        DOC,
        () => { throw new Error("bodyFn boom"); },
        (body, tok, docId) => wrapExtendScript(body, { _mutateToken: tok, documentId: docId }),
        sendFn,
        "MG2",
      ),
    ).rejects.toThrow("bodyFn boom");
    expect(sendFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// MG3: wrapFn throws BEFORE the token is consumed → sendFn not called, token revoked
//
// This is the path where the revoke in sendMutateScript's catch block actually matters: the token has been
// issued and NOT consumed. After the failure it must not be usable. The token is captured inside wrapFn and
// tried again afterwards; if the revoke were removed, that later consume would succeed and this test fails.
// ---------------------------------------------------------------------------
describe("MG3: wrapFn throws before consuming → token is revoked", () => {
  it("propagates the error, never calls sendFn, and the issued token can no longer be consumed", async () => {
    const sendFn = vi.fn();
    let captured: object | undefined;
    await expect(
      sendMutateScript(
        DOC,
        () => BODY,
        (_body, tok) => {
          captured = tok;
          throw new Error("wrapFn boom"); // fails before wrapExtendScript, so the token is NOT consumed
        },
        sendFn,
        "MG3",
      ),
    ).rejects.toThrow("wrapFn boom");

    expect(captured).toBeDefined(); // precondition: a token was issued and handed to wrapFn
    expect(sendFn).not.toHaveBeenCalled();
    // The token was never consumed, so only the revoke can have made it unusable.
    expect(() => consumeMutateToken(captured as object, BODY, DOC, "MG3")).toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
  });
});

// ---------------------------------------------------------------------------
// MG4: sendFn throws AFTER wrapFn consumed the token → error propagates, no usable token remains
//
// Here wrapExtendScript has already consumed the token, so the revoke in the catch block is a silent no-op
// and cannot be observed on its own. What this test proves: the failure is propagated, sendFn ran once, and
// the token cannot be used again. It does NOT prove that the revoke ran (MG3 does).
// ---------------------------------------------------------------------------
describe("MG4: sendFn throws after the token was consumed", () => {
  it("propagates the error, calls sendFn once, and the token cannot be consumed again", async () => {
    const sendFn = vi.fn().mockRejectedValue(new Error("sendFn boom"));
    let captured: object | undefined;
    await expect(
      sendMutateScript(
        DOC,
        () => BODY,
        (body, tok, docId) => {
          captured = tok;
          return wrapExtendScript(body, { _mutateToken: tok, documentId: docId }); // consumes the token
        },
        sendFn,
        "MG4",
      ),
    ).rejects.toThrow("sendFn boom");

    expect(captured).toBeDefined(); // precondition: wrapFn ran and consumed the token
    expect(sendFn).toHaveBeenCalledOnce();
    expect(() => consumeMutateToken(captured as object, BODY, DOC, "MG4")).toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
  });
});

// ---------------------------------------------------------------------------
// MG5: bodyFn called before issueMutateToken (ordering guarantee)
// ---------------------------------------------------------------------------
describe("MG5: ordering — bodyFn called before wrapFn", () => {
  it("bodyFn return value is passed as the positional body to wrapFn", async () => {
    const calls: string[] = [];
    const sendFn = vi.fn().mockResolvedValue("ok");

    await sendMutateScript(
      DOC,
      () => { calls.push("bodyFn"); return BODY; },
      (body, tok, docId) => {
        calls.push("wrapFn");
        return wrapExtendScript(body, { _mutateToken: tok, documentId: docId });
      },
      sendFn,
      "MG5",
    );

    expect(calls).toEqual(["bodyFn", "wrapFn"]);
  });
});

// ---------------------------------------------------------------------------
// MG6: wrapFn receives the real token from issueMutateToken (not a stub)
// ---------------------------------------------------------------------------
describe("MG6: wrapFn receives a valid token", () => {
  it("wrapFn tok passes WeakSet membership check in consumeMutateToken", async () => {
    const sendFn = vi.fn().mockResolvedValue("ok");
    // If tok were a stub, consumeMutateToken would throw; the happy path proves it is real.
    await expect(
      sendMutateScript(
        DOC,
        () => BODY,
        (body, tok, docId) => wrapExtendScript(body, { _mutateToken: tok, documentId: docId }),
        sendFn,
        "MG6",
      ),
    ).resolves.toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// MG7: tamper — body-swap in wrapFn → enforcement throws; sendFn not called
// ---------------------------------------------------------------------------
describe("MG7: tamper body-swap in wrapFn", () => {
  it("throws body mismatch when positional body is swapped; sendFn not called", async () => {
    const sendFn = vi.fn();
    await expect(
      sendMutateScript(
        DOC,
        () => BODY,
        (body, tok, docId) =>
          // Tamper: swap positional body to evil string
          wrapExtendScript("var evil = 1; return {};", { _mutateToken: tok, documentId: docId }),
        sendFn,
        "MG7",
      ),
    ).rejects.toThrow("mutate_not_authorized: body mismatch");
    expect(sendFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// MG8: tamper — documentId swap → enforcement throws; sendFn not called
// ---------------------------------------------------------------------------
describe("MG8: tamper documentId swap in wrapFn", () => {
  it("throws documentId mismatch when documentId is swapped; sendFn not called", async () => {
    const sendFn = vi.fn();
    await expect(
      sendMutateScript(
        DOC,
        () => BODY,
        (body, tok, _docId) =>
          // Tamper: swap documentId to a different document
          wrapExtendScript(body, { _mutateToken: tok, documentId: "doc-EVIL" }),
        sendFn,
        "MG8",
      ),
    ).rejects.toThrow("mutate_not_authorized: documentId mismatch");
    expect(sendFn).not.toHaveBeenCalled();
  });
});
