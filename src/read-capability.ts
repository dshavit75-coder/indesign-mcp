/**
 * ReadCapability — single-use capability tokens for read operations.
 *
 * Leaf module: no imports from src/. This must remain a leaf to avoid
 * circular dependencies, mirroring write-capability.ts.
 *
 * A ReadToken is issued by issueReadToken() inside sendReadScript() in
 * read-guard.ts. It is consumed exactly once by consumeReadToken() inside
 * wrapExtendScript (compose.ts) on the _readToken track.
 *
 * The token is bound to the documentId that was active at issue time.
 * consumeReadToken verifies documentId equality and deletes the token (single-use).
 *
 * KNOWN LIMITATION: issueReadToken is exported, so any module that imports it
 * could call it directly without going through sendReadScript / read-guard.
 * This is a policy boundary enforced by code review and tests, not a runtime
 * barrier. The same limitation applies to issueWriteCapability.
 * A full audit of callers is deferred to a later stage.
 *
 * ACTIVATION STATUS: the _readToken track in compose.ts is active. Four tools
 * send through sendReadScript: get_app_version, get_page_state, list_pages and
 * list_paragraph_styles. All other read tools still use the legacy pass-through
 * (wrapExtendScript called without opts).
 */

interface ReadTokenInternal {
  readonly documentId: string | null;
  readonly issuedBy: string;
  readonly issuedAt: number; // Date.now() — audit only, not used for expiry
}

// Module-private WeakSet — only issueReadToken adds to it.
const _authorizedReadTokens = new WeakSet<object>();

/**
 * Issue a single-use token for reading a document (or for document-agnostic
 * queries when documentId is null).
 *
 * Called by sendReadScript in read-guard.ts.
 * Direct callers outside of read-guard.ts are a policy violation.
 *
 * @param documentId  The document this token authorizes, or null for queries
 *                    not tied to a specific open document.
 * @param issuedBy    Name of the calling tool — for audit and debugging only.
 *                    Not part of the security check.
 */
export function issueReadToken(
  documentId: string | null,
  issuedBy: string,
): object {
  const tok: ReadTokenInternal = Object.freeze({
    documentId,
    issuedBy,
    issuedAt: Date.now(),
  });
  _authorizedReadTokens.add(tok);
  return tok;
}

/**
 * Consume the token, verifying it was issued by this module and that
 * documentId matches exactly. Removes the token (single-use).
 *
 * This is the runtime enforcement point — wrapExtendScript calls it on the
 * _readToken track.
 *
 * @param tok         The token returned by issueReadToken.
 * @param documentId  Must match the documentId supplied at issue time.
 * @param calledBy    Name of the caller — for audit only, not security.
 *
 * @throws read_not_authorized  If token is unknown, already consumed, or
 *                               documentId does not match.
 */
export function consumeReadToken(
  tok: object,
  documentId: string | null,
  calledBy: string,
): void {
  void calledBy; // audit parameter — used by callers for logging, not checked here
  if (!_authorizedReadTokens.has(tok)) {
    throw new Error("read_not_authorized: token not issued by this guard");
  }
  const typed = tok as ReadTokenInternal;
  if (typed.documentId !== documentId) {
    throw new Error(
      `read_not_authorized: documentId mismatch ` +
        `(expected ${JSON.stringify(typed.documentId)}, got ${JSON.stringify(documentId)})`,
    );
  }
  // Single-use: remove immediately on first consumption.
  _authorizedReadTokens.delete(tok);
}

/**
 * Revoke a token before it is consumed — for use in teardown or error paths.
 * Silent if the token was already consumed or was never issued.
 */
export function revokeReadToken(tok: object): void {
  _authorizedReadTokens.delete(tok);
}
