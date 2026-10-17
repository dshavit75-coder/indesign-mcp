/**
 * mutate-guard.ts — sendMutateScript: the authorized send path for document
 * mutation operations.
 *
 * Stage 7C: two tools use this path:
 *   - apply_paragraph_style
 *   - apply_character_style_to_range
 *
 * All other mutation tools (21 remaining) still use the legacy pass-through
 * in wrapExtendScript (no opts). Gating those tools is deferred to B9 per
 * decision D2-d. Stage 7C is a targeted exception to D2-d covering only the
 * two tools above.
 *
 * KNOWN GAP (G6): documentId verified here is the value supplied by the tool,
 * not independently confirmed to match the InDesign document that receives the
 * script. Full enforcement deferred to B9.
 *
 * KNOWN GAP (G7/Stage 7F): runScriptWithResultFile callers that bypass
 * wrapExtendScript entirely are not gated by this guard.
 *
 * sendMutateScript flow:
 *   1. body = bodyFn()              — build script body FIRST
 *   2. tok  = issueMutateToken(...) — bind body + documentId into token
 *   3. wrapFn(body, tok, documentId) — caller calls wrapExtendScript(body, { _mutateToken: tok, documentId })
 *                                       consumeMutateToken runs inside wrapExtendScript
 *   4. sendFn(...)                  — dispatch
 *   5. catch: revokeMutateToken(tok) — silent cleanup if tok not yet consumed
 */

import { issueMutateToken, revokeMutateToken } from "./mutate-capability.js";

/**
 * Execute a mutation script through the authorized token pathway.
 *
 * @param documentId  The document ID to bind in the token, or null for
 *                    activeDocument mutations.
 * @param bodyFn      Builds and returns the ExtendScript body string.
 *                    Called BEFORE issueMutateToken so the token binds the
 *                    actual body that will be dispatched.
 * @param wrapFn      Called with (body, tok, documentId). Must call
 *                    wrapExtendScript(body, { _mutateToken: tok, documentId })
 *                    — this is where consumeMutateToken runs.
 *                    Returns the wrapped JXA string.
 * @param sendFn      Sends the wrapped script and returns the result.
 * @param toolName    Identifying name passed to issueMutateToken for audit.
 * @returns           The result of sendFn.
 */
export async function sendMutateScript<R>(
  documentId: string | null,
  bodyFn: () => string,
  wrapFn: (body: string, tok: object, documentId: string | null) => string,
  sendFn: (scriptTemplate: string) => Promise<R>,
  toolName: string,
): Promise<R> {
  // Step 1: build body first — token binds the body we actually dispatch.
  const body = bodyFn();

  // Step 2: issue token with body bound.
  const tok = issueMutateToken(documentId, body, toolName);

  try {
    // Step 3: wrap — consumeMutateToken runs inside wrapExtendScript.
    const scriptTemplate = wrapFn(body, tok, documentId);

    // Step 4: dispatch.
    return await sendFn(scriptTemplate);
  } catch (err) {
    // Step 5: revoke if not yet consumed (silent if already consumed).
    revokeMutateToken(tok);
    throw err;
  }
}
