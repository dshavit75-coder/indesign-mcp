import { z } from "zod";
import { randomBytes } from "node:crypto";
import { resolveUserPath } from "../path-utils.js";
import { defineTool } from "./registry.js";
import { runScriptWithResultFile } from "../transport/result-file.js";
import { wrapExtendScript, lit, prelude } from "../compose.js";
import { findDocumentById } from "../script-helpers.js";
import { ok, fail } from "../errors.js";
import type { Envelope } from "../types.js";
import {
  decideWrite,
  reservePlaceholder,
  cleanupPlaceholder,
  sendWriteScript,
  registrySet,
  type SendFn,
} from "../write-guard.js";
import { lstatSync, type Stats } from "node:fs";
import { WriteMutex } from "../write-mutex.js";

// ---------------------------------------------------------------------------
// Input / Output schemas
// ---------------------------------------------------------------------------

const InputSchema = z
  .object({
    path: z.string().optional(),
    document_id: z.string().optional(),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

// Pre-query result schema (read-only InDesign call)
const PreQuerySchema = z.object({
  documentId: z.string(),
  fullName: z.string(),
});
type PreQuery = z.infer<typeof PreQuerySchema>;

const ScriptResultSchema = z.object({
  path: z.string(),
});
type ScriptResult = z.infer<typeof ScriptResultSchema>;

// ---------------------------------------------------------------------------
// Reading doc.fullName (shared by the pre-query and the save script)
//
// Observed live on InDesign 21.6.0.57 (one observation, not a guarantee): for a document that was
// never saved, doc.fullName THROWS "Unsaved documents have no full name." (error number 90938) and
// doc.filePath THROWS "Unsaved documents have no path." (90937). It does not return "".
//
// __readFullName returns "" ONLY when ALL of these hold; in every other case it re-throws the
// ORIGINAL error of doc.fullName, so nothing unexpected is swallowed:
//   - doc.saved === false;
//   - doc.fullName threw an error that is the known one (number 90938, or a message that starts with
//     "Unsaved documents have no");
//   - doc.filePath ALSO threw, and its error is the known one (number 90937, or a message that starts
//     with "Unsaved documents have no").
// If InDesign words these errors differently (other language or version) the save fails closed with
// the original error. In the SAVE script that error is re-thrown with entity "save_precheck" (the read happens
// before doc.save), so a path-A placeholder can be removed; the pre-query rethrows it unchanged.
// No JSON, no ES5-only methods (ExtendScript is pre-ES5).
// ---------------------------------------------------------------------------

const READ_FULLNAME_HELPER = `
function __errField(e, k) { try { return e[k]; } catch (x) { return undefined; } }
function __isKnownUnsavedError(e, num) {
  if (__errField(e, "number") === num) return true;
  var m = __errField(e, "message");
  return typeof m === "string" && m.indexOf("Unsaved documents have no") === 0;
}
function __readFullName(doc) {
  try {
    return String(doc.fullName);
  } catch (e1) {
    if (doc.saved !== false) throw e1;
    if (!__isKnownUnsavedError(e1, 90938)) throw e1;
    var __pathThrew = false;
    try { String(doc.filePath); } catch (e2) {
      if (!__isKnownUnsavedError(e2, 90937)) throw e1;
      __pathThrew = true;
    }
    if (!__pathThrew) throw e1;
    return "";
  }
}
`.trim();

// ---------------------------------------------------------------------------
// Pre-query: read-only call to resolve documentId and fullName
// This does NOT use write-guard because it is read-only.
// ---------------------------------------------------------------------------

function buildPreQueryScript(inputDocumentId: string | undefined): string {
  const docExpr =
    inputDocumentId !== undefined
      ? `findDocumentById(${lit(inputDocumentId)})`
      : "app.activeDocument";

  return `
${prelude(findDocumentById, READ_FULLNAME_HELPER)}
if (app.documents.length === 0) {
  throw { name: "not_found", message: "no open document" };
}
var doc = ${docExpr};
if (doc === null) {
  throw { name: "not_found", message: "document not found: " + ${inputDocumentId !== undefined ? lit(inputDocumentId) : '""'} };
}
return { documentId: String(doc.id), fullName: __readFullName(doc) };
`;
}

// ---------------------------------------------------------------------------
// Write script: performs the actual save
// ---------------------------------------------------------------------------

/**
 * Checks the script performs inside InDesign immediately before saving.
 *   - expectedFullName: doc.fullName as seen by the pre-query; a different value
 *     means the document was swapped, closed or saved elsewhere since then.
 *   - mode "A": the target must be the empty placeholder reserved for this save.
 *   - mode "B": the target must exist with the size recorded in the decision.
 * These detect a changed document and a deleted / differently-sized file. They
 * cannot detect a same-size replacement or any change after the save starts.
 */
type SaveChecks = { expectedFullName: string } & (
  | { mode: "A" }
  | { mode: "B"; expectedSize: number }
);

function buildSaveScript(
  documentId: string,
  absolutePath: string,
  checks: SaveChecks,
): string {
  // Always target by documentId (result of pre-query), never app.activeDocument,
  // to avoid accidentally saving the wrong document if focus changed.
  const docExpr = `findDocumentById(${lit(documentId)})`;

  const targetCheck =
    checks.mode === "A"
      ? `if (!__target.exists || __target.length !== 0) {
  throw { name: "name_collision", entity: "save_precheck", message: "target is not the empty reserved placeholder: " + ${lit(absolutePath)} };
}`
      : `if (!__target.exists || __target.length !== ${checks.expectedSize}) {
  throw { name: "name_collision", entity: "save_precheck", message: "target file is missing or changed size: " + ${lit(absolutePath)} };
}`;

  return `
${prelude(findDocumentById, READ_FULLNAME_HELPER)}
var doc = ${docExpr};
if (doc === null) {
  throw { name: "not_found", entity: "save_precheck", message: "document not found during save: " + ${lit(documentId)} };
}
var __fullName;
try {
  __fullName = __readFullName(doc);
} catch (__e) {
  // Still BEFORE doc.save: say so with the save_precheck entity (the proof that nothing was written, which is
  // what lets a path-A placeholder be removed), and keep the original message. Nothing is swallowed.
  throw { name: "script_error", entity: "save_precheck", message: String(__errField(__e, "message") || __e), stack: String(__errField(__e, "stack") || "") };
}
if (__fullName !== ${lit(checks.expectedFullName)}) {
  throw { name: "io_error", entity: "save_precheck", message: "document changed between query and save: expected fullName " + ${lit(checks.expectedFullName)} + ", found " + __fullName };
}
var __target = File(${lit(absolutePath)});
${targetCheck}
doc.save(File(${lit(absolutePath)}));
return { path: String(doc.fullName) };
`;
}

/**
 * `entity` carried by the errors that buildSaveScript throws BEFORE it calls doc.save.
 * It is the script's own proof that nothing was written.
 */
const SAVE_PRECHECK_ENTITY = "save_precheck";

/**
 * True only when a failure envelope PROVES the save script never reached doc.save, so the
 * path-A placeholder may safely be removed. Everything else is unknown: the write may have
 * started or may still be running inside InDesign.
 *
 *   - our own pre-save checks (document swapped, target not the empty placeholder, ...);
 *   - findDocumentById did not find the document (it runs before doc.save);
 *   - osascript could not even be spawned, so the script never ran.
 *
 * Deliberately NOT proof: timeout, script_error, app_not_available, and any other io_error
 * (for example a result file that could not be read after the script ran).
 */
function envelopeProvesNoWrite(error: { kind: string; message: string; entity?: string }): boolean {
  if (error.entity === SAVE_PRECHECK_ENTITY) return true;
  if (error.kind === "not_found" && error.entity === "document") return true;
  if (error.kind === "io_error" && error.message.startsWith("osascript spawn failed:")) return true;
  return false;
}

function unknownOutcomeHint(path: string): string {
  return (
    `The outcome of the save is unknown, so the reserved file ${path} was left in place and this path ` +
    "is blocked for further saves. Check the file, then remove it manually or save under another name."
  );
}

/**
 * What actually happened when we tried to remove the path-A placeholder.
 *   removed      we removed our empty placeholder
 *   already_gone nothing was there any more
 *   failed       it is still ours (same inode, empty) but could not be removed
 *   not_ours     something else is there now (replaced, has content, symlink): left untouched
 */
type CleanupOutcome = "removed" | "already_gone" | "failed" | "not_ours";

function statOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** Same ownership test cleanupPlaceholder applies before it removes anything. */
function isOurEmptyPlaceholder(st: Stats, inode: number): boolean {
  return st.isFile() && st.size === 0 && st.ino === inode;
}

/**
 * Remove our placeholder through cleanupPlaceholder (unchanged: it removes only the same empty
 * inode and swallows errors) and report what really happened. A file that is no longer our empty
 * placeholder is not touched at all.
 */
function cleanUpPlaceholder(path: string, inode: number): CleanupOutcome {
  const before = statOrNull(path);
  if (before !== null && !isOurEmptyPlaceholder(before, inode)) return "not_ours";
  cleanupPlaceholder(path, inode);
  const after = statOrNull(path);
  if (after === null) return before === null ? "already_gone" : "removed";
  // Something is there now. The removal "failed" only if what is there is still OUR empty
  // placeholder (same inode); anything else (replaced meanwhile, created by someone else,
  // or there although nothing was before) is not ours and was not touched.
  return before !== null && isOurEmptyPlaceholder(after, inode) ? "failed" : "not_ours";
}

/** The sentence to add to the original error when the clean-up left a file behind (else undefined). */
function cleanupNote(outcome: CleanupOutcome, path: string): string | undefined {
  if (outcome === "failed") {
    return `The reserved file ${path} could not be removed and is still in place; this path stays blocked for further saves until it is removed manually.`;
  }
  if (outcome === "not_ours") {
    return `The reserved file ${path} was not removed because it is no longer the empty file this call reserved (it was replaced or now has content); this path stays blocked for further saves until it is checked.`;
  }
  return undefined; // removed or already gone: nothing to add
}

function withNote(message: string, note: string | undefined): string {
  return note === undefined ? message : `${message}. ${note}`;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

// The unlocked tool: its handler body is unchanged. saveDocumentTool below runs it one call at a time.
const saveDocumentUnlocked = defineTool<Input, { path: string }>({
  name: "save_document",
  description:
    "Saves an InDesign document to disk. " +
    "With `path`, performs a save-as to that path (must not exist unless owned by this session). " +
    "Without `path`, saves in-place (document must have been opened or created by this session). " +
    "Returns io_error if the document has no saved path and no `path` was provided. " +
    "Never overwrites a file not owned by this session; returns name_collision instead.",
  inputSchema: InputSchema,

  async handler(input) {
    // -----------------------------------------------------------------------
    // Step 1: Read-only pre-query — resolve documentId and current path
    // -----------------------------------------------------------------------
    const preQueryScript = buildPreQueryScript(input.document_id);
    const preQueryEnvelope = await runScriptWithResultFile<PreQuery>({
      language: "JavaScript",
      scriptTemplate: wrapExtendScript(preQueryScript),
      resultSchema: PreQuerySchema,
    });
    if (!preQueryEnvelope.ok) {
      return preQueryEnvelope;
    }
    const { documentId, fullName } = preQueryEnvelope.result!;

    // -----------------------------------------------------------------------
    // Step 2: Determine operation and target path
    // -----------------------------------------------------------------------
    let targetAbsolutePath: string | undefined;
    let operation: "save-as" | "in-place-save";

    if (input.path !== undefined) {
      // Save-as: caller provided a path
      targetAbsolutePath = resolveUserPath(input.path);
      operation = "save-as";
    } else {
      // In-place save: use the document's current fullName.
      //
      // For a never-saved document the pre-query returns "" (see __readFullName: InDesign 21.6.0.57
      // throws for doc.fullName, error 90938, and for doc.filePath, 90937; the helper maps exactly that
      // pair, with doc.saved === false, to ""). Per the fail-closed rule: refuse if fullName is
      // empty or not absolute.
      if (!fullName || !fullName.startsWith("/")) {
        return fail(
          "io_error",
          "document has no saved path (Untitled or not yet saved); " +
            "provide a `path` argument to save-as",
        );
      }
      targetAbsolutePath = fullName;
      operation = "in-place-save";
    }

    // -----------------------------------------------------------------------
    // Step 3: decideWrite — single gate for ownership and path validation
    // -----------------------------------------------------------------------
    const decideResult = await decideWrite({
      tool: "save_document",
      operation,
      documentId,
      path: targetAbsolutePath,
      expectedExtension: ".indd",
    });

    if (!decideResult.ok) {
      return fail(
        decideResult.kind === "invalid_args" ? "invalid_args" : "name_collision",
        decideResult.message,
        {
          existing_path: decideResult.existing_path,
          suggested_path: decideResult.suggested_path,
          reason: decideResult.reason,
        },
      );
    }

    const { decision } = decideResult;

    // -----------------------------------------------------------------------
    // Step 4: For path A (new file), reserve placeholder before sending.
    // This prevents TOCTOU: another process cannot claim the name between
    // decideWrite and InDesign's write. InDesign will overwrite the 0-byte
    // placeholder with the actual INDD content.
    // -----------------------------------------------------------------------
    let reservedInode: number | undefined;
    if (decision.savePath === "A") {
      const reserved = reservePlaceholder(decision.finalPath);
      if (!reserved.ok) {
        return fail("io_error", reserved.message, { reason: reserved.reason });
      }
      reservedInode = reserved.fingerprint.ino;

      // -----------------------------------------------------------------------
      // Step 5a: Send write script (path A)
      // -----------------------------------------------------------------------
      // sendFn is typed as SendFn<Envelope<ScriptResult>> to match what
      // runScriptWithResultFile actually returns at runtime (Promise<Envelope<T>>).
      // sendWriteScript<Envelope<ScriptResult>> stores the Envelope as result: R,
      // so sendResult.result is already Envelope<ScriptResult> — return it directly.
      // `dispatched` records whether the script was handed to the transport at all. If it was
      // not, nothing can have been written; if it was, the outcome is only known when the
      // failure envelope proves it (see envelopeProvesNoWrite).
      let dispatched = false;
      const sendFn: SendFn<Envelope<ScriptResult>> = (opts) => {
        dispatched = true;
        return runScriptWithResultFile<ScriptResult>({
          language: "JavaScript",
          scriptTemplate: opts.scriptTemplate,
          resultSchema: ScriptResultSchema,
        });
      };

      let sendResult: Awaited<ReturnType<typeof sendWriteScript<Envelope<ScriptResult>>>>;
      try {
        sendResult = await sendWriteScript(
          decision,
          {
            tool: "save_document",
            documentId,
            finalPath: decision.finalPath,
            operation,
            reservedFingerprint: reserved.fingerprint,
            scriptOpts: {
              bodyFn: () =>
                buildSaveScript(documentId, decision.finalPath, {
                  mode: "A",
                  expectedFullName: fullName,
                }),
            },
          },
          sendFn,
          (body, cap, op) => wrapExtendScript(body, { _writeCapability: cap, operation: op }),
        );
      } catch (err: unknown) {
        // sendWriteScript threw. If the transport was never called (e.g. operation_body_mismatch)
        // nothing was sent and the registry was not touched: remove our placeholder (same inode,
        // still empty). If it was called, the outcome is unknown: leave the placeholder.
        if (!dispatched) {
          const outcome = cleanUpPlaceholder(decision.finalPath, reservedInode);
          return fail("write_not_authorized", withNote((err as Error).message, cleanupNote(outcome, decision.finalPath)));
        }
        return fail("write_not_authorized", `${(err as Error).message}. ${unknownOutcomeHint(decision.finalPath)}`);
      }

      if (!sendResult.ok) {
        // Refused by the guard before dispatch (transport never called): safe to clean up, and
        // cleanupPlaceholder removes only the same empty inode. If the script was dispatched and
        // the send then failed (transport threw), the outcome is unknown: leave the placeholder.
        if (!dispatched) {
          const outcome = cleanUpPlaceholder(decision.finalPath, reservedInode);
          return fail("io_error", withNote(sendResult.message, cleanupNote(outcome, decision.finalPath)), {
            reason: sendResult.reason as never,
          });
        }
        return fail("io_error", `${sendResult.message}. ${unknownOutcomeHint(decision.finalPath)}`, {
          reason: sendResult.reason as never,
        });
      }

      // sendResult.result is Envelope<ScriptResult> from the transport layer.
      // If the transport itself failed (script error, timeout, etc.), propagate it.
      // Otherwise extract the inner ScriptResult and wrap in a single ok() envelope
      // to produce the expected MCP contract: { ok: true, result: { path } }.
      if (!sendResult.result.ok) {
        const failure = sendResult.result.error;
        if (envelopeProvesNoWrite(failure)) {
          // The script never reached doc.save: remove our placeholder and say so if it stays behind.
          const note = cleanupNote(cleanUpPlaceholder(decision.finalPath, reservedInode), decision.finalPath);
          if (note === undefined) return sendResult.result;
          return { ok: false, error: { ...failure, message: withNote(failure.message, note) } };
        }
        // Unknown outcome (timeout, script error, unreadable result, ...): InDesign may have written
        // the file or may still do so. Keep the placeholder: the path stays blocked (the registry
        // record is uncertain) until it is dealt with manually.
        return {
          ok: false,
          error: { ...failure, message: `${failure.message}. ${unknownOutcomeHint(decision.finalPath)}` },
        };
      }
      return ok(sendResult.result.result!);
    }

    // -----------------------------------------------------------------------
    // Step 5b: Send write script (path B — owned file, in-place or save-as)
    // No placeholder needed; assertWriteAllowed verifies the fingerprint.
    // -----------------------------------------------------------------------
    const sendFn: SendFn<Envelope<ScriptResult>> = (opts) =>
      runScriptWithResultFile<ScriptResult>({
        language: "JavaScript",
        scriptTemplate: opts.scriptTemplate,
        resultSchema: ScriptResultSchema,
      });

    let sendResult: Awaited<ReturnType<typeof sendWriteScript<Envelope<ScriptResult>>>>;
    try {
      sendResult = await sendWriteScript(
        decision,
        {
          tool: "save_document",
          documentId,
          finalPath: decision.finalPath,
          operation,
          scriptOpts: {
            bodyFn: () => {
              const expectedSize = decision.expectedFingerprint?.size;
              if (expectedSize === undefined) {
                throw new Error("path-B decision carries no fingerprint");
              }
              return buildSaveScript(documentId, decision.finalPath, {
                mode: "B",
                expectedFullName: fullName,
                expectedSize,
              });
            },
          },
        },
        sendFn,
        (body, cap, op) => wrapExtendScript(body, { _writeCapability: cap, operation: op }),
      );
    } catch (err: unknown) {
      // sendWriteScript threw before dispatching (e.g. operation_body_mismatch).
      // Nothing was sent and the registry was not touched: report a normal error.
      return fail("write_not_authorized", (err as Error).message);
    }

    if (!sendResult.ok) {
      return fail(
        sendResult.kind === "write_not_authorized"
          ? "write_not_authorized"
          : "io_error",
        sendResult.message,
        { reason: sendResult.reason as never },
      );
    }

    // sendResult.result is Envelope<ScriptResult> from the transport layer.
    // Propagate transport failures; otherwise extract and re-wrap as single envelope.
    if (!sendResult.result.ok) {
      return sendResult.result;
    }
    return ok(sendResult.result.result!);
  },
});

/**
 * Longest a save_document call waits for earlier save_document calls to finish. This limits
 * WAITING only; a running save is bounded by the transport timeouts, not by this value.
 */
export const SAVE_LOCK_WAIT_MS = 90_000;

// Concurrent MCP requests are processed in parallel, and every save_document step (query,
// decision, send, registry update) must see the result of the previous call. All
// save_document calls therefore run one at a time, in arrival order.
const saveMutex = new WriteMutex();

export const saveDocumentTool = defineTool<Input, { path: string }>({
  ...saveDocumentUnlocked, // name, description and inputSchema stay exactly as defined above
  async handler(input) {
    const run = await saveMutex.runExclusive(() => saveDocumentUnlocked.handler(input), SAVE_LOCK_WAIT_MS);
    if (!run.acquired) {
      // Nothing was started: no query, no decision, no registry change.
      return fail(
        "timeout",
        `another save_document call is still running; this call waited ${SAVE_LOCK_WAIT_MS / 1000} seconds and was not started`,
      );
    }
    return run.value;
  },
});
