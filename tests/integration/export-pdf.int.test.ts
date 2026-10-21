import { afterEach, it, expect } from "vitest";
import { mkdtempSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { integrationGate, INTEGRATION_TIMEOUT_MS, closeAllDocuments } from "./helpers.js";
import { createDocumentTool } from "../../src/tools/create-document.js";
import { exportPdfTool } from "../../src/tools/export-pdf.js";

integrationGate("export_pdf (integration)", () => {
  afterEach(async () => {
    await closeAllDocuments();
  });

  it(
    "exports a fresh A4 document to a real PDF on disk",
    async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "indesign-mcp-pdf-"));
      const pdf = join(tmpDir, "out.pdf");

      try {
        const create = await createDocumentTool.handler({
          preset: "A4",
          pages: 2,
          margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
        });
        if (!create.ok) return;

        const env = await exportPdfTool.handler({ document_id: create.result!.document_id, path: pdf });
        expect(env.ok).toBe(true);
        if (!env.ok) return;
        expect(env.result?.path).toBe(pdf);
        expect(env.result?.page_count).toBe(2);
        expect(existsSync(pdf)).toBe(true);
        expect(statSync(pdf).size).toBeGreaterThan(0);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
