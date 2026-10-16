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
  type Fingerprint,
  type SendFn,
  type WriteDecision,
} from "../write-guard.js";
import { lstatSync } from "node:fs";

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
// Pre-query: read-only call to resolve documentId and fullName
// This does NOT use write-guard because it is read-only.
// ---------------------------------------------------------------------------

function buildPreQueryScript(inputDocumentId: string | undefined): string {
  const docExpr =
    inputDocumentId !== undefined
      ? `findDocumentById(${lit(inputDocumentId)})`
      : "app.activeDocument";

  return `
${prelude(findDocumentById)}
if (app.documents.length === 0) {
  throw { name: "not_found", message: "no open document" };
}
var doc = ${docExpr};
if (doc === null) {
  throw { name: "not_found", message: "document not found: " + ${inputDocumentId !== undefined ? lit(inputDocumentId) : '""'} };
}
return { documentId: String(doc.id), fullName: String(doc.fullName) };
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
  throw { name: "name_collision", message: "target is not the empty reserved placeholder: " + ${lit(absolutePath)} };
}`
      : `if (!__target.exists || __target.length !== ${checks.expectedSize}) {
  throw { name: "name_collision", message: "target file is missing or changed size: " + ${lit(absolutePath)} };
}`;

  return `
${prelude(findDocumentById)}
var doc = ${docExpr};
if (doc === null) {
  throw { name: "not_found", message: "document not found during save: " + ${lit(documentId)} };
}
var __fullName = "";
try { __fullName = String(doc.fullName); } catch (e) { __fullName = ""; }
if (__fullName !== ${lit(checks.expectedFullName)}) {
  throw { name: "io_error", message: "document changed between query and save: expected fullName " + ${lit(checks.expectedFullName)} + ", found " + __fullName };
}
var __target = File(${lit(absolutePath)});
${targetCheck}
doc.save(File(${lit(absolutePath)}));
return { path: String(doc.fullName) };
`;
}

const ZERO_FINGERPRINT: Fingerprint = { dev: 0, ino: 0, size: 0, mtimeMs: 0, ctimeMs: 0 };

/**
 * The transport can answer with an ok:false envelope instead of throwing, and
 * sendWriteScript (unchanged) then records the path as "owned" because it only
 * sees that the send did not throw. A failed save must not leave ownership
 * behind: mark the record "uncertain", keeping the fingerprint the decision was
 * verified against (path B) or a zero fingerprint (path A). Never refreshed.
 */
function markUncertainAfterFailedSave(decision: WriteDecision, documentId: string): void {
  registrySet(decision.registryKey, {
    state: "uncertain",
    documentId,
    tool: "save_document",
    fingerprint: decision.expectedFingerprint ?? ZERO_FINGERPRINT,
  });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const saveDocumentTool = defineTool<Input, { path: string }>({
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
      // In-place save: use the document's current fullName
      //
      // Assumption ט.1: doc.fullName returns "" (empty string) for an
      // unsaved/Untitled document. Per fail-closed rule: refuse if fullName is
      // empty or non-absolute.
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
        // sendWriteScript threw before dispatching (e.g. operation_body_mismatch).
        // Nothing was sent and the registry was not touched: remove our
        // placeholder (same inode, still empty) and report a normal error.
        cleanupPlaceholder(decision.finalPath, reservedInode);
        return fail("write_not_authorized", (err as Error).message);
      }

      if (!sendResult.ok) {
        // Clean up placeholder only if it is still the same 0-byte inode.
        cleanupPlaceholder(decision.finalPath, reservedInode);
        return fail("io_error", sendResult.message, {
          reason: sendResult.reason as never,
        });
      }

      // sendResult.result is Envelope<ScriptResult> from the transport layer.
      // If the transport itself failed (script error, timeout, etc.), propagate it.
      // Otherwise extract the inner ScriptResult and wrap in a single ok() envelope
      // to produce the expected MCP contract: { ok: true, result: { path } }.
      if (!sendResult.result.ok) {
        markUncertainAfterFailedSave(decision, documentId);
        cleanupPlaceholder(decision.finalPath, reservedInode);
        return sendResult.result;
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
      markUncertainAfterFailedSave(decision, documentId);
      return sendResult.result;
    }
    return ok(sendResult.result.result!);
  },
});
