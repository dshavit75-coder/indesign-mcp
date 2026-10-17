/**
 * B8 Write Guard — path gate, name computation, ownership registry,
 * decision objects, and the single send path for write scripts.
 *
 * This module is the ONLY place in src/ that:
 *   - decides whether a write is allowed (decideWrite)
 *   - verifies the decision before sending (assertWriteAllowed)
 *   - sends a write script to InDesign (sendWriteScript)
 *
 * It does NOT import runScriptWithResultFile or compose directly.
 * Those are injected at call sites via the sendFn parameter.
 *
 * Design doc: docs/superpowers/specs/2026-10-13-indesign-mcp-plan-b8-safety-design.md §2–§3
 */

import { homedir } from "node:os";
import { lstatSync, openSync, closeSync, statSync, realpathSync, unlinkSync, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, basename, extname } from "node:path";
import type { DocumentId, WriteRefusalReason } from "./types.js";
import { issueWriteCapability } from "./write-capability.js";

// ---------------------------------------------------------------------------
// 1. Branded type — compile-time protection only
// ---------------------------------------------------------------------------

/** Compile-time brand. Erased at runtime — never use as runtime proof. */
declare const WRITE_ALLOWED_BRAND: unique symbol;
export type WriteAllowed = { readonly [WRITE_ALLOWED_BRAND]: true };

// ---------------------------------------------------------------------------
// 2. Filesystem fingerprint
// ---------------------------------------------------------------------------

export interface Fingerprint {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

function fingerprintFromStat(st: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): Fingerprint {
  return { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs };
}

function fingerprintEqual(a: Fingerprint, b: Fingerprint): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

// ---------------------------------------------------------------------------
// 3. Ownership registry
// ---------------------------------------------------------------------------

export type RegistryState = "owned" | "pending" | "uncertain";

export interface RegistryRecord {
  state: RegistryState;
  documentId: DocumentId;
  tool: string;
  fingerprint: Fingerprint;
}

// Registry key = realpath(directory) + "/" + NFC(file name)
const registry = new Map<string, RegistryRecord>();

function registryKey(directory: string, fileName: string): string {
  return directory + "/" + fileName.normalize("NFC");
}

export function registryGet(key: string): RegistryRecord | undefined {
  return registry.get(key);
}

export function registrySet(key: string, record: RegistryRecord): void {
  registry.set(key, record);
}

/** Reset the registry — used only in tests (module-level reset). */
export function registryReset(): void {
  registry.clear();
}

// ---------------------------------------------------------------------------
// 4. Path gate — spec §2 "Path normalization — exact specification"
// ---------------------------------------------------------------------------

export type PathGateResult =
  | { ok: true; finalPath: string; registryKey: string; lstatResult: "missing" | "regular" }
  | { ok: false; reason: WriteRefusalReason; message: string };

/**
 * Validate and normalize an absolute or ~/... path for save (.indd) or export (.pdf).
 * Implements all 9 rules from spec §2 "Path normalization — exact specification".
 */
export function pathGate(
  input: string,
  expectedExtension: ".indd" | ".pdf"
): PathGateResult {
  // Rule 1: non-empty, no null byte, at most 1024 UTF-8 bytes
  if (!input || input.includes("\0")) {
    return { ok: false, reason: "path_not_absolute", message: "path must be non-empty and must not contain a null byte" };
  }
  if (Buffer.byteLength(input, "utf8") > 1024) {
    return { ok: false, reason: "path_not_absolute", message: "path is too long (> 1024 UTF-8 bytes)" };
  }

  // Rule 2: must start with / or ~/
  if (!input.startsWith("/") && !input.startsWith("~/")) {
    return { ok: false, reason: "path_not_absolute", message: `path must be absolute (start with / or ~/): ${JSON.stringify(input)}` };
  }

  // Rule 3: ~/ expansion
  let expanded = input;
  if (input.startsWith("~/")) {
    const home = homedir();
    if (!home || !home.startsWith("/")) {
      return { ok: false, reason: "uncertain", message: "could not determine home directory" };
    }
    expanded = home + "/" + input.slice(2);
  }

  // Rule 4: split on /; reject empty segments (.., ., trailing /)
  const segments = expanded.split("/");
  // segments[0] is "" (absolute path starts with /)
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === "" || seg === "." || seg === "..") {
      return {
        ok: false,
        reason: "path_not_absolute",
        message: `path must not contain empty segments, '.', or '..': ${JSON.stringify(input)}`
      };
    }
  }

  // Rule 5: file name (last segment)
  const fileName = segments[segments.length - 1];
  if (!fileName) {
    return { ok: false, reason: "path_not_absolute", message: "path must not end with /" };
  }
  if (Buffer.byteLength(fileName, "utf8") > 255) {
    return { ok: false, reason: "path_not_absolute", message: "file name exceeds 255 UTF-8 bytes" };
  }
  if (fileName.startsWith(".indesign-mcp-")) {
    return { ok: false, reason: "path_not_absolute", message: "file names starting with .indesign-mcp- are reserved" };
  }
  const ext = extname(fileName).toLowerCase();
  if (ext !== expectedExtension) {
    return { ok: false, reason: "wrong_extension", message: `expected ${expectedExtension} extension, got ${JSON.stringify(ext)}` };
  }

  // Rule 6: parent directory — realpath(dirname) must succeed and be a directory
  const parentInput = expanded.slice(0, expanded.lastIndexOf("/")) || "/";
  let realParent: string;
  try {
    realParent = realpathSync(parentInput);
  } catch {
    return { ok: false, reason: "parent_missing", message: `parent directory not found: ${JSON.stringify(parentInput)}` };
  }
  try {
    const parentStat = statSync(realParent);
    if (!parentStat.isDirectory()) {
      return { ok: false, reason: "parent_missing", message: `parent path is not a directory: ${JSON.stringify(realParent)}` };
    }
  } catch {
    return { ok: false, reason: "parent_missing", message: `parent directory not accessible: ${JSON.stringify(realParent)}` };
  }

  // Rule 7: final path = realParent + "/" + file name as given
  const finalPath = realParent + "/" + fileName;

  // Registry key = same directory + "/" + NFC(file name)
  const key = registryKey(realParent, fileName);

  // Rule 8: lstat the final path
  let lstatResult: "missing" | "regular";
  try {
    const st = lstatSync(finalPath);
    if (st.isSymbolicLink()) {
      return { ok: false, reason: "symlink_target", message: `path is a symlink: ${JSON.stringify(finalPath)}` };
    }
    if (!st.isFile()) {
      return { ok: false, reason: "not_regular_file", message: `path exists but is not a regular file: ${JSON.stringify(finalPath)}` };
    }
    lstatResult = "regular";
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      lstatResult = "missing";
    } else {
      return { ok: false, reason: "uncertain", message: `lstat error: ${e.message}` };
    }
  }

  return { ok: true, finalPath, registryKey: key, lstatResult };
}

// ---------------------------------------------------------------------------
// 5. Name computation — spec §2 "Name computation — exact specification"
//    Pure function: no I/O, no side effects. lstat calls are passed in.
// ---------------------------------------------------------------------------

export interface ComputeNameInput {
  kind: "new" | "working-copy" | "snapshot" | "pdf-export";
  /** For "new": base name without extension, no path separator */
  baseName?: string;
  /** For "new": target directory (absolute, already realpathed) */
  targetDir?: string;
  /** For "working-copy": source file path (existing .indd, validated externally) */
  sourcePath?: string;
  /** For "snapshot" and "pdf-export": current working file path (_cod.indd or _cod_vN.indd) */
  workingPath?: string;
  /** lstat function — injected so the function stays pure / testable */
  lstat: (p: string) => { exists: boolean };
}

export type ComputeNameResult =
  | { ok: true; path: string; warnings?: ["name_truncated"] }
  | { ok: false; reason: "version_limit_reached" | "invalid_input"; message: string };

/** Strip trailing _cod suffix from a stem (idempotence rule). */
function stripCod(stem: string): string {
  return stem.endsWith("_cod") ? stem.slice(0, -4) : stem;
}

/** Apply _cod suffix (idempotent: strip existing _cod before appending). */
function applyCod(stem: string): string {
  return stripCod(stem) + "_cod";
}

/** Truncate a string so that adding the ext keeps total byte count <= 255. */
function truncateToFit(base: string, ext: string): { result: string; truncated: boolean } {
  const extBytes = Buffer.byteLength(ext, "utf8");
  const maxBaseBytes = 255 - extBytes;
  if (maxBaseBytes <= 0) throw new Error("extension itself exceeds 255 bytes");
  const baseBytes = Buffer.byteLength(base, "utf8");
  if (baseBytes <= maxBaseBytes) return { result: base, truncated: false };
  // Truncate at code-point boundary
  let b = 0;
  let i = 0;
  while (i < base.length) {
    const cp = base.codePointAt(i)!;
    const cpBytes = cp > 0xFFFF ? 4 : cp > 0x7FF ? 3 : cp > 0x7F ? 2 : 1;
    if (b + cpBytes > maxBaseBytes) break;
    b += cpBytes;
    i += cp > 0xFFFF ? 2 : 1;
  }
  return { result: base.slice(0, i), truncated: true };
}

export function computeAgentName(input: ComputeNameInput): ComputeNameResult {
  switch (input.kind) {
    case "new": {
      const { baseName, targetDir } = input;
      if (!baseName || !targetDir) {
        return { ok: false, reason: "invalid_input", message: "baseName and targetDir required for kind=new" };
      }
      const stem = applyCod(baseName);
      const { result: finalStem, truncated } = truncateToFit(stem, ".indd");
      const fileName = finalStem + ".indd";
      const path = targetDir + "/" + fileName;
      return {
        ok: true,
        path,
        ...(truncated ? { warnings: ["name_truncated"] as ["name_truncated"] } : {}),
      };
    }

    case "working-copy": {
      const { sourcePath } = input;
      if (!sourcePath) {
        return { ok: false, reason: "invalid_input", message: "sourcePath required for kind=working-copy" };
      }
      const dir = dirname(sourcePath);
      const fileNameNoExt = basename(sourcePath, ".indd");
      const stem = applyCod(fileNameNoExt);
      const { result: finalStem, truncated } = truncateToFit(stem, ".indd");
      const fileName = finalStem + ".indd";
      const path = dir + "/" + fileName;
      return {
        ok: true,
        path,
        ...(truncated ? { warnings: ["name_truncated"] as ["name_truncated"] } : {}),
      };
    }

    case "snapshot": {
      const { workingPath, lstat: lstatFn } = input;
      if (!workingPath) {
        return { ok: false, reason: "invalid_input", message: "workingPath required for kind=snapshot" };
      }
      const dir = dirname(workingPath);
      const fileNameNoExt = basename(workingPath, ".indd");
      const base = fileNameNoExt.endsWith("_cod") ? fileNameNoExt.slice(0, -4) : fileNameNoExt;
      for (let n = 1; n <= 99; n++) {
        const candidate = `${base}_cod_v${n}.indd`;
        const candidatePath = dir + "/" + candidate;
        if (!lstatFn(candidatePath).exists) {
          return { ok: true, path: candidatePath };
        }
      }
      return { ok: false, reason: "version_limit_reached", message: "all versions v1–v99 already exist" };
    }

    case "pdf-export": {
      const { workingPath } = input;
      if (!workingPath) {
        return { ok: false, reason: "invalid_input", message: "workingPath required for kind=pdf-export" };
      }
      const dir = dirname(workingPath);
      const fileNameNoExt = basename(workingPath, ".indd");
      const pdfName = fileNameNoExt + ".pdf";
      const path = dir + "/" + pdfName;
      return { ok: true, path };
    }

    default:
      return { ok: false, reason: "invalid_input", message: "unknown kind" };
  }
}

// ---------------------------------------------------------------------------
// 6. Decision objects and WeakSet registry
// ---------------------------------------------------------------------------

export type WriteOperation = "save-as" | "in-place-save" | "export-pdf";

export interface WriteDecision {
  readonly tool: string;
  readonly operation: WriteOperation;
  readonly documentId: DocumentId;
  readonly finalPath: string;
  readonly registryKey: string;
  readonly savePath: "A" | "B" | "pdf";
  /** Path A: placeholder inode/fingerprint. Path B: full fingerprint. PDF: undefined. */
  readonly expectedFingerprint?: Fingerprint;
}

// The private WeakSet that marks authentic decisions.
const authorizedDecisions = new WeakSet<object>();
// Track used decisions (single-use)
const usedDecisions = new WeakSet<object>();

export type DecideWriteResult =
  | { ok: true; decision: WriteAllowed & WriteDecision }
  | { ok: false; kind: "name_collision" | "io_error" | "invalid_args"; reason: WriteRefusalReason; message: string; existing_path?: string; suggested_path?: string };

/**
 * Produce a frozen, WeakSet-registered WriteAllowed decision.
 * Returns a refusal if the path gate or registry check fails.
 */
export async function decideWrite(opts: {
  tool: string;
  operation: WriteOperation;
  documentId: DocumentId;
  path: string;
  expectedExtension: ".indd" | ".pdf";
}): Promise<DecideWriteResult> {
  const gate = pathGate(opts.path, opts.expectedExtension);
  if (!gate.ok) {
    const kind = gate.reason === "path_not_absolute" || gate.reason === "wrong_extension"
      ? "invalid_args" as const
      : gate.reason === "parent_missing"
        ? "io_error" as const
        : "name_collision" as const;
    return { ok: false, kind, reason: gate.reason, message: gate.message };
  }

  const { finalPath, registryKey: key, lstatResult } = gate;

  // PDF: never allow overwriting any existing file
  if (opts.expectedExtension === ".pdf") {
    if (lstatResult === "regular") {
      const suggested = await computeSuggestedNameIndd(finalPath);
      return {
        ok: false,
        kind: "name_collision",
        reason: "not_owned",
        message: `PDF file already exists and cannot be replaced: ${JSON.stringify(finalPath)}`,
        existing_path: finalPath,
        suggested_path: suggested,
      };
    }
    const decision: WriteDecision = Object.freeze({
      tool: opts.tool,
      operation: opts.operation,
      documentId: opts.documentId,
      finalPath,
      registryKey: key,
      savePath: "pdf" as const,
    });
    authorizedDecisions.add(decision);
    return { ok: true, decision: decision as WriteAllowed & WriteDecision };
  }

  // INDD: check registry
  if (lstatResult === "missing") {
    // Path A: free name
    const decision: WriteDecision = Object.freeze({
      tool: opts.tool,
      operation: opts.operation,
      documentId: opts.documentId,
      finalPath,
      registryKey: key,
      savePath: "A" as const,
    });
    authorizedDecisions.add(decision);
    return { ok: true, decision: decision as WriteAllowed & WriteDecision };
  }

  // File exists — check registry
  const record = registry.get(key);
  if (
    record &&
    record.state === "owned" &&
    record.tool === opts.tool &&
    record.documentId === opts.documentId
  ) {
    // Path B: verify current fingerprint
    let currentStat: ReturnType<typeof lstatSync>;
    try {
      currentStat = lstatSync(finalPath);
    } catch (err: unknown) {
      return { ok: false, kind: "name_collision", reason: "uncertain", message: `could not stat owned file: ${(err as Error).message}`, existing_path: finalPath };
    }
    if (!currentStat.isFile()) {
      return { ok: false, kind: "name_collision", reason: "fingerprint_mismatch", message: "file is no longer a regular file", existing_path: finalPath };
    }
    const currentFp = fingerprintFromStat(currentStat);
    if (!fingerprintEqual(currentFp, record.fingerprint)) {
      const suggested = await computeSuggestedNameIndd(finalPath);
      return {
        ok: false,
        kind: "name_collision",
        reason: "fingerprint_mismatch",
        message: `file was changed outside the server: ${JSON.stringify(finalPath)}`,
        existing_path: finalPath,
        suggested_path: suggested,
      };
    }
    const decision: WriteDecision = Object.freeze({
      tool: opts.tool,
      operation: opts.operation,
      documentId: opts.documentId,
      finalPath,
      registryKey: key,
      savePath: "B" as const,
      expectedFingerprint: currentFp,
    });
    authorizedDecisions.add(decision);
    return { ok: true, decision: decision as WriteAllowed & WriteDecision };
  }

  // Path C — not owned or stale record
  let reason: WriteRefusalReason;
  let message: string;
  if (!record) {
    reason = "not_owned";
    message = `file exists but was not created by this server session: ${JSON.stringify(finalPath)}`;
  } else if (record.state === "pending" || record.state === "uncertain") {
    reason = "uncertain";
    message = `write outcome for this file is uncertain: ${JSON.stringify(finalPath)}`;
  } else if (record.tool !== opts.tool || record.documentId !== opts.documentId) {
    reason = "document_mismatch";
    message = `file belongs to a different document or tool: ${JSON.stringify(finalPath)}`;
  } else {
    reason = "fingerprint_mismatch";
    message = `file fingerprint does not match: ${JSON.stringify(finalPath)}`;
  }
  const suggested = await computeSuggestedNameIndd(finalPath);
  return {
    ok: false,
    kind: "name_collision",
    reason,
    message,
    existing_path: finalPath,
    suggested_path: suggested,
  };
}

/** Compute the next free _cod_vN.indd name as a suggested path. */
async function computeSuggestedNameIndd(existingPath: string): Promise<string> {
  const dir = dirname(existingPath);
  const fileNameNoExt = basename(existingPath, ".indd");
  const base = fileNameNoExt.endsWith("_cod") ? fileNameNoExt.slice(0, -4) : fileNameNoExt;
  for (let n = 1; n <= 99; n++) {
    const candidate = `${base}_cod_v${n}.indd`;
    const candidatePath = dir + "/" + candidate;
    try {
      lstatSync(candidatePath);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return candidatePath;
    }
  }
  return dir + `/${base}_cod_v99.indd`;
}

// ---------------------------------------------------------------------------
// 7. assertWriteAllowed — runtime check before every send
// ---------------------------------------------------------------------------

export async function assertWriteAllowed(
  decision: WriteAllowed & WriteDecision,
  request: { tool: string; documentId: DocumentId; finalPath: string; operation: WriteOperation; reservedFingerprint?: Fingerprint }
): Promise<{ ok: true } | { ok: false; kind: "write_not_authorized" | "name_collision"; reason: string; message: string }> {
  // a) Must be in the WeakSet (not forged)
  if (!authorizedDecisions.has(decision as object)) {
    return { ok: false, kind: "write_not_authorized", reason: "write_not_authorized", message: "decision was not issued by this guard" };
  }
  // b) Single use
  if (usedDecisions.has(decision as object)) {
    return { ok: false, kind: "write_not_authorized", reason: "write_not_authorized", message: "decision has already been used" };
  }
  // c) Tool, documentId, finalPath, operation must match
  if (
    decision.tool !== request.tool ||
    decision.documentId !== request.documentId ||
    decision.finalPath !== request.finalPath ||
    decision.operation !== request.operation
  ) {
    return { ok: false, kind: "write_not_authorized", reason: "write_not_authorized", message: "decision fields do not match the request" };
  }

  // d) Fresh lstat check
  if (decision.savePath === "A") {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(decision.finalPath);
    } catch {
      return { ok: false, kind: "write_not_authorized", reason: "write_not_authorized", message: "path-A placeholder disappeared before send" };
    }
    if (!st.isFile() || st.size !== 0) {
      return { ok: false, kind: "write_not_authorized", reason: "write_not_authorized", message: "path-A placeholder was modified before send" };
    }
    const fpToCheck = request.reservedFingerprint ?? decision.expectedFingerprint;
    if (fpToCheck) {
      const fp = fingerprintFromStat(st);
      if (!fingerprintEqual(fp, fpToCheck)) {
        return { ok: false, kind: "write_not_authorized", reason: "write_not_authorized", message: "path-A placeholder inode changed before send (TOCTOU detected)" };
      }
    }
  } else if (decision.savePath === "B") {
    if (!decision.expectedFingerprint) {
      return { ok: false, kind: "write_not_authorized", reason: "write_not_authorized", message: "path-B decision missing fingerprint" };
    }
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(decision.finalPath);
    } catch {
      return { ok: false, kind: "name_collision", reason: "fingerprint_mismatch", message: "owned file disappeared before send" };
    }
    if (!st.isFile()) {
      return { ok: false, kind: "name_collision", reason: "fingerprint_mismatch", message: "owned path is no longer a regular file" };
    }
    const currentFp = fingerprintFromStat(st);
    if (!fingerprintEqual(currentFp, decision.expectedFingerprint)) {
      return { ok: false, kind: "name_collision", reason: "fingerprint_mismatch", message: "file changed between decision and send" };
    }
  }
  // PDF: no pre-send check (file must not exist — checked at decideWrite)

  // Mark as used BEFORE sending
  usedDecisions.add(decision as object);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 8. sendWriteScript — the only path for sending write scripts
// ---------------------------------------------------------------------------

export type SendFn<R> = (opts: { scriptTemplate: string; [k: string]: unknown }) => Promise<R>;

/**
 * Regex-based advisory check: verifies the script body contains the expected
 * InDesign API call for the approved operation.
 *
 * LIMITATION: regex matching only — does not catch dynamic calls such as
 * doc["save"]() or variable dispatch. This is a sanity check, not a semantic
 * proof. Stage 7 may add AST-based verification.
 */
function validateOperationBody(body: string, operation: WriteOperation): void {
  const patterns: Record<WriteOperation, RegExp> = {
    // InDesign's Document has no saveAs(); save-as is doc.save(File(path)).
    "save-as":       /\.save\s*\(\s*File\s*\(/,
    "in-place-save": /\.save\s*\(/,
    "export-pdf":    /exportFile\s*\(/,
  };
  if (!patterns[operation].test(body)) {
    throw new Error(
      `operation_body_mismatch: body does not contain expected API for operation "${operation}"`,
    );
  }
}

/**
 * True only for an explicit Envelope success: an object whose `ok` is exactly
 * `true`. Everything else (ok:false, a missing or non-boolean `ok`, null,
 * undefined, primitives) is not proof that the write happened.
 */
function isExplicitSendSuccess(result: unknown): boolean {
  return typeof result === "object" && result !== null && (result as { ok?: unknown }).ok === true;
}

/**
 * Send a write script. Calls assertWriteAllowed immediately before sending.
 * The sendFn is injected so write-guard.ts does not import runScriptWithResultFile.
 *
 * Registry after the send: the record is set to "owned" only when the send did
 * not throw AND `sendFn` returned an explicit Envelope success (`ok === true`)
 * AND the target can be stat'ed. In every other case it is set to "uncertain"
 * with the fingerprint the decision was verified against (never refreshed from
 * disk). If the record is no longer the "pending" record installed here (it was
 * replaced or removed during the send) it belongs to someone else: it is left
 * untouched. The returned `{ ok: true, result }` means "the send completed", not
 * "the write succeeded"; callers inspect `result`.
 *
 * Stage 6 change: scriptOpts now takes { bodyFn: () => string } instead of
 * { scriptTemplate: string }. The body is built AFTER authorization so that
 * the script cannot be pre-constructed and substituted before the guard runs.
 * A WriteCapability is issued, bound to the exact body and operation, and must
 * be consumed inside wrapExtendScript before the script is dispatched.
 *
 * The wrapFn parameter wraps the body in a JXA+ExtendScript template and
 * consumes the capability. It is injected to avoid importing compose.ts here.
 */
export async function sendWriteScript<R>(
  decision: WriteAllowed & WriteDecision,
  request: {
    tool: string;
    documentId: DocumentId;
    finalPath: string;
    operation: WriteOperation;
    /** For path A: fingerprint from reservePlaceholder, forwarded to assertWriteAllowed for inode verification. */
    reservedFingerprint?: Fingerprint;
    /** Build the script body. Called AFTER assertWriteAllowed succeeds. */
    scriptOpts: { bodyFn: () => string };
  },
  sendFn: SendFn<R>,
  wrapFn: (body: string, cap: object, operation: WriteOperation) => string,
): Promise<{ ok: true; result: R } | { ok: false; kind: string; reason: string; message: string }> {
  const assertResult = await assertWriteAllowed(decision, {
    tool: request.tool,
    documentId: request.documentId,
    finalPath: request.finalPath,
    operation: request.operation,
    reservedFingerprint: request.reservedFingerprint,
  });
  if (!assertResult.ok) {
    return assertResult;
  }
  // assertWriteAllowed has now marked the decision as used (usedDecisions.add at line 564).
  // Any exception after this point cannot retry — the decision is consumed.

  // Build the body AFTER authorization.
  const body = request.scriptOpts.bodyFn();

  // Advisory regex check: confirm body contains expected API for the operation.
  validateOperationBody(body, request.operation);

  // Issue a single-use capability bound to this exact body and operation.
  const cap = issueWriteCapability(body, request.operation);

  // Wrap body into JXA+ExtendScript template; consumeWriteCapability is called
  // inside wrapFn, so the capability is consumed before the script is dispatched.
  const scriptTemplate = wrapFn(body, cap, request.operation);

  // Mark in registry as pending before sending. Keep the reference: after the
  // send, only this exact record may be updated.
  const pendingRecord: RegistryRecord = {
    state: "pending",
    documentId: decision.documentId,
    tool: decision.tool,
    fingerprint: decision.expectedFingerprint ?? { dev: 0, ino: 0, size: 0, mtimeMs: 0, ctimeMs: 0 },
  };
  registry.set(decision.registryKey, pendingRecord);
  const stillPending = (): boolean => registry.get(decision.registryKey) === pendingRecord;
  const markUncertain = (): void => {
    registry.set(decision.registryKey, {
      state: "uncertain",
      documentId: decision.documentId,
      tool: decision.tool,
      fingerprint: pendingRecord.fingerprint,
    });
  };

  let result: R;
  try {
    result = await sendFn({ scriptTemplate });
  } catch (err: unknown) {
    if (stillPending()) markUncertain();
    return { ok: false, kind: "io_error", reason: "uncertain", message: `write script failed: ${(err as Error).message}` };
  }

  // The record was replaced or removed during the send: it is not ours to touch.
  if (!stillPending()) {
    return { ok: true, result };
  }

  // No explicit success from the transport: not proof the write happened.
  if (!isExplicitSendSuccess(result)) {
    markUncertain();
    return { ok: true, result };
  }

  // Explicit success: record ownership only if the target can be stat'ed.
  try {
    const st = lstatSync(decision.finalPath);
    const fp = fingerprintFromStat(st);
    registry.set(decision.registryKey, {
      state: "owned",
      documentId: decision.documentId,
      tool: decision.tool,
      fingerprint: fp,
    });
  } catch {
    markUncertain();
  }

  return { ok: true, result };
}

// ---------------------------------------------------------------------------
// 9. INDD name-reservation placeholder (path A)
// ---------------------------------------------------------------------------

/**
 * Create a zero-byte placeholder file using O_CREAT|O_EXCL (wx).
 */
export function reservePlaceholder(path: string): { ok: true; fingerprint: Fingerprint } | { ok: false; reason: WriteRefusalReason; message: string } {
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EEXIST") {
      return { ok: false, reason: "uncertain", message: `name was taken between gate and reservation: ${JSON.stringify(path)}` };
    }
    return { ok: false, reason: "uncertain", message: `could not create placeholder: ${(e as Error).message}` };
  }
  closeSync(fd);
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size !== 0) {
      return { ok: false, reason: "uncertain", message: "placeholder created but lstat shows unexpected state" };
    }
    return { ok: true, fingerprint: fingerprintFromStat(st) };
  } catch {
    return { ok: false, reason: "uncertain", message: "could not stat placeholder after creation" };
  }
}

/**
 * Clean up a placeholder: unlink only if still the same inode and length 0.
 * The unlink is synchronous, so a placeholder that passed the checks is gone
 * when this function returns. Best effort: an unlink error is swallowed.
 */
export function cleanupPlaceholder(path: string, expectedInode: number): void {
  try {
    const st = lstatSync(path);
    if (st.isFile() && st.size === 0 && st.ino === expectedInode) {
      unlinkSync(path);
    }
  } catch {
    // Already gone or not removable — no action needed
  }
}

// ---------------------------------------------------------------------------
// 10. PDF publish via .part file (P2–P6)
// ---------------------------------------------------------------------------

/**
 * Publish a PDF that InDesign wrote to a .part file, by linking it to the
 * final path.
 *
 * `ok:true` means only that the link was made and `final` was VERIFIED (lstat succeeded and it is the very file that
 * was inspected on entry). It does not promise that the temporary name was removed or that nothing is left behind:
 * the cleanup is reported separately by the caller's own observation of the temporary path, which describes a
 * state and not a cause. When `final` cannot be verified, the result is `ok:false` / "uncertain" with an explicit
 * message; `final` and the temporary name are never deleted to repair that.
 *
 * Cleanup (R2b): the temporary name is removed only if it is still the same file as `final` (dev and ino) and is
 * a regular file; otherwise it is left in place. The check and `unlinkSync` run back to back with no `await`.
 *
 * Registry: the only record this function writes is `owned`, and ONLY when ALL of these hold:
 *   1. `unlinkSync(part)` succeeded;
 *   2. the final verification after the removal passed;
 *   3. the record seen on ENTRY has the expected shape (R2a: `uncertain`, this tool, this document, zero
 *      fingerprint, what sendWriteScript leaves after an export);
 *   4. the registry still holds that very record object (identity, not shape) at the last step.
 * In every other case nothing is written, so a record that someone else replaced or removed is never overwritten.
 *
 * KNOWN LIMITS (not closed here):
 *   - G16: the check of the temporary name and `unlinkSync` are two separate system calls. If another process
 *     replaces the name between them, the file that replaced it is removed. The check narrows this window; it does
 *     not close it. Node has no removal conditioned on identity.
 *   - G19 ("window A"): a foreign record of the same shape installed before entry is accepted.
 *   - Publishing the very file that was inspected cannot be guaranteed before the link; a different file is only
 *     detected afterwards (and then left in place, not deleted).
 */
export async function publishPdfPart(opts: {
  partPath: string;
  finalPath: string;
  registryKey: string;
  tool: string;
  documentId: DocumentId;
}): Promise<{ ok: true } | { ok: false; reason: string; message: string }> {
  let partStat: ReturnType<typeof lstatSync>;
  try {
    partStat = lstatSync(opts.partPath);
  } catch (err: unknown) {
    return { ok: false, reason: "uncertain", message: `part file not found: ${(err as Error).message}` };
  }
  if (!partStat.isFile()) {
    return { ok: false, reason: "uncertain", message: "part path is not a regular file" };
  }

  // Registry record on entry: kept as an object so that the last step can check identity, not only shape.
  const entryRecord = registry.get(opts.registryKey);
  const entryExpected =
    entryRecord !== undefined &&
    entryRecord.state === "uncertain" &&
    entryRecord.tool === opts.tool &&
    entryRecord.documentId === opts.documentId &&
    fingerprintEqual(entryRecord.fingerprint, { dev: 0, ino: 0, size: 0, mtimeMs: 0, ctimeMs: 0 });

  try {
    await fs.link(opts.partPath, opts.finalPath);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EEXIST") {
      return { ok: false, reason: "uncertain", message: `final PDF path was taken during export: ${JSON.stringify(opts.finalPath)}` };
    }
    return { ok: false, reason: "uncertain", message: `link failed: ${e.message}` };
  }

  // From here on there is no `await`: verification, cleanup and the registry write are one synchronous block.

  // 1. Verify `final` before any cleanup. A failure here is not a plain publish failure: the link was made.
  let finalStat: Stats;
  try {
    finalStat = lstatSync(opts.finalPath);
  } catch (err: unknown) {
    return {
      ok: false,
      reason: "uncertain",
      message:
        `final could not be verified after publishing: lstat failed (${(err as Error).message}). ` +
        "The temporary file was not removed. final may exist and was not deleted. Ownership was not recorded.",
    };
  }
  if (finalStat.dev !== partStat.dev || finalStat.ino !== partStat.ino) {
    return {
      ok: false,
      reason: "uncertain",
      message:
        "final refers to a different file than the one inspected. It was left in place and not deleted; " +
        "the temporary file was not removed. Ownership was not recorded.",
    };
  }

  // 2. Cleanup. Not removing the temporary name never turns a verified publish into a failure.
  let removed = false;
  let partNow: Stats | undefined;
  try {
    partNow = lstatSync(opts.partPath); // ENOENT or an I/O error: no removal is attempted
  } catch {
    partNow = undefined;
  }
  if (partNow !== undefined && partNow.isFile() && partNow.dev === finalStat.dev && partNow.ino === finalStat.ino) {
    try {
      unlinkSync(opts.partPath);
      removed = true;
    } catch {
      removed = false; // the temporary name stays; the caller observes it
    }
  }

  // 3. Final verification, only if something was removed (the removal changed the file's link count and ctime).
  let finalAfter: Stats | undefined;
  if (removed) {
    let why = "it is a different file";
    try {
      finalAfter = lstatSync(opts.finalPath);
    } catch (err: unknown) {
      finalAfter = undefined;
      why = `lstat failed (${(err as Error).message})`;
    }
    if (finalAfter !== undefined && (finalAfter.dev !== partStat.dev || finalAfter.ino !== partStat.ino)) {
      finalAfter = undefined;
    }
    if (finalAfter === undefined) {
      return {
        ok: false,
        reason: "uncertain",
        message:
          `Published, but final could not be re-verified after the temporary name was removed (${why}). ` +
          "The temporary name WAS removed, final may exist and was not deleted, and ownership was not recorded.",
      };
    }
  }

  // 4. The only registry write: `owned`, when every condition in the doc comment holds.
  if (removed && finalAfter !== undefined && entryExpected && registry.get(opts.registryKey) === entryRecord) {
    registry.set(opts.registryKey, {
      state: "owned",
      documentId: opts.documentId,
      tool: opts.tool,
      fingerprint: fingerprintFromStat(finalAfter),
    });
  }

  return { ok: true };
}
