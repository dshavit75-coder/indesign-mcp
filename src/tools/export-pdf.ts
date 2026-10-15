import { z } from "zod";
import { randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import { dirname } from "node:path";
import { resolveUserPath } from "../path-utils.js";
import { defineTool } from "./registry.js";
import { runScriptWithResultFile } from "../transport/result-file.js";
import { wrapExtendScript, lit, prelude } from "../compose.js";
import { findDocumentById } from "../script-helpers.js";
import { ok, fail } from "../errors.js";
import type { Envelope } from "../types.js";
import {
  decideWrite,
  sendWriteScript,
  publishPdfPart,
  type SendFn,
} from "../write-guard.js";

// ---------------------------------------------------------------------------
// Architectural limitation note (§ B8 Stage 4)
//
// The `.part` file (temporary PDF path) is assigned a unique name using a
// cryptographically random suffix with the `.indesign-mcp-` prefix that is
// blocked by pathGate.  This prevents collisions with user-supplied paths and
// with other sessions under normal operation.
//
// HOWEVER: InDesign's ExtendScript `doc.exportFile(... File(partPath) ...)`
// ultimately calls fopen(partPath, "w"), which overwrites any existing file at
// that path without respecting O_EXCL semantics.  There is no hook between
// Node.js and InDesign that would let us atomically claim the partPath before
// InDesign writes it.
//
// What we CAN guarantee:
//   1. partPath has a unique UUID-based name — practical collision probability
//      is negligible (128 bits of entropy in the same directory).
//   2. We pre-check that partPath does not already exist (fail-closed).
//      A pre-existing `.indesign-mcp-` file is a sign of a prior crashed
//      export; we refuse rather than silently inherit it.
//   3. finalPath is never overwritten: fs.link(partPath, finalPath) fails
//      with EEXIST if finalPath already exists (guaranteed by the kernel).
//   4. The partPath is cleaned up only after a successful fs.link — i.e. only
//      after we know the final file was published.  If fs.link fails or
//      sendWriteScript fails, we do NOT delete the partPath unless we can
//      verify via lstat that it has non-zero size (i.e. InDesign wrote to it).
//      If size is zero or the file is missing, we clean up.  If size > 0 and
//      the link failed (EEXIST race), we leave the partPath and report it.
//
// What we CANNOT guarantee:
//   - A malicious or malfunctioning process on the same machine that creates a
//     file at the partPath AFTER our pre-check but BEFORE InDesign writes would
//     have that file overwritten by InDesign.  This is not considered a
//     realistic threat given the unique prefix.
//   - The partPath inode after InDesign writes cannot be verified to match our
//     pre-check inode, because InDesign replaces the file (new inode) rather
//     than writing in-place.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Input / Output schemas
// ---------------------------------------------------------------------------

const InputSchema = z
  .object({
    path: z.string(),
    document_id: z.string().optional(),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

// Pre-query result schema (read-only InDesign call)
const PreQuerySchema = z.object({
  documentId: z.string(),
});
type PreQuery = z.infer<typeof PreQuerySchema>;

const ScriptResultSchema = z.object({
  path: z.string(),
  page_count: z.number().int().nonnegative(),
});
type ScriptResult = z.infer<typeof ScriptResultSchema>;

// ---------------------------------------------------------------------------
// Part-file name: unique per export, blocked prefix so pathGate rejects it
// if a user ever tried to use it as a finalPath.
// ---------------------------------------------------------------------------

function makePartPath(dir: string): string {
  const token = randomBytes(16).toString("hex");
  // Prefix `.indesign-mcp-` is blocked by pathGate rule 5 — no user-supplied
  // path can match this, so there is no confusion between part files and
  // legitimate output files.
  return dir + "/.indesign-mcp-" + token + ".pdf.part";
}

// ---------------------------------------------------------------------------
// Pre-query: read-only call to resolve documentId
// Does NOT use write-guard.
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
return { documentId: String(doc.id) };
`;
}

// ---------------------------------------------------------------------------
// Export script: writes PDF to partPath (NOT to finalPath directly)
// ---------------------------------------------------------------------------

function buildExportScript(documentId: string, partPath: string): string {
  return `
${prelude(findDocumentById)}
var doc = findDocumentById(${lit(documentId)});
if (doc === null) {
  throw { name: "not_found", message: "document not found during export: " + ${lit(documentId)} };
}
var preset = app.pdfExportPresets.itemByName(${lit("[High Quality Print]")});
doc.exportFile(ExportFormat.PDF_TYPE, File(${lit(partPath)}), false, preset);
return {
  path: ${lit(partPath)},
  page_count: doc.pages.length
};
`;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const exportPdfTool = defineTool<Input, { path: string; page_count: number }>({
  name: "export_pdf",
  description:
    "Exports an InDesign document to PDF using the [High Quality Print] preset. " +
    "Returns the absolute output path and exported page count. " +
    "Never overwrites an existing PDF; returns pdf_replace_blocked if the target path already exists. " +
    "The export is performed atomically: InDesign writes to a temporary file, " +
    "which is then hard-linked to the final path.",
  inputSchema: InputSchema,

  async handler(input) {
    // -----------------------------------------------------------------------
    // Step 1: Resolve and validate the final output path
    // -----------------------------------------------------------------------
    const absolutePath = resolveUserPath(input.path);
    const finalDir = dirname(absolutePath);

    // -----------------------------------------------------------------------
    // Step 2: Read-only pre-query — resolve documentId
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
    const { documentId } = preQueryEnvelope.result!;

    // -----------------------------------------------------------------------
    // Step 3: decideWrite — verifies finalPath is free
    // (PDF path: decideWrite refuses if finalPath already exists)
    // -----------------------------------------------------------------------
    const decideResult = await decideWrite({
      tool: "export_pdf",
      operation: "export-pdf",
      documentId,
      path: absolutePath,
      expectedExtension: ".pdf",
    });

    if (!decideResult.ok) {
      // Convert name_collision on a regular file to pdf_replace_blocked
      if (
        decideResult.kind === "name_collision" &&
        decideResult.existing_path !== undefined
      ) {
        return fail(
          "pdf_replace_blocked",
          `PDF already exists at ${decideResult.existing_path}. ` +
            "Provide a different output path.",
          {
            existing_path: decideResult.existing_path,
            suggested_path: decideResult.suggested_path,
            reason: decideResult.reason,
          },
        );
      }
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
    // Step 4: Create unique part-file path
    //
    // The part file lives in the same directory as the final PDF so that
    // fs.link (hard-link) can be used for atomic publish on the same
    // filesystem.  The name uses 128-bit random entropy with the
    // `.indesign-mcp-` prefix (blocked by pathGate) to prevent collisions.
    //
    // Pre-check: refuse if partPath already exists (fail-closed).
    // A pre-existing part file indicates a prior crashed export session.
    // We do NOT inherit it — the caller should investigate and remove it.
    //
    // LIMITATION: This pre-check is not atomic with InDesign's write.
    // A concurrent process could create partPath between this check and
    // InDesign's fopen.  Given the unique name, this is not a realistic
    // threat but is documented here for transparency.
    // -----------------------------------------------------------------------
    const partPath = makePartPath(finalDir);

    try {
      lstatSync(partPath);
      // If lstat succeeds, the file already exists — refuse.
      return fail(
        "io_error",
        `Unexpected: temporary part file already exists: ${partPath}. ` +
          "This indicates a prior crashed export. Investigate and remove it manually.",
      );
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") {
        return fail(
          "io_error",
          `Cannot verify part file path: ${e.message}`,
        );
      }
      // ENOENT expected — partPath is free, proceed
    }

    // -----------------------------------------------------------------------
    // Step 5: Send export script (writes to partPath, NOT finalPath)
    // -----------------------------------------------------------------------
    // sendFn is typed as SendFn<Envelope<ScriptResult>> to match what
    // runScriptWithResultFile actually returns at runtime (Promise<Envelope<T>>).
    const sendFn: SendFn<Envelope<ScriptResult>> = (opts) =>
      runScriptWithResultFile<ScriptResult>({
        language: "JavaScript",
        scriptTemplate: opts.scriptTemplate,
        resultSchema: ScriptResultSchema,
      });

    const sendResult = await sendWriteScript(
      decision,
      {
        tool: "export_pdf",
        documentId,
        finalPath: decision.finalPath,
        operation: "export-pdf",
        scriptOpts: {
          scriptTemplate: wrapExtendScript(
            buildExportScript(documentId, partPath),
          ),
        },
      },
      sendFn,
    );

    if (!sendResult.ok) {
      // sendWriteScript failed. Attempt cleanup of partPath only if we can
      // verify it is a zero-byte file (placeholder state — InDesign did not
      // write to it).  If it has content (InDesign wrote but something else
      // failed), leave it and report.
      try {
        const st = lstatSync(partPath);
        if (st.isFile() && st.size === 0) {
          // Safe to remove: InDesign did not write anything useful
          const { unlink } = await import("node:fs/promises");
          await unlink(partPath).catch(() => { /* best effort */ });
        } else if (st.isFile() && st.size > 0) {
          // InDesign wrote content but send failed for another reason.
          // Do NOT delete — content may be valuable for debugging.
          return fail(
            "io_error",
            `${sendResult.message}. ` +
              `Temporary part file with content was left at: ${partPath}`,
          );
        }
      } catch {
        // partPath does not exist or is inaccessible — nothing to clean up
      }
      return fail("io_error", sendResult.message);
    }

    // -----------------------------------------------------------------------
    // Step 5b: Check transport Envelope — InDesign script may have failed
    // even though the write-guard layer (sendWriteScript) succeeded.
    // Propagate before attempting the atomic publish.
    // -----------------------------------------------------------------------
    if (!sendResult.result.ok) {
      // InDesign script failed (script_error, timeout, not_found, etc.).
      // partPath was never written (or is zero-byte). Attempt cleanup.
      try {
        const st = lstatSync(partPath);
        if (st.isFile() && st.size === 0) {
          const { unlink } = await import("node:fs/promises");
          await unlink(partPath).catch(() => { /* best effort */ });
        }
      } catch {
        // partPath absent — nothing to clean up
      }
      return sendResult.result;
    }

    // -----------------------------------------------------------------------
    // Step 6: Atomic publish — fs.link(partPath, finalPath)
    // Fails with EEXIST if finalPath was created concurrently.
    // -----------------------------------------------------------------------
    const publishResult = await publishPdfPart({
      partPath,
      finalPath: decision.finalPath,
      registryKey: decision.registryKey,
      tool: "export_pdf",
      documentId,
    });

    if (!publishResult.ok) {
      // fs.link failed. Determine whether to clean up partPath.
      try {
        const st = lstatSync(partPath);
        if (st.isFile() && st.size > 0) {
          // partPath has content and publish failed (likely EEXIST race).
          // Leave the part file so the caller can inspect or retry.
          return fail(
            "pdf_replace_blocked",
            `PDF target already exists (created concurrently): ${decision.finalPath}. ` +
              `Temporary part file was left at: ${partPath}`,
            { existing_path: decision.finalPath },
          );
        }
      } catch {
        // partPath gone — nothing to report
      }
      return fail("io_error", publishResult.message);
    }

    // -----------------------------------------------------------------------
    // Step 7: Return success with final path and page count
    // -----------------------------------------------------------------------
    // sendResult.result is SuccessEnvelope<ScriptResult> here (checked above).
    // Extract page_count from the inner result; use decision.finalPath (not
    // partPath) as the canonical output path.
    return ok({ path: decision.finalPath, page_count: sendResult.result.result!.page_count });
  },
});
