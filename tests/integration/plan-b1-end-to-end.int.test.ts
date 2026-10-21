import { afterEach, it, expect } from "vitest";
import { mkdtempSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { integrationGate, INTEGRATION_TIMEOUT_MS, closeAllDocuments } from "./helpers.js";
import { createDocumentTool } from "../../src/tools/create-document.js";
import { addPageTool } from "../../src/tools/add-page.js";
import { saveDocumentTool } from "../../src/tools/save-document.js";
import { exportPdfTool } from "../../src/tools/export-pdf.js";

integrationGate("Plan B1 end-to-end (integration)", () => {
  afterEach(async () => {
    await closeAllDocuments();
  });

  it(
    "creates a 4-page A4 document, saves it, exports to PDF",
    async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "indesign-mcp-e2e-"));
      const indd = join(tmpDir, "doc.indd");
      const pdf = join(tmpDir, "doc.pdf");

      try {
        const create = await createDocumentTool.handler({
          preset: "A4",
          pages: 1,
          margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
        });
        expect(create.ok).toBe(true);
        if (!create.ok) return;

        for (let i = 0; i < 3; i++) {
          const add = await addPageTool.handler({ document_id: create.result!.document_id });
          expect(add.ok).toBe(true);
        }

        const save = await saveDocumentTool.handler({ document_id: create.result!.document_id, path: indd });
        expect(save.ok).toBe(true);
        expect(existsSync(indd)).toBe(true);

        const exported = await exportPdfTool.handler({ document_id: create.result!.document_id, path: pdf });
        expect(exported.ok).toBe(true);
        if (!exported.ok) return;
        expect(exported.result?.page_count).toBe(4);
        expect(existsSync(pdf)).toBe(true);
        expect(statSync(pdf).size).toBeGreaterThan(0);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    INTEGRATION_TIMEOUT_MS * 2,
  );
});
