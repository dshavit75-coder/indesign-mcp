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

function buildSaveScript(
  documentId: string,
  absolutePath: string | undefined,
): string {
  // Always target by documentId (result of pre-query), never app.activeDocument,
  // to avoid accidentally saving the wrong document if focus changed.
  const docExpr = `findDocumentById(${lit(documentId)})`;

  const saveCall =
    absolutePath !== undefined
      ? `doc.save(File(${lit(absolutePath)}));`
      : `
        if (!doc.saved) {
          throw { name: "io_error", message: "document has never been saved; provide a path to save-as" };
        }
        doc.save();
      `;

  return `
${prelude(findDocumentById)}
var doc = ${docExpr};
if (doc === null) {
  throw { name: "not_found", message: "document not found during save: " + ${lit(documentId)} };
}
${saveCall}
return { path: String(doc.fullName) };
`;
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
              bodyFn: () => buildSaveScript(documentId, decision.finalPath),
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

    const sendResult = await sendWriteScript(
      decision,
      {
        tool: "save_document",
        documentId,
        finalPath: decision.finalPath,
        operation,
        scriptOpts: {
          bodyFn: () => buildSaveScript(documentId, decision.finalPath),
        },
      },
      sendFn,
      (body, cap, op) => wrapExtendScript(body, { _writeCapability: cap, operation: op }),
    );

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
