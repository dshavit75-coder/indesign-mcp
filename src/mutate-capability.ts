/**
 * MutateCapability — single-use capability tokens for document mutation operations.
 *
 * Leaf module: no imports from src/. This must remain a leaf to avoid
 * circular dependencies, mirroring write-capability.ts and read-capability.ts.
 *
 * A MutateToken is issued by issueMutateToken() inside sendMutateScript() in
 * mutate-guard.ts. It is consumed exactly once by consumeMutateToken() inside
 * wrapExtendScript (compose.ts) on the _mutateToken track.
 *
 * The token is bound to:
 *   - the exact script body string (built before issue, consumed via the positional
 *     `body` argument to wrapExtendScript — NOT via an opts.body field)
 *   - the documentId that was active at issue time
 *
 * consumeMutateToken verifies both and deletes the token (single-use).
 *
 * Body binding contrast with ReadToken:
 *   ReadToken does NOT bind body — read scripts are idempotent.
 *   MutateToken DOES bind body — mutations are irreversible; the authorized body
 *   must be the body that gets dispatched.
 *
 * KNOWN LIMITATION: issueMutateToken is exported, so any module that imports it
 * could call it directly without going through sendMutateScript / mutate-guard.
 * This is a policy boundary enforced by code review and tests, not a runtime
 * barrier. The same limitation applies to issueWriteCapability and issueReadToken.
 * A full audit of callers is deferred to a later stage.
 *
 * ACTIVATION STATUS: the _mutateToken track in compose.ts is active in Stage 7C.
 * Two tools send through sendMutateScript: apply_paragraph_style and
 * apply_character_style_to_range. All other mutation tools still use the legacy
 * pass-through (wrapExtendScript called without opts).
 *
 * KNOWN GAP (G6): documentId checked here is the value passed through the call
 * chain, not verified against the InDesign document actually receiving the script.
 * Full enforcement is deferred to B9.
 */

interface MutateTokenInternal {
  readonly body: string;
  readonly documentId: string | null;
  readonly issuedBy: string;
  readonly issuedAt: number; // Date.now() — audit only, not used for expiry
}

// Module-private WeakSet — only issueMutateToken adds to it.
const _authorizedMutateTokens = new WeakSet<object>();

/**
 * Issue a single-use token for a document mutation operation.
 *
 * Called by sendMutateScript in mutate-guard.ts AFTER building the body.
 * Direct callers outside of mutate-guard.ts are a policy violation.
 *
 * @param documentId  The document this token authorizes, or null for mutations
 *                    not tied to a specific open document (e.g. activeDocument).
 * @param body        The exact script body string this token authorizes.
 *                    consumeMutateToken will verify the positional body argument
 *                    to wrapExtendScript matches this value exactly.
 * @param issuedBy    Name of the calling tool — for audit and debugging only.
 *                    Not part of the security check.
 */
export function issueMutateToken(
  documentId: string | null,
  body: string,
  issuedBy: string,
): object {
  const tok: MutateTokenInternal = Object.freeze({
    body,
    documentId,
    issuedBy,
    issuedAt: Date.now(),
  });
  _authorizedMutateTokens.add(tok);
  return tok;
}

/**
 * Consume the token, verifying:
 *   1. It was issued by this module (WeakSet membership).
 *   2. The body matches the body supplied at issue time (exact string equality).
 *   3. The documentId matches the documentId supplied at issue time.
 *
 * On success, removes the token from the WeakSet (single-use).
 * On failure, does NOT remove the token — a bad attempt does not invalidate a
 * valid token (consistent with consumeReadToken behavior).
 *
 * This is the runtime enforcement point — wrapExtendScript calls it on the
 * _mutateToken track, passing the positional `body` argument (the script that
 * will be dispatched). This guarantees that the authorized body is the dispatched
 * body, not merely an opts.body value.
 *
 * @param tok         The token returned by issueMutateToken.
 * @param body        Must match the body supplied at issue time. This is the
 *                    positional `body` argument to wrapExtendScript — the actual
 *                    script being dispatched.
 * @param documentId  Must match the documentId supplied at issue time.
 * @param calledBy    Name of the caller — for audit only, not security.
 *
 * @throws mutate_not_authorized  If token is unknown, already consumed, body
 *                                mismatch, or documentId mismatch.
 */
export function consumeMutateToken(
  tok: object,
  body: string,
  documentId: string | null,
  calledBy: string,
): void {
  void calledBy; // audit parameter — used by callers for logging, not checked here
  if (!_authorizedMutateTokens.has(tok)) {
    throw new Error("mutate_not_authorized: token not issued by this guard");
  }
  const typed = tok as MutateTokenInternal;
  if (typed.body !== body) {
    throw new Error("mutate_not_authorized: body mismatch");
  }
  if (typed.documentId !== documentId) {
    throw new Error(
      `mutate_not_authorized: documentId mismatch ` +
        `(expected ${JSON.stringify(typed.documentId)}, got ${JSON.stringify(documentId)})`,
    );
  }
  // Single-use: remove immediately on first successful consumption.
  _authorizedMutateTokens.delete(tok);
}

/**
 * Revoke a token before it is consumed — for use in teardown or error paths.
 * Silent if the token was already consumed or was never issued.
 */
export function revokeMutateToken(tok: object): void {
  _authorizedMutateTokens.delete(tok);
}
