/**
 * WriteCapability — single-use capability tokens for write operations.
 *
 * Leaf module: no imports from src/. This must remain a leaf to avoid
 * circular dependencies (write-guard.ts and compose.ts both import it).
 *
 * A WriteCapability is issued by issueWriteCapability() after authorization
 * and consumed exactly once by consumeWriteCapability() inside wrapExtendScript.
 * The capability is bound to:
 *   - the exact script body string
 *   - the approved WriteOperation
 *
 * This ensures the authorized body is the body that gets executed.
 *
 * KNOWN LIMITATION (Stage 7): issueWriteCapability is exported, so any module
 * that imports it could call it directly without going through write-guard.
 * This is a policy boundary enforced by test, not a runtime barrier.
 * Stage 7 will audit all callers.
 */

export type WriteOperation = "save-as" | "in-place-save" | "export-pdf";

interface WriteCapabilityInternal {
  readonly body: string;
  readonly operation: WriteOperation;
}

// Module-private WeakSet — only issueWriteCapability adds to it.
const _authorizedCaps = new WeakSet<object>();

/**
 * Issue a single-use capability bound to `body` and `operation`.
 * Called by sendWriteScript in write-guard.ts after assertWriteAllowed succeeds.
 */
export function issueWriteCapability(body: string, operation: WriteOperation): object {
  const cap: WriteCapabilityInternal = Object.freeze({ body, operation });
  _authorizedCaps.add(cap);
  return cap;
}

/**
 * Consume the capability, verifying it was issued by this module,
 * that the body matches exactly, and that the operation matches.
 * Removes the capability from the WeakSet (single-use).
 *
 * Throws on any mismatch — this is the runtime enforcement point.
 */
export function consumeWriteCapability(cap: object, body: string, operation: WriteOperation): void {
  if (!_authorizedCaps.has(cap)) {
    throw new Error("write_not_authorized: capability not issued by this guard");
  }
  const typed = cap as WriteCapabilityInternal;
  if (typed.body !== body) {
    throw new Error("write_not_authorized: capability body mismatch");
  }
  if (typed.operation !== operation) {
    throw new Error("write_not_authorized: capability operation mismatch");
  }
  // Single-use: remove immediately on first consumption.
  _authorizedCaps.delete(cap);
}
