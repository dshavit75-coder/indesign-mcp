import { afterEach, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { integrationGate, INTEGRATION_TIMEOUT_MS, closeAllDocuments } from "./helpers.js";
import { createDocumentTool } from "../../src/tools/create-document.js";
import { createTextFrameTool } from "../../src/tools/create-text-frame.js";
import { setTextTool } from "../../src/tools/set-text.js";
import { defineParagraphStyleTool } from "../../src/tools/define-paragraph-style.js";
import { applyParagraphStyleTool } from "../../src/tools/apply-paragraph-style.js";
import { getPageStateTool } from "../../src/tools/get-page-state.js";
import { saveDocumentTool } from "../../src/tools/save-document.js";
import { exportPdfTool } from "../../src/tools/export-pdf.js";

integrationGate("Plan B2 end-to-end (integration)", () => {
  afterEach(async () => {
    await closeAllDocuments();
  });

  it(
    "composes a styled one-page case study and exports a PDF",
    async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "indesign-mcp-b2-"));
      const indd = join(tmpDir, "case-study.indd");
      const pdf = join(tmpDir, "case-study.pdf");

      try {
        const create = await createDocumentTool.handler({
          preset: "A4",
          margins_mm: { top: 18, bottom: 18, left: 18, right: 18 },
        });
        expect(create.ok).toBe(true);
        if (!create.ok) return;
        const pageId = create.result!.page_ids[0];

        const headline = await createTextFrameTool.handler({
          document_id: create.result!.document_id,
          page_id: pageId,
          bounds_mm: { x: 18, y: 18, width: 174, height: 30 },
          initial_text: "Brand Case Study: How We Shipped",
        });
        expect(headline.ok).toBe(true);
        if (!headline.ok) return;

        const body = await createTextFrameTool.handler({
          document_id: create.result!.document_id,
          page_id: pageId,
          bounds_mm: { x: 18, y: 60, width: 174, height: 200 },
          initial_text:
            "We started with a small team and a clear vision. Over six months, we shipped a product that customers loved. Three lessons stand out: ship small, listen often, iterate honestly. Each cycle taught us something new about the craft.",
        });
        expect(body.ok).toBe(true);
        if (!body.ok) return;

        await defineParagraphStyleTool.handler({
          document_id: create.result!.document_id,
          name: "Headline",
          size_pt: 28,
          leading_pt: 32,
          color_hex: "#FF6600",
        });

        await defineParagraphStyleTool.handler({
          document_id: create.result!.document_id,
          name: "Body",
          size_pt: 11,
          leading_pt: 14,
          alignment: "left",
        });

        await applyParagraphStyleTool.handler({
          document_id: create.result!.document_id,
          frame_id: headline.result!.frame_id,
          style_name: "Headline",
        });
        await applyParagraphStyleTool.handler({
          document_id: create.result!.document_id,
          frame_id: body.result!.frame_id,
          style_name: "Body",
        });

        const state = await getPageStateTool.handler({ document_id: create.result!.document_id, page_id: pageId });
        expect(state.ok).toBe(true);
        if (!state.ok) return;
        expect(state.result?.frames).toHaveLength(2);
        const styleNames = state.result!.frames
          .map((f) => f.paragraph_style_name)
          .filter(Boolean);
        expect(styleNames).toContain("Headline");
        expect(styleNames).toContain("Body");

        const save = await saveDocumentTool.handler({ document_id: create.result!.document_id, path: indd });
        expect(save.ok).toBe(true);
        const exported = await exportPdfTool.handler({ document_id: create.result!.document_id, path: pdf });
        expect(exported.ok).toBe(true);
        if (!exported.ok) return;
        expect(existsSync(pdf)).toBe(true);
        expect(exported.result?.page_count).toBe(1);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    INTEGRATION_TIMEOUT_MS * 3,
  );
});
