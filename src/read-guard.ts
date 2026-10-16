/**
 * ReadGuard — central issuer for ReadTokens and dispatcher for read scripts.
 *
 * Stage 7B: This module is the only intended caller of issueReadToken.
 * Tools must call sendReadScript rather than calling issueReadToken directly.
 *
 * KNOWN LIMITATION (documented, not fixed in Stage 7B):
 *   issueReadToken is an exported function — any module that imports it could
 *   call it directly, bypassing sendReadScript. This is a policy boundary
 *   enforced by code review and tests, not a runtime barrier.
 *   The same limitation applies to issueWriteCapability in write-capability.ts.
 *
 * KNOWN LIMITATION (documented, not fixed in Stage 7B):
 *   Enforcement happens inside wrapExtendScript (compose.ts), which is called
 *   by wrapFn before the scriptTemplate is passed to runScriptWithResultFile.
 *   A caller that constructs a scriptTemplate string directly and passes it to
 *   runScriptWithResultFile bypasses this enforcement entirely.
 *   runScriptWithResultFile (src/transport/result-file.ts) is a protected file
 *   and is not modified in Stage 7B. Full enforcement at the send point is a
 *   Stage 7F task.
 */

import { issueReadToken } from "./read-capability.js";

/**
 * Minimal send-function type — mirrors SendFn in write-guard.ts.
 * Accepts scriptTemplate plus any additional options the transport needs.
 */
export type ReadSendFn<R> = (opts: { scriptTemplate: string; [k: string]: unknown }) => Promise<R>;

/**
 * Send a read script with a single-use ReadToken.
 *
 * Flow:
 *   1. Issue a ReadToken bound to documentId and toolName.
 *   2. Call bodyFn() to build the script body.
 *   3. Call wrapFn(body, token, documentId) — wrapFn must call
 *      wrapExtendScript(body, { _readToken: token, documentId })
 *      which calls consumeReadToken, verifies the token, and returns
 *      the wrapped scriptTemplate.
 *   4. Pass scriptTemplate to sendFn.
 *
 * If bodyFn throws, the token is orphaned in the WeakSet (collected when
 * tok goes out of scope). If wrapFn throws (e.g. bad token), sendFn is
 * never called.
 *
 * @param documentId  The document this read targets, or null for global queries
 *                    (e.g. get-app-version) or document-creation scripts where
 *                    the ID is not known before execution.
 *                    null does NOT authorize access to any existing document.
 * @param toolName    Name of the calling tool — for audit only, not security.
 * @param scriptOpts  { bodyFn } — lazy body builder called after token issue.
 * @param sendFn      Injected transport — typically wraps runScriptWithResultFile.
 * @param wrapFn      Injected wrapper — must call wrapExtendScript with _readToken.
 */
export async function sendReadScript<R>(
  documentId: string | null,
  toolName: string,
  scriptOpts: { bodyFn: () => string },
  sendFn: ReadSendFn<R>,
  wrapFn: (body: string, tok: object, documentId: string | null) => string,
): Promise<R> {
  const tok = issueReadToken(documentId, toolName);
  const body = scriptOpts.bodyFn();
  // consumeReadToken is called inside wrapFn → wrapExtendScript.
  // If it throws, sendFn is never reached.
  const scriptTemplate = wrapFn(body, tok, documentId);
  return sendFn({ scriptTemplate });
}
