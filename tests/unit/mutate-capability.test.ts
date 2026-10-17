/**
 * Stage 7C: Unit tests for mutate-capability.ts
 *
 * Tests the MutateToken API in isolation:
 *   issueMutateToken, consumeMutateToken, revokeMutateToken
 *
 * These tests verify the token mechanics that Stage 7C depends on:
 *   - Single-use enforcement
 *   - Body binding (exact match of positional body argument)
 *   - documentId binding
 *   - Forgery rejection via WeakSet
 *   - Failure does not invalidate a valid token
 */

import { describe, it, expect } from "vitest";
import {
  issueMutateToken,
  consumeMutateToken,
  revokeMutateToken,
} from "../../src/mutate-capability.js";

const BODY = `var x = 1; return { x: x };`;
const DOC = "doc-A";

// ---------------------------------------------------------------------------
// M1: Issue and consume — happy path
// ---------------------------------------------------------------------------
describe("M1: issue and consume — happy path", () => {
  it("issues a token that can be consumed once with matching body and documentId", () => {
    const tok = issueMutateToken(DOC, BODY, "M1");
    expect(() => consumeMutateToken(tok, BODY, DOC, "M1")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// M2: Single-use — replay is rejected
// ---------------------------------------------------------------------------
describe("M2: single-use enforcement", () => {
  it("rejects a second consume after first succeeds", () => {
    const tok = issueMutateToken(DOC, BODY, "M2");
    consumeMutateToken(tok, BODY, DOC, "M2");
    expect(() => consumeMutateToken(tok, BODY, DOC, "M2")).toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
  });
});

// ---------------------------------------------------------------------------
// M3: Forgery — object not issued by issueMutateToken
// ---------------------------------------------------------------------------
describe("M3: forged token is rejected", () => {
  it("rejects a plain empty object", () => {
    expect(() => consumeMutateToken({}, BODY, DOC, "M3")).toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
  });

  it("rejects a look-alike object with correct shape but not from WeakSet", () => {
    const lookAlike = Object.freeze({
      body: BODY,
      documentId: DOC,
      issuedBy: "M3",
      issuedAt: Date.now(),
    });
    expect(() => consumeMutateToken(lookAlike, BODY, DOC, "M3")).toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
  });
});

// ---------------------------------------------------------------------------
// M4: Body mismatch
// ---------------------------------------------------------------------------
describe("M4: body mismatch is rejected", () => {
  it("rejects consume when body differs from the body at issue time", () => {
    const tok = issueMutateToken(DOC, BODY, "M4");
    expect(() => consumeMutateToken(tok, "var evil = 1; return {};", DOC, "M4")).toThrow(
      "mutate_not_authorized: body mismatch",
    );
  });
});

// ---------------------------------------------------------------------------
// M5: documentId mismatch
// ---------------------------------------------------------------------------
describe("M5: documentId mismatch is rejected", () => {
  it("rejects consume when documentId differs from the documentId at issue time", () => {
    const tok = issueMutateToken(DOC, BODY, "M5");
    expect(() => consumeMutateToken(tok, BODY, "doc-B", "M5")).toThrow(
      "mutate_not_authorized: documentId mismatch",
    );
  });

  it("rejects null→string mismatch", () => {
    const tok = issueMutateToken(null, BODY, "M5");
    expect(() => consumeMutateToken(tok, BODY, DOC, "M5")).toThrow(
      "mutate_not_authorized: documentId mismatch",
    );
  });

  it("rejects string→null mismatch", () => {
    const tok = issueMutateToken(DOC, BODY, "M5");
    expect(() => consumeMutateToken(tok, BODY, null, "M5")).toThrow(
      "mutate_not_authorized: documentId mismatch",
    );
  });
});

// ---------------------------------------------------------------------------
// M6: revoke before consume
// ---------------------------------------------------------------------------
describe("M6: revoke before consume blocks the token", () => {
  it("revokeMutateToken causes subsequent consume to throw", () => {
    const tok = issueMutateToken(DOC, BODY, "M6");
    revokeMutateToken(tok);
    expect(() => consumeMutateToken(tok, BODY, DOC, "M6")).toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
  });
});

// ---------------------------------------------------------------------------
// M7: revoke is idempotent (double-revoke)
// ---------------------------------------------------------------------------
describe("M7: revoke is idempotent", () => {
  it("revoking twice does not throw", () => {
    const tok = issueMutateToken(DOC, BODY, "M7");
    expect(() => {
      revokeMutateToken(tok);
      revokeMutateToken(tok);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// M8: failed consume does not invalidate the token
// ---------------------------------------------------------------------------
describe("M8: failed consume does not invalidate token", () => {
  it("a body-mismatch failure does not prevent a later correct consume", () => {
    const tok = issueMutateToken(DOC, BODY, "M8");
    // Bad consume — body mismatch
    expect(() => consumeMutateToken(tok, "wrong body", DOC, "M8")).toThrow(
      "mutate_not_authorized: body mismatch",
    );
    // Token still valid — correct consume succeeds
    expect(() => consumeMutateToken(tok, BODY, DOC, "M8")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// M9: null documentId round-trip
// ---------------------------------------------------------------------------
describe("M9: null documentId is supported", () => {
  it("issues and consumes a token with null documentId", () => {
    const tok = issueMutateToken(null, BODY, "M9");
    expect(() => consumeMutateToken(tok, BODY, null, "M9")).not.toThrow();
  });
});
