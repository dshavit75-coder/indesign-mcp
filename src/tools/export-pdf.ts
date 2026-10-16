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
// Architectural limitation note (§ B8 Stage 4, hardened later)
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
// What this tool does:
//   1. partPath has a unique random name (128 bits) and is checked to be absent
//      before the export is sent (fail-closed).  A pre-existing file there is a
//      sign of a prior crashed export; we refuse rather than inherit it.
//   2. finalPath is never overwritten: fs.link(partPath, finalPath) fails with
//      EEXIST if finalPath already exists (guaranteed by the kernel).
//   3. This tool's OWN code never removes the temporary file, on success,
//      failure or timeout.  It cannot prove that it owns the file (InDesign
//      replaces it, so the inode seen by the pre-check says nothing), and after
//      a timeout the export may still be running.  It only REPORTS what it
//      observes at that path.  The only removal in this execution path is
//      publishPdfPart's removal of the temporary NAME after a successful link
//      (write-guard.ts:805-809): done by path, without inode verification,
//      unchanged by this file and outside its scope.
//   4. A temporary file that is absent, not a regular file or EMPTY is never
//      published.  NOT validated: that a non-empty file is a valid PDF (a
//      `%PDF-` check is out of scope).
//
// What we CANNOT guarantee:
//   - A process that creates a file at partPath AFTER our pre-check but BEFORE
//     InDesign writes would have it replaced by InDesign (not a realistic
//     threat given the unique prefix).
//   - The partPath inode after InDesign writes cannot be tied to the pre-check.
//   - A swap of the temporary file between our inspection and publishPdfPart's
//     own link is not detectable.
//   - Whether an export that timed out is still writing is UNVERIFIED (no real
//     InDesign run).
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
// Observation helpers.  They only LOOK at paths: this file never removes one.
// ---------------------------------------------------------------------------

type PathState =
  | { kind: "absent" }
  | { kind: "regular"; size: number }
  | { kind: "other" }
  | { kind: "unreadable"; message: string };

function inspectPath(path: string): PathState {
  try {
    const st = lstatSync(path);
    return st.isFile() ? { kind: "regular", size: st.size } : { kind: "other" };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    // Any error other than ENOENT is "could not look", never "it is not there".
    return e.code === "ENOENT" ? { kind: "absent" } : { kind: "unreadable", message: e.message };
  }
}

/**
 * The temporary path as OBSERVED now; undefined = nothing there.
 * "failure": nothing in this call removed it.  "after_publish": says nothing about a clean-up,
 * because this code does not know whether publishPdfPart attempted or achieved one.
 */
function partNote(partPath: string, phase: "failure" | "after_publish"): string | undefined {
  const s = inspectPath(partPath);
  if (s.kind === "absent") return undefined;
  const tail = phase === "failure" ? "; it was not removed" : "";
  if (s.kind === "regular") {
    return `A file is present at the temporary path (${s.size} bytes)${tail}: ${partPath}. Check it before deleting it.`;
  }
  if (s.kind === "other") {
    return `Something that is not a regular file is present at the temporary path${tail}: ${partPath}.`;
  }
  return `The temporary path could not be inspected (${s.message}); its state is unknown: ${partPath}.`;
}

/** The final path as observed now.  Information only: it is not a cause of any failure. */
function targetNote(finalPath: string): string {
  const s = inspectPath(finalPath);
  if (s.kind === "absent") return `No file is present at ${finalPath} now.`;
  if (s.kind === "unreadable") return `The target ${finalPath} could not be inspected (${s.message}).`;
  return `A file is present at ${finalPath} now.`;
}

function withNote(message: string, note: string | undefined): string {
  return note === undefined ? message : `${message}. ${note}`;
}

// CONTRACT (text, not structured): the guard's refusals are plain `Error`s whose message starts with
// "write_not_authorized:" (write-capability.ts:50,54,57) or "operation_body_mismatch:" (write-guard.ts:591).
// There is no error class, `code` or `cause` for them (src has no custom Error type), so the prefix is the
// only signal available without editing write-guard.ts.  It is pinned by tests (write-capability.test.ts,
// save-document-real-guard.test.ts, and PX1a/PX1a2 here, which use the REAL guard).  An exception that
// does not match is rethrown unchanged.
const GUARD_REFUSAL = /^(write_not_authorized|operation_body_mismatch):/;

// CONTRACT (text, not structured): publishPdfPart returns reason "uncertain" for every failure and only
// its message differs.  It reports EEXIST on link with this prefix (write-guard.ts:800); every other link
// failure is "link failed: ..." (:802).  The classification depends on this wording until the guard returns
// a structured cause.  Pinned by PX12b/PX12c, which run the real publishPdfPart.  If the wording changes the
// failure is reported as io_error with the guard's full message (no false "created concurrently").
const GUARD_EEXIST = /^final PDF path was taken during export:/;

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
    // Step 5: Send export script (writes to partPath, NOT to finalPath)
    // -----------------------------------------------------------------------
    // `dispatched` is set as the first statement of sendFn.  It only tells an exception thrown BEFORE the
    // send began apart from one thrown after it began; it says nothing about whether the export ran or
    // wrote a file.  sendFn is typed as SendFn<Envelope<ScriptResult>> to match what
    // runScriptWithResultFile actually returns at runtime (Promise<Envelope<T>>).
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
          tool: "export_pdf",
          documentId,
          finalPath: decision.finalPath,
          operation: "export-pdf",
          scriptOpts: {
            bodyFn: () => buildExportScript(documentId, partPath),
          },
        },
        sendFn,
        (body, cap, op) => wrapExtendScript(body, { _writeCapability: cap, operation: op }),
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (dispatched) {
        return fail(
          "io_error",
          withNote(
            `${message}. The send to InDesign had already begun when this error occurred; ` +
              "whether the export ran or wrote a file is unknown",
            partNote(partPath, "failure"),
          ),
        );
      }
      // Before the send began.  Only the guard's own refusals are re-classified; anything else is
      // rethrown unchanged (server.ts reports it as script_error, as before).
      if (GUARD_REFUSAL.test(message)) return fail("write_not_authorized", message);
      throw err;
    }

    if (!sendResult.ok) {
      // The temporary file is only reported, never removed (see the note at the top of this file).
      return fail("io_error", withNote(sendResult.message, partNote(partPath, "failure")));
    }

    // -----------------------------------------------------------------------
    // Step 5b: Check transport Envelope — InDesign script may have failed
    // even though the write-guard layer (sendWriteScript) succeeded.
    // Propagate before attempting the atomic publish; kind and fields are kept.
    // -----------------------------------------------------------------------
    if (!sendResult.result.ok) {
      const env = sendResult.result;
      const note = partNote(partPath, "failure");
      return note === undefined
        ? env
        : { ok: false, error: { ...env.error, message: withNote(env.error.message, note) } };
    }

    // -----------------------------------------------------------------------
    // Step 5c: The temporary file must be a regular, non-empty file before it is published.
    // NOT validated: that it is a valid PDF (a `%PDF-` check is out of scope).
    // -----------------------------------------------------------------------
    const before = inspectPath(partPath);
    if (before.kind !== "regular") {
      const what =
        before.kind === "absent"
          ? "was not found when checked"
          : before.kind === "other"
            ? "is not a regular file"
            : `could not be inspected (${before.message}); its state is unknown`;
      return fail(
        "io_error",
        `InDesign reported success, but the temporary file ${what}: ${partPath}. ` +
          "Nothing was published; this call removed nothing.",
      );
    }
    if (before.size === 0) {
      return fail(
        "io_error",
        `InDesign reported success, but the temporary file is an empty file (0 bytes): ${partPath}. ` +
          "Nothing was published; this call removed nothing.",
      );
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
      // See GUARD_EEXIST: the guard's reason is always "uncertain"; only its message says more.
      // The observed state of the target is information, not a cause.
      const note = partNote(partPath, "failure");
      const target = targetNote(decision.finalPath);
      if (GUARD_EEXIST.test(publishResult.message)) {
        return fail(
          "pdf_replace_blocked",
          withNote(`${publishResult.message}. ${target}`, note),
          { existing_path: decision.finalPath },
        );
      }
      return fail("io_error", withNote(`Publishing failed: ${publishResult.message}. ${target}`, note));
    }

    // -----------------------------------------------------------------------
    // Step 7: Return success with final path and page count
    // -----------------------------------------------------------------------
    // sendResult.result is SuccessEnvelope<ScriptResult> here (checked above).
    // Extract page_count from the inner result; use decision.finalPath (not
    // partPath) as the canonical output path.  If something is still at the
    // temporary path, report what is observed (no claim about why).
    const leftover = partNote(partPath, "after_publish");
    return ok(
      { path: decision.finalPath, page_count: sendResult.result.result!.page_count },
      leftover === undefined ? {} : { warnings: [`Published. Observed after publishing: ${leftover}`] },
    );
  },
});
