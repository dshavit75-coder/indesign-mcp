/**
 * Stage 7A: Unit tests for read-capability.ts
 *
 * Tests the ReadToken API in isolation:
 *   issueReadToken, consumeReadToken, revokeReadToken
 *
 * These tests run before the _readToken track in compose.ts is activated
 * (Stage 7B) and before sendReadScript exists (Stage 7B).
 * They verify the token mechanics that Stage 7B will depend on.
 */

import { describe, it, expect } from "vitest";
import {
  issueReadToken,
  consumeReadToken,
  revokeReadToken,
} from "../../src/read-capability.js";

// ---------------------------------------------------------------------------
// R1: Forgery — object not issued by issueReadToken
// ---------------------------------------------------------------------------
describe("R1: forged token is rejected", () => {
  it("throws read_not_authorized when consuming an object not from issueReadToken", () => {
    const forged = Object.freeze({ documentId: null, issuedBy: "attacker", issuedAt: 0 });
    expect(() => consumeReadToken(forged, null, "test")).toThrow(
      "read_not_authorized: token not issued by this guard",
    );
  });
});

// ---------------------------------------------------------------------------
// R2: Single-use — second consume on the same token throws
// ---------------------------------------------------------------------------
describe("R2: single-use enforcement", () => {
  it("rejects a second consume on the same token", () => {
    const tok = issueReadToken(null, "test-tool");
    consumeReadToken(tok, null, "test"); // first — must succeed
    expect(() => consumeReadToken(tok, null, "test")).toThrow(
      "read_not_authorized: token not issued by this guard",
    );
  });
});

// ---------------------------------------------------------------------------
// R3: documentId mismatch — null issued, non-null demanded
// ---------------------------------------------------------------------------
describe("R3: documentId mismatch (null → string)", () => {
  it("throws when issued with null but consumed with a documentId", () => {
    const tok = issueReadToken(null, "test-tool");
    expect(() => consumeReadToken(tok, "doc1", "test")).toThrow(
      "read_not_authorized: documentId mismatch",
    );
  });
});

// ---------------------------------------------------------------------------
// R4: documentId mismatch — different string
// ---------------------------------------------------------------------------
describe("R4: documentId mismatch (doc1 → doc2)", () => {
  it("throws when documentId does not match the issued value", () => {
    const tok = issueReadToken("doc1", "test-tool");
    expect(() => consumeReadToken(tok, "doc2", "test")).toThrow(
      "read_not_authorized: documentId mismatch",
    );
  });
});

// ---------------------------------------------------------------------------
// R5: Isolation — two concurrent tokens, cross-consume fails
// ---------------------------------------------------------------------------
describe("R5: two concurrent tokens are isolated", () => {
  it("cross-consume is rejected; each token consumed exactly once", () => {
    const tok1 = issueReadToken("doc1", "tool-a");
    const tok2 = issueReadToken("doc2", "tool-b");

    // Cross-consume: tok1 with doc2 — must fail
    expect(() => consumeReadToken(tok1, "doc2", "test")).toThrow(
      "read_not_authorized: documentId mismatch",
    );

    // Cross-consume: tok2 with doc1 — must fail
    expect(() => consumeReadToken(tok2, "doc1", "test")).toThrow(
      "read_not_authorized: documentId mismatch",
    );

    // Correct consume for each — must succeed
    consumeReadToken(tok1, "doc1", "test");
    consumeReadToken(tok2, "doc2", "test");

    // Both are now consumed — second attempt fails
    expect(() => consumeReadToken(tok1, "doc1", "test")).toThrow(
      "read_not_authorized: token not issued by this guard",
    );
    expect(() => consumeReadToken(tok2, "doc2", "test")).toThrow(
      "read_not_authorized: token not issued by this guard",
    );
  });
});

// ---------------------------------------------------------------------------
// R6: revokeReadToken — consume after revoke throws
// ---------------------------------------------------------------------------
describe("R6: revokeReadToken invalidates token before consume", () => {
  it("throws on consume after revoke", () => {
    const tok = issueReadToken("doc1", "test-tool");
    revokeReadToken(tok);
    expect(() => consumeReadToken(tok, "doc1", "test")).toThrow(
      "read_not_authorized: token not issued by this guard",
    );
  });
});

// ---------------------------------------------------------------------------
// R7: revokeReadToken on unknown object — silent
// ---------------------------------------------------------------------------
describe("R7: revokeReadToken on unknown object does not throw", () => {
  it("is silent when called with an object that was never issued", () => {
    const unknown = Object.freeze({ documentId: "x" });
    expect(() => revokeReadToken(unknown)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// R8: null documentId — issued null, consumed null — succeeds
// ---------------------------------------------------------------------------
describe("R8: null documentId round-trip succeeds", () => {
  it("consumes successfully when both issue and consume use null", () => {
    const tok = issueReadToken(null, "test-tool");
    expect(() => consumeReadToken(tok, null, "test")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// R9: calledBy parameter is accepted but does not affect authorization
// ---------------------------------------------------------------------------
describe("R9: calledBy is audit-only and does not affect consume result", () => {
  it("succeeds with any calledBy string when token is valid", () => {
    const tok1 = issueReadToken("doc1", "issuer");
    expect(() => consumeReadToken(tok1, "doc1", "any-caller")).not.toThrow();

    // Different calledBy on a second token — same result
    const tok2 = issueReadToken("doc1", "issuer");
    expect(() => consumeReadToken(tok2, "doc1", "different-caller")).not.toThrow();
  });
});
