import { afterEach, it, expect } from "vitest";
import { mkdtempSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { integrationGate, INTEGRATION_TIMEOUT_MS, closeAllDocuments } from "./helpers.js";
import { wrapExtendScript } from "../../src/compose.js";
import { runScriptWithResultFile } from "../../src/transport/result-file.js";
import { createDocumentTool } from "../../src/tools/create-document.js";
import { createParentPageTool } from "../../src/tools/create-parent-page.js";
import { createTextFrameTool } from "../../src/tools/create-text-frame.js";
import { insertPageNumberMarkerTool } from "../../src/tools/insert-page-number-marker.js";
import { applyParentToPageTool } from "../../src/tools/apply-parent-to-page.js";
import { exportPdfTool } from "../../src/tools/export-pdf.js";

const MarginQuerySchema = z.object({
  pages: z.array(
    z.object({
      id: z.string(),
      side: z.string(),
      left: z.number(),
      right: z.number(),
    }),
  ),
});
type MarginQuery = z.infer<typeof MarginQuerySchema>;

integrationGate("Plan B4 end-to-end (integration)", () => {
  afterEach(async () => {
    await closeAllDocuments();
  });

  it(
    "creates facing-page doc, verifies margin mirroring, builds footer parent with page number, applies to all pages, exports PDF",
    async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "indesign-mcp-b4-"));
      const pdfPath = join(tmpDir, "b4-smoke.pdf");

      try {
        const createDoc = await createDocumentTool.handler({
          preset: "A4",
          facing_pages: true,
          pages: 4,
          margins_mm: { top: 20, bottom: 20, inside: 25, outside: 15 },
        });
        expect(createDoc.ok).toBe(true);
        if (!createDoc.ok) return;
        const docPageIds = createDoc.result!.page_ids;
        expect(docPageIds.length).toBe(4);

        const marginQuery = await runScriptWithResultFile<MarginQuery>({
          language: "JavaScript",
          scriptTemplate: wrapExtendScript(`
            var doc = app.activeDocument;
            var result = [];
            for (var i = 0; i < Math.min(doc.pages.length, 2); i++) {
              var p = doc.pages[i];
              result.push({
                id: String(p.id),
                side: String(p.side),
                left: p.marginPreferences.left,
                right: p.marginPreferences.right
              });
            }
            return { pages: result };
          `),
          resultSchema: MarginQuerySchema,
        });
        expect(marginQuery.ok).toBe(true);
        if (!marginQuery.ok) return;

        const pages = marginQuery.result!.pages;
        const recto = pages.find((p) => p.side === "RIGHT_HAND" || p.side === "1281774162");
        const verso = pages.find((p) => p.side === "LEFT_HAND" || p.side === "1281971784");
        expect(recto, `expected RIGHT_HAND page; got sides: ${pages.map((p) => p.side).join(", ")}`).toBeDefined();
        expect(verso, `expected LEFT_HAND page; got sides: ${pages.map((p) => p.side).join(", ")}`).toBeDefined();
        expect(recto!.left).toBeCloseTo(25, 1);
        expect(recto!.right).toBeCloseTo(15, 1);
        expect(verso!.left).toBeCloseTo(15, 1);
        expect(verso!.right).toBeCloseTo(25, 1);

        const createParent = await createParentPageTool.handler({ document_id: createDoc.result!.document_id, base_name: "Footer" });
        expect(createParent.ok).toBe(true);
        if (!createParent.ok) return;
        const parentName = createParent.result!.parent_name;
        const masterPageId = createParent.result!.page_ids[0];
        expect(parentName).toMatch(/Footer/);

        const createFrame = await createTextFrameTool.handler({
          document_id: createDoc.result!.document_id,
          page_id: masterPageId,
          bounds_mm: { x: 10, y: 278, width: 190, height: 10 },
        });
        expect(createFrame.ok).toBe(true);
        if (!createFrame.ok) return;
        const footerFrameId = createFrame.result!.frame_id;

        const insertMarker = await insertPageNumberMarkerTool.handler({
          document_id: createDoc.result!.document_id,
          frame_id: footerFrameId,
          position: "end",
        });
        expect(insertMarker.ok).toBe(true);

        for (const pageId of docPageIds) {
          const apply = await applyParentToPageTool.handler({
            document_id: createDoc.result!.document_id,
            page_id: pageId,
            parent_name: parentName,
          });
          expect(apply.ok).toBe(true);
          if (!apply.ok) return;
          expect(apply.document_state_delta?.changed_pages?.[0].applied_parent_name).toBe(parentName);
        }

        const exportEnv = await exportPdfTool.handler({ document_id: createDoc.result!.document_id, path: pdfPath });
        expect(exportEnv.ok).toBe(true);
        expect(existsSync(pdfPath)).toBe(true);
        expect(statSync(pdfPath).size).toBeGreaterThan(0);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    INTEGRATION_TIMEOUT_MS * 3,
  );
});
