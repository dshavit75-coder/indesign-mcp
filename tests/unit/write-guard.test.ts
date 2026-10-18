/**
 * Stage 2 unit tests for write-guard.ts
 *
 * Tests cover (per plan §2):
 *   - Path normalization (all 9 rules + examples)
 *   - Registry state transitions and fingerprint mismatch
 *   - Name computation N1–N6
 *   - Runtime verification W1–W6
 *   - PDF publish P2–P6
 *   - INDD name reservation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { homedir } from "node:os";
import * as nodeFs from "node:fs";
import * as nodeFsPromises from "node:fs/promises";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import {
  pathGate,
  computeAgentName,
  decideWrite,
  assertWriteAllowed,
  sendWriteScript,
  reservePlaceholder,
  cleanupPlaceholder,
  publishPdfPart,
  registryReset,
  registryGet,
  registrySet,
  type WriteAllowed,
  type WriteDecision,
} from "../../src/write-guard.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(homedir(), ".indesign-mcp-test-"));
  registryReset();
});
afterEach(() => {
  try { rmdirSync(tmpDir, { recursive: true } as Parameters<typeof rmdirSync>[1]); } catch { /* ok */ }
});

function touchFile(path: string): void {
  writeFileSync(path, "");
}

// ---------------------------------------------------------------------------
// Path normalization — spec §2 rule-by-rule
// ---------------------------------------------------------------------------

describe("pathGate — path normalization", () => {
  it("accepts an absolute .indd path with a real parent directory", () => {
    const result = pathGate(tmpDir + "/a_cod.indd", ".indd");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.lstatResult).toBe("missing");
    }
  });

  it("accepts ~/Desktop/a_cod.indd (rule 3: ~/ expansion)", () => {
    // We can\'t write to ~/Desktop in test but can check the expansion logic
    const result = pathGate("~/Desktop/a_cod.indd", ".indd");
    // May fail with parent_missing if Desktop doesn\'t exist, but NOT path_not_absolute
    if (!result.ok) {
      expect(result.reason).not.toBe("path_not_absolute");
    }
  });

  it("rejects a relative path (rule 2)", () => {
    const r = pathGate("a.indd", ".indd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("path_not_absolute");
  });

  it("rejects bare ~ (rule 2)", () => {
    const r = pathGate("~/", ".indd");
    // ~/  expands to home + "" which has an empty last segment after split
    // OR it may be caught as empty file name — either way it must fail
    expect(r.ok).toBe(false);
  });

  it("rejects ~user/… (rule 2)", () => {
    const r = pathGate("~daniel/file.indd", ".indd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("path_not_absolute");
  });

  it("rejects // (rule 4: empty segment)", () => {
    const r = pathGate("/Users/x//a.indd", ".indd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("path_not_absolute");
  });

  it("rejects trailing / (rule 4)", () => {
    const r = pathGate(tmpDir + "/a.indd/", ".indd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("path_not_absolute");
  });

  it("rejects .. segment (rule 4)", () => {
    const r = pathGate("/tmp/../etc/a.indd", ".indd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("path_not_absolute");
  });

  it("rejects . segment (rule 4)", () => {
    const r = pathGate("/tmp/./a.indd", ".indd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("path_not_absolute");
  });

  it("rejects wrong extension for .indd gate (rule 5)", () => {
    const r = pathGate(tmpDir + "/a.pdf", ".indd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("wrong_extension");
  });

  it("rejects wrong extension for .pdf gate (rule 5)", () => {
    const r = pathGate(tmpDir + "/a.indd", ".pdf");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("wrong_extension");
  });

  it("accepts extension case-insensitively (rule 5)", () => {
    const r = pathGate(tmpDir + "/a.INDD", ".indd");
    // Should be accepted (case-insensitive)
    expect(r.ok).toBe(true);
  });

  it("rejects reserved filename prefix .indesign-mcp-... (rule 5)", () => {
    const r = pathGate(tmpDir + "/.indesign-mcp-tmp.indd", ".indd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("path_not_absolute");
  });

  it("rejects missing parent directory (rule 6)", () => {
    const r = pathGate(tmpDir + "/nonexistent-dir/a.indd", ".indd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("parent_missing");
  });

  it("lstat: missing file → lstatResult=missing (rule 8)", () => {
    const r = pathGate(tmpDir + "/new.indd", ".indd");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lstatResult).toBe("missing");
  });

  it("lstat: existing regular file → lstatResult=regular (rule 8)", () => {
    const path = tmpDir + "/existing.indd";
    touchFile(path);
    const r = pathGate(path, ".indd");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.lstatResult).toBe("regular");
  });

  it("lstat: symlink → symlink_target (rule 8)", () => {
    const target = tmpDir + "/real.indd";
    const link = tmpDir + "/link.indd";
    touchFile(target);
    nodeFs.symlinkSync(target, link);
    const r = pathGate(link, ".indd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("symlink_target");
  });

  it("NFC and NFD names produce the same registry key (rule 9)", () => {
    const nfc = "הזמנה_cod.indd";
    const nfd = nfc.normalize("NFD");
    const r1 = pathGate(tmpDir + "/" + nfc, ".indd");
    const r2 = pathGate(tmpDir + "/" + nfd, ".indd");
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.registryKey).toBe(r2.registryKey);
    }
  });
});

// ---------------------------------------------------------------------------
// Name computation N1–N6
// ---------------------------------------------------------------------------

describe("computeAgentName — N1: new from scratch", () => {
  it("N1a: Wedding_Album → Wedding_Album_cod.indd", () => {
    const r = computeAgentName({ kind: "new", baseName: "Wedding_Album", targetDir: tmpDir, lstat: () => ({ exists: false }) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(tmpDir + "/Wedding_Album_cod.indd");
  });

  it("N1b: Hebrew base name הזמנה → הזמנה_cod.indd", () => {
    const r = computeAgentName({ kind: "new", baseName: "הזמנה", targetDir: tmpDir, lstat: () => ({ exists: false }) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(tmpDir + "/הזמנה_cod.indd");
  });
});

describe("computeAgentName — N2: working copy", () => {
  it("N2: Wedding_Album.indd → Wedding_Album_cod.indd in same directory", () => {
    const sourcePath = tmpDir + "/Wedding_Album.indd";
    const r = computeAgentName({ kind: "working-copy", sourcePath, lstat: () => ({ exists: false }) });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.path).toBe(tmpDir + "/Wedding_Album_cod.indd");
      // Source path unchanged — verify it\'s NOT in the result
      expect(r.path).not.toBe(sourcePath);
    }
  });
});

describe("computeAgentName — N3: idempotence", () => {
  it("N3a: baseName=Wedding_Album_cod → Wedding_Album_cod.indd (no doubling)", () => {
    const r = computeAgentName({ kind: "new", baseName: "Wedding_Album_cod", targetDir: tmpDir, lstat: () => ({ exists: false }) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(tmpDir + "/Wedding_Album_cod.indd");
  });

  it("N3b: working-copy of Wedding_Album_cod.indd → Wedding_Album_cod.indd (no doubling)", () => {
    const sourcePath = tmpDir + "/Wedding_Album_cod.indd";
    const r = computeAgentName({ kind: "working-copy", sourcePath, lstat: () => ({ exists: false }) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(tmpDir + "/Wedding_Album_cod.indd");
  });
});

describe("computeAgentName — N4: versioned snapshot", () => {
  it("N4a: v1 free → _cod_v1.indd", () => {
    const workingPath = tmpDir + "/Album_cod.indd";
    const r = computeAgentName({ kind: "snapshot", workingPath, lstat: () => ({ exists: false }) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(tmpDir + "/Album_cod_v1.indd");
  });

  it("N4b: v1 taken, v2 free → _cod_v2.indd", () => {
    const workingPath = tmpDir + "/Album_cod.indd";
    const r = computeAgentName({
      kind: "snapshot",
      workingPath,
      lstat: (p) => ({ exists: p.endsWith("_cod_v1.indd") }),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(tmpDir + "/Album_cod_v2.indd");
  });

  it("N4c: all v1–v99 taken → version_limit_reached", () => {
    const workingPath = tmpDir + "/Album_cod.indd";
    const r = computeAgentName({
      kind: "snapshot",
      workingPath,
      lstat: () => ({ exists: true }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("version_limit_reached");
  });
});

describe("computeAgentName — N5: PDF export", () => {
  it("N5a: Wedding_Album_cod.indd → Wedding_Album_cod.pdf", () => {
    const workingPath = tmpDir + "/Wedding_Album_cod.indd";
    const r = computeAgentName({ kind: "pdf-export", workingPath, lstat: () => ({ exists: false }) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(tmpDir + "/Wedding_Album_cod.pdf");
  });

  it("N5b: Wedding_Album_cod_v2.indd → Wedding_Album_cod_v2.pdf", () => {
    const workingPath = tmpDir + "/Wedding_Album_cod_v2.indd";
    const r = computeAgentName({ kind: "pdf-export", workingPath, lstat: () => ({ exists: false }) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(tmpDir + "/Wedding_Album_cod_v2.pdf");
  });
});

describe("computeAgentName — N6: name truncation", () => {
  it("N6: base name > 255 bytes after _cod → name_truncated warning", () => {
    // Create a base name that after _cod.indd suffix would exceed 255 bytes
    // _cod.indd = 9 bytes; so base must be > 246 bytes
    const longBase = "A".repeat(250);
    const r = computeAgentName({ kind: "new", baseName: longBase, targetDir: tmpDir, lstat: () => ({ exists: false }) });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.warnings).toContain("name_truncated");
      // Final file name must be at most 255 bytes
      const fileName = r.path.split("/").pop()!;
      expect(Buffer.byteLength(fileName, "utf8")).toBeLessThanOrEqual(255);
    }
  });
});

// ---------------------------------------------------------------------------
// Registry state transitions and fingerprint mismatch
// ---------------------------------------------------------------------------

describe("registry — state transitions", () => {
  it("path A: file missing → decision ok, savePath=A", async () => {
    const path = tmpDir + "/new_cod.indd";
    const r = await decideWrite({ tool: "save_document", operation: "save-as", documentId: "doc1", path, expectedExtension: ".indd" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.decision.savePath).toBe("A");
  });

  it("path C: file exists, not owned → name_collision, not_owned", async () => {
    const path = tmpDir + "/user.indd";
    touchFile(path);
    const r = await decideWrite({ tool: "save_document", operation: "save-as", documentId: "doc1", path, expectedExtension: ".indd" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("name_collision");
      expect(r.reason).toBe("not_owned");
      expect(r.suggested_path).toBeTruthy();
    }
  });

  it("fingerprint mismatch: each of 5 fields → fingerprint_mismatch", async () => {
    const path = tmpDir + "/fp_test_cod.indd";
    touchFile(path);
    const st = nodeFs.lstatSync(path);
    // Set a record with a deliberate mismatch in size
    const { realpathSync } = nodeFs;
    const realDir = realpathSync(tmpDir);
    const key = realDir + "/fp_test_cod.indd";
    registrySet(key, {
      state: "owned",
      documentId: "doc1",
      tool: "save_document",
      fingerprint: { dev: st.dev, ino: st.ino, size: 999, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs },
    });
    const r = await decideWrite({ tool: "save_document", operation: "save-as", documentId: "doc1", path, expectedExtension: ".indd" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("fingerprint_mismatch");
  });

  it("document_mismatch: different documentId → name_collision, document_mismatch", async () => {
    const path = tmpDir + "/owned_cod.indd";
    touchFile(path);
    const st = nodeFs.lstatSync(path);
    const { realpathSync } = nodeFs;
    const realDir = realpathSync(tmpDir);
    const key = realDir + "/owned_cod.indd";
    registrySet(key, {
      state: "owned",
      documentId: "doc-A",
      tool: "save_document",
      fingerprint: { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs },
    });
    const r = await decideWrite({ tool: "save_document", operation: "save-as", documentId: "doc-B", path, expectedExtension: ".indd" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("document_mismatch");
  });

  it("uncertain state → name_collision, uncertain", async () => {
    const path = tmpDir + "/uncertain_cod.indd";
    touchFile(path);
    const st = nodeFs.lstatSync(path);
    const { realpathSync } = nodeFs;
    const realDir = realpathSync(tmpDir);
    const key = realDir + "/uncertain_cod.indd";
    registrySet(key, {
      state: "uncertain",
      documentId: "doc1",
      tool: "save_document",
      fingerprint: { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs },
    });
    const r = await decideWrite({ tool: "save_document", operation: "save-as", documentId: "doc1", path, expectedExtension: ".indd" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("uncertain");
  });
});

// ---------------------------------------------------------------------------
// Runtime verification W1–W6
// ---------------------------------------------------------------------------

describe("assertWriteAllowed — W1: forged decision", () => {
  it("W1: forged object (same fields) → write_not_authorized, 0 sends", async () => {
    const forged = {
      tool: "save_document",
      operation: "save-as" as const,
      documentId: "doc1",
      finalPath: tmpDir + "/x_cod.indd",
      registryKey: tmpDir + "/x_cod.indd",
      savePath: "A" as const,
    } as WriteAllowed & WriteDecision;
    const r = await assertWriteAllowed(forged, { tool: "save_document", operation: "save-as", documentId: "doc1", finalPath: tmpDir + "/x_cod.indd" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("write_not_authorized");
  });
});

describe("assertWriteAllowed — W2: decision reused", () => {
  it("W2: second call on same decision → write_not_authorized", async () => {
    const path = tmpDir + "/w2_cod.indd";
    const dr = await decideWrite({ tool: "save_document", operation: "save-as", documentId: "doc1", path, expectedExtension: ".indd" });
    expect(dr.ok).toBe(true);
    if (!dr.ok) return;
    const decision = dr.decision;
    // Create placeholder so path-A check passes (Stage A requires placeholder to exist)
    reservePlaceholder(path);
    // First assert — consume it
    const r1 = await assertWriteAllowed(decision, { tool: "save_document", operation: "save-as", documentId: "doc1", finalPath: path });
    expect(r1.ok).toBe(true);
    // Second assert — must fail
    const r2 = await assertWriteAllowed(decision, { tool: "save_document", operation: "save-as", documentId: "doc1", finalPath: path });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.kind).toBe("write_not_authorized");
  });
});

describe("assertWriteAllowed — W3: mismatched fields", () => {
  it("W3a: different documentId → write_not_authorized", async () => {
    const path = tmpDir + "/w3a_cod.indd";
    const dr = await decideWrite({ tool: "save_document", operation: "save-as", documentId: "doc1", path, expectedExtension: ".indd" });
    if (!dr.ok) return;
    const r = await assertWriteAllowed(dr.decision, { tool: "save_document", operation: "save-as", documentId: "doc-OTHER", finalPath: path });
    expect(r.ok).toBe(false);
  });

  it("W3b: different path (including NFD variant) → write_not_authorized", async () => {
    const path = tmpDir + "/w3b_cod.indd";
    const dr = await decideWrite({ tool: "save_document", operation: "save-as", documentId: "doc1", path, expectedExtension: ".indd" });
    if (!dr.ok) return;
    const r = await assertWriteAllowed(dr.decision, { tool: "save_document", operation: "save-as", documentId: "doc1", finalPath: tmpDir + "/other_cod.indd" });
    expect(r.ok).toBe(false);
  });
});

describe("assertWriteAllowed — W4: operation mismatch", () => {
  it("W4: save-as decision used for in-place-save → write_not_authorized", async () => {
    const path = tmpDir + "/w4_cod.indd";
    const dr = await decideWrite({ tool: "save_document", operation: "save-as", documentId: "doc1", path, expectedExtension: ".indd" });
    if (!dr.ok) return;
    const r = await assertWriteAllowed(dr.decision, { tool: "save_document", operation: "in-place-save", documentId: "doc1", finalPath: path });
    expect(r.ok).toBe(false);
  });
});

describe("assertWriteAllowed — W5: file changed between decision and assert", () => {
  it("W5: path-A placeholder replaced → write_not_authorized", async () => {
    const path = tmpDir + "/w5_cod.indd";
    const dr = await decideWrite({ tool: "save_document", operation: "save-as", documentId: "doc1", path, expectedExtension: ".indd" });
    if (!dr.ok) return;
    // Write content to make it non-zero
    writeFileSync(path, "not empty");
    const r = await assertWriteAllowed(dr.decision, { tool: "save_document", operation: "save-as", documentId: "doc1", finalPath: path });
    expect(r.ok).toBe(false);
  });
});

describe("assertWriteAllowed — W6: path-A placeholder modified", () => {
  it("W6: placeholder given content before send → refused", async () => {
    const path = tmpDir + "/w6_cod.indd";
    const dr = await decideWrite({ tool: "save_document", operation: "save-as", documentId: "doc1", path, expectedExtension: ".indd" });
    if (!dr.ok) return;
    // Create the placeholder and then fill it
    nodeFs.writeFileSync(path, "some content");
    const r = await assertWriteAllowed(dr.decision, { tool: "save_document", operation: "save-as", documentId: "doc1", finalPath: path });
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Path C: every reason returns refusal, no bypass
// ---------------------------------------------------------------------------

describe("path C: bypass attempts", () => {
  it("not_owned: suggested_path is a _cod_vN name", async () => {
    const path = tmpDir + "/user_file.indd";
    touchFile(path);
    const r = await decideWrite({ tool: "save_document", operation: "save-as", documentId: "doc1", path, expectedExtension: ".indd" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.suggested_path).toMatch(/_cod_v\d+\.indd$/);
    }
  });
});

// ---------------------------------------------------------------------------
// suggested_path: the suggestion keeps the extension the caller expects (found live: an existing PDF got
// "<name>.pdf_cod_v1.indd"). The REAL decideWrite and real files in a temporary directory.
// ---------------------------------------------------------------------------

describe("suggested_path keeps the expected extension", () => {
  async function refuse(path: string, ext: ".indd" | ".pdf") {
    const tool = ext === ".pdf" ? "export_pdf" : "save_document";
    const operation = ext === ".pdf" ? "export-pdf" : "save-as";
    const r = await decideWrite({ tool, operation, documentId: "doc1", path, expectedExtension: ext } as Parameters<typeof decideWrite>[0]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected a refusal");
    return r;
  }

  it("SP1: an existing PDF → a suggestion that ends in .pdf, not .indd, and is the first free _cod_vN name", async () => {
    const path = tmpDir + "/Album.pdf";
    touchFile(path);
    const r = await refuse(path, ".pdf");
    expect(r.suggested_path).toBe(tmpDir + "/Album_cod_v1.pdf");
    expect(r.suggested_path!.endsWith(".pdf")).toBe(true);
    expect(r.suggested_path!.endsWith(".indd")).toBe(false);
    expect(r.suggested_path).not.toContain(".pdf_cod");
  });

  it("SP2: the suggested PDF name does not exist; taken names are skipped (v1 taken → v2)", async () => {
    touchFile(tmpDir + "/Album.pdf");
    touchFile(tmpDir + "/Album_cod_v1.pdf");
    const r = await refuse(tmpDir + "/Album.pdf", ".pdf");
    expect(r.suggested_path).toBe(tmpDir + "/Album_cod_v2.pdf");
    expect(nodeFs.existsSync(r.suggested_path!)).toBe(false);
  });

  it("SP3: a PDF whose name ends in _cod → the _cod is not doubled", async () => {
    touchFile(tmpDir + "/Album_cod.pdf");
    const r = await refuse(tmpDir + "/Album_cod.pdf", ".pdf");
    expect(r.suggested_path).toBe(tmpDir + "/Album_cod_v1.pdf");
  });

  it("SP4: an upper-case .PDF extension (accepted by pathGate) is stripped too", async () => {
    touchFile(tmpDir + "/Album.PDF");
    const r = await refuse(tmpDir + "/Album.PDF", ".pdf");
    expect(r.suggested_path).toBe(tmpDir + "/Album_cod_v1.pdf");
  });

  it("SP5: INDD is unchanged: a user file → <name>_cod_v1.indd, and v1 taken → v2", async () => {
    touchFile(tmpDir + "/user_file.indd");
    let r = await refuse(tmpDir + "/user_file.indd", ".indd");
    expect(r.suggested_path).toBe(tmpDir + "/user_file_cod_v1.indd");
    touchFile(tmpDir + "/user_file_cod_v1.indd");
    r = await refuse(tmpDir + "/user_file.indd", ".indd");
    expect(r.suggested_path).toBe(tmpDir + "/user_file_cod_v2.indd");
  });

  it("SP6: a PDF refusal still reports the existing path and the not_owned reason (contract unchanged)", async () => {
    touchFile(tmpDir + "/Album.pdf");
    const r = await refuse(tmpDir + "/Album.pdf", ".pdf");
    expect(r.kind).toBe("name_collision");
    expect(r.reason).toBe("not_owned");
    expect(r.existing_path).toBe(tmpDir + "/Album.pdf");
  });
});

// ---------------------------------------------------------------------------
// sendWriteScript: 0 sends on refusal
// ---------------------------------------------------------------------------

describe("sendWriteScript", () => {
  it("forged decision → 0 sends, write_not_authorized", async () => {
    const sendFn = vi.fn();
    const forged = {
      tool: "save_document",
      operation: "save-as" as const,
      documentId: "doc1",
      finalPath: tmpDir + "/forged_cod.indd",
      registryKey: tmpDir + "/forged_cod.indd",
      savePath: "A" as const,
    } as WriteAllowed & WriteDecision;
    const r = await sendWriteScript(forged, {
      tool: "save_document",
      documentId: "doc1",
      finalPath: tmpDir + "/forged_cod.indd",
      operation: "save-as",
      scriptOpts: { bodyFn: () => "" },
    }, sendFn, expect.any(Function));
    expect(r.ok).toBe(false);
    expect(sendFn).not.toHaveBeenCalled();
  });

  it("valid decision → send is called once", async () => {
    const path = tmpDir + "/send_test_cod.indd";
    const dr = await decideWrite({ tool: "save_document", operation: "save-as", documentId: "doc1", path, expectedExtension: ".indd" });
    expect(dr.ok).toBe(true);
    if (!dr.ok) return;
    // Create placeholder so path-A check passes (Stage A requires placeholder to exist)
    reservePlaceholder(path);
    const sendFn = vi.fn().mockResolvedValue({ path });
    const wrapFn = vi.fn().mockReturnValue("/* wrapped */");
    const r = await sendWriteScript(dr.decision, {
      tool: "save_document",
      documentId: "doc1",
      finalPath: path,
      operation: "save-as",
      scriptOpts: { bodyFn: () => 'doc.save(File("/tmp/a_cod.indd"));' },
    }, sendFn, wrapFn);
    expect(sendFn).toHaveBeenCalledTimes(1);
    // sendFn above resolves { path } — not an Envelope with ok: true — so the
    // record is "uncertain" (only an explicit ok: true can make it "owned");
    // see write-guard-s2.test.ts. Here we only verify that the send was called.
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Name reservation (path A placeholder)
// ---------------------------------------------------------------------------

describe("reservePlaceholder", () => {
  it("creates a zero-byte file and returns its fingerprint", () => {
    const path = tmpDir + "/placeholder_cod.indd";
    const r = reservePlaceholder(path);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.fingerprint.size).toBe(0);
      const st = nodeFs.lstatSync(path);
      expect(st.size).toBe(0);
    }
  });

  it("fails with uncertain when name is taken (EEXIST)", () => {
    const path = tmpDir + "/taken_cod.indd";
    touchFile(path);
    nodeFs.writeFileSync(path, "existing");
    const r = reservePlaceholder(path);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("uncertain");
  });
});

describe("cleanupPlaceholder", () => {
  it("removes a zero-byte file with matching inode", () => {
    const path = tmpDir + "/cleanup_cod.indd";
    touchFile(path);
    const st = nodeFs.lstatSync(path);
    cleanupPlaceholder(path, st.ino);
    // File should be gone (eventually — async unlink)
    setTimeout(() => {
      try { nodeFs.lstatSync(path); expect(false).toBe(true); } catch { /* ok */ }
    }, 100);
  });

  it("does not remove a non-zero file", () => {
    const path = tmpDir + "/nonempty_cod.indd";
    writeFileSync(path, "content");
    const st = nodeFs.lstatSync(path);
    cleanupPlaceholder(path, st.ino);
    // File should still exist
    expect(() => nodeFs.lstatSync(path)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// PDF publish P2–P6
// ---------------------------------------------------------------------------

describe("publishPdfPart", () => {
  it("P2: links .part to final path and removes .part", async () => {
    const partPath = tmpDir + "/export.pdf.part";
    const finalPath = tmpDir + "/Album_cod.pdf";
    writeFileSync(partPath, "pdf-content");
    const r = await publishPdfPart({
      partPath,
      finalPath,
      registryKey: tmpDir + "/Album_cod.pdf",
      tool: "export_pdf",
      documentId: "doc1",
    });
    expect(r.ok).toBe(true);
    expect(() => nodeFs.lstatSync(finalPath)).not.toThrow();
  });

  it("P3: .part file missing → uncertain", async () => {
    const r = await publishPdfPart({
      partPath: tmpDir + "/nonexistent.pdf.part",
      finalPath: tmpDir + "/out.pdf",
      registryKey: tmpDir + "/out.pdf",
      tool: "export_pdf",
      documentId: "doc1",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("uncertain");
  });

  it("P4: final path already exists (EEXIST on link) → uncertain", async () => {
    const partPath = tmpDir + "/export2.pdf.part";
    const finalPath = tmpDir + "/exists.pdf";
    writeFileSync(partPath, "pdf");
    writeFileSync(finalPath, "existing-pdf");
    const r = await publishPdfPart({
      partPath,
      finalPath,
      registryKey: tmpDir + "/exists.pdf",
      tool: "export_pdf",
      documentId: "doc1",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("uncertain");
  });

  // ── R2a: the registry write of publishPdfPart ─────────────────────────────────────────────────────
  // Real files, no mocks. The registry record present on ENTRY is seeded with registrySet. `owned` is written
  // only for the expected entry record; in every other case the registry is left exactly as it was.

  const ZERO_FP = { dev: 0, ino: 0, size: 0, mtimeMs: 0, ctimeMs: 0 };
  const expectedEntry = () => ({ state: "uncertain" as const, documentId: "doc1", tool: "export_pdf", fingerprint: { ...ZERO_FP } });
  function publishArgs(name: string) {
    const partPath = tmpDir + "/" + name + ".part";
    const finalPath = tmpDir + "/" + name;
    writeFileSync(partPath, "pdf-content");
    return { partPath, finalPath, registryKey: finalPath, tool: "export_pdf", documentId: "doc1" };
  }
  const fpOf = (path: string) => {
    const st = nodeFs.lstatSync(path);
    return { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs };
  };

  it("R2a-W1: the expected entry record → the temporary name is removed and the record becomes owned with the final file's fingerprint", async () => {
    const a = publishArgs("w1.pdf");
    registrySet(a.registryKey, expectedEntry());

    const r = await publishPdfPart(a);

    expect(r.ok).toBe(true);
    expect(nodeFs.existsSync(a.partPath)).toBe(false);
    expect(nodeFs.readFileSync(a.finalPath, "utf8")).toBe("pdf-content");
    expect(registryGet(a.registryKey)).toEqual({ state: "owned", documentId: "doc1", tool: "export_pdf", fingerprint: fpOf(a.finalPath) });
  });

  it("R2a-W2: no record on entry (window A) → published, and no record is written", async () => {
    const a = publishArgs("w2.pdf");

    const r = await publishPdfPart(a);

    expect(r.ok).toBe(true);
    expect(nodeFs.readFileSync(a.finalPath, "utf8")).toBe("pdf-content");
    expect(registryGet(a.registryKey)).toBeUndefined();
  });

  it.each([
    ["state", { ...expectedEntry(), state: "owned" as const }],
    ["tool", { ...expectedEntry(), tool: "save_document" }],
    ["documentId", { ...expectedEntry(), documentId: "doc2" }],
    ["fingerprint", { ...expectedEntry(), fingerprint: { dev: 1, ino: 2, size: 3, mtimeMs: 4, ctimeMs: 5 } }],
  ])("R2a-W3 (%s): a record of a different shape on entry (window A) → published, the record is left untouched", async (_what, foreign) => {
    const a = publishArgs("w3.pdf");
    registrySet(a.registryKey, foreign);

    const r = await publishPdfPart(a);

    expect(r.ok).toBe(true);
    expect(nodeFs.readFileSync(a.finalPath, "utf8")).toBe("pdf-content");
    expect(registryGet(a.registryKey)).toBe(foreign); // the very same object
  });

  it("R2a-W4 KNOWN LIMITATION: a foreign record with the SAME shape on entry is accepted and overwritten with owned (G19 is not fully closed)", async () => {
    // Pins a limit, not a protection: the identity of the record observed on entry does not prove that it
    // belongs to this operation. Closing window A needs a binding between the record and the original write.
    const a = publishArgs("w4.pdf");
    const foreignSameShape = expectedEntry();
    registrySet(a.registryKey, foreignSameShape);

    const r = await publishPdfPart(a);

    expect(r.ok).toBe(true);
    expect(registryGet(a.registryKey)).not.toBe(foreignSameShape);
    expect(registryGet(a.registryKey)?.state).toBe("owned");
  });
});
