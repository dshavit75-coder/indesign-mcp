import { afterEach, it, expect } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { integrationGate, INTEGRATION_TIMEOUT_MS, closeAllDocuments } from "./helpers.js";
import { createDocumentTool } from "../../src/tools/create-document.js";
import { saveDocumentTool } from "../../src/tools/save-document.js";

integrationGate("save_document (integration)", () => {
  afterEach(async () => {
    await closeAllDocuments();
  });

  it(
    "saves a fresh document to a new path (save-as)",
    async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "indesign-mcp-save-"));
      const indd = join(tmpDir, "test.indd");

      try {
        const create1 = await createDocumentTool.handler({
          preset: "A4",
          margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
        });
        if (!create1.ok) return;

        const env = await saveDocumentTool.handler({ document_id: create1.result!.document_id, path: indd });
        expect(env.ok).toBe(true);
        if (!env.ok) return;
        // InDesign canonicalises macOS paths through firmlinks (/var → /private/var),
        // so the returned path may differ from the input string. Verify the file
        // actually exists at the input path (works through the symlink).
        expect(existsSync(indd)).toBe(true);
        expect(env.result?.path).toMatch(/test\.indd$/);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "save without path on an unsaved document returns an error",
    async () => {
      const create2 = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      if (!create2.ok) return;

      const env = await saveDocumentTool.handler({ document_id: create2.result!.document_id });
      expect(env.ok).toBe(false);
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
