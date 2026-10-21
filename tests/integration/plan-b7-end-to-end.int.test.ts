import { afterEach, it, expect } from "vitest";
import { mkdtempSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { integrationGate, INTEGRATION_TIMEOUT_MS, closeAllDocuments } from "./helpers.js";
import { createDocumentTool } from "../../src/tools/create-document.js";
import { createTextFrameTool } from "../../src/tools/create-text-frame.js";
import { setTextTool } from "../../src/tools/set-text.js";
import { createSwatchTool } from "../../src/tools/create-swatch.js";
import { defineParagraphStyleTool } from "../../src/tools/define-paragraph-style.js";
import { defineCharacterStyleTool } from "../../src/tools/define-character-style.js";
import { listParagraphStylesTool } from "../../src/tools/list-paragraph-styles.js";
import { findReplaceTool } from "../../src/tools/find-replace.js";
import { duplicateFrameTool } from "../../src/tools/duplicate-frame.js";
import { listPagesTool } from "../../src/tools/list-pages.js";
import { exportPdfTool } from "../../src/tools/export-pdf.js";

integrationGate("Plan B7 end-to-end (integration)", () => {
  afterEach(async () => {
    await closeAllDocuments();
  });

  it(
    "create swatch → define styles → list styles → create frame → find_replace → duplicate → list pages → export PDF",
    async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "indesign-mcp-b7-"));
      const pdfPath = join(tmpDir, "b7-smoke.pdf");

      try {
        const docEnv = await createDocumentTool.handler({
          preset: "A4",
          margins_mm: { top: 20, bottom: 20, left: 20, right: 20 },
        });
        expect(docEnv.ok).toBe(true);
        if (!docEnv.ok) return;
        const pageId = docEnv.result!.page_ids[0];

        const swatchEnv = await createSwatchTool.handler({
          document_id: docEnv.result!.document_id,
          name: "Brand Orange",
          hex: "#FF6600",
        });
        expect(swatchEnv.ok).toBe(true);
        if (!swatchEnv.ok) return;
        expect(swatchEnv.result?.swatch_name).toBe("Brand Orange");
        expect(swatchEnv.result?.on_collision_outcome).toBe("created");
        expect(swatchEnv.document_state_delta?.new_swatches).toEqual([{ name: "Brand Orange" }]);

        const paraStyleEnv = await defineParagraphStyleTool.handler({
          document_id: docEnv.result!.document_id,
          name: "IranBody",
          size_pt: 11,
          leading_pt: 14,
          color_hex: "#FF6600",
        });
        expect(paraStyleEnv.ok).toBe(true);
        if (!paraStyleEnv.ok) return;
        expect(paraStyleEnv.result?.name).toBe("IranBody");
        expect(paraStyleEnv.result?.on_collision_outcome).toBe("created");
        expect(paraStyleEnv.document_state_delta?.new_paragraph_styles).toEqual([{ name: "IranBody" }]);

        const charStyleEnv = await defineCharacterStyleTool.handler({
          document_id: docEnv.result!.document_id,
          name: "IranEmphasis",
          fill_hex: "#FF6600",
          tracking: 20,
        });
        expect(charStyleEnv.ok).toBe(true);
        if (!charStyleEnv.ok) return;
        expect(charStyleEnv.result?.character_style_name).toBe("IranEmphasis");

        const listStylesEnv = await listParagraphStylesTool.handler({ document_id: docEnv.result!.document_id });
        expect(listStylesEnv.ok).toBe(true);
        if (!listStylesEnv.ok) return;
        const iranBody = listStylesEnv.result!.paragraph_styles.find(
          (s) => s.name === "IranBody",
        );
        expect(iranBody).toBeDefined();
        expect(iranBody!.point_size).toBeCloseTo(11, 1);

        for (const s of listStylesEnv.result!.paragraph_styles) {
          expect(s.name.charAt(0)).not.toBe("[");
        }

        const frameEnv = await createTextFrameTool.handler({
          document_id: docEnv.result!.document_id,
          page_id: pageId,
          bounds_mm: { x: 20, y: 30, width: 160, height: 60 },
        });
        expect(frameEnv.ok).toBe(true);
        if (!frameEnv.ok) return;
        const frameId = frameEnv.result!.frame_id;

        const setTextEnv = await setTextTool.handler({
          document_id: docEnv.result!.document_id,
          frame_id: frameId,
          text: "Total displaced: 1.5M people",
        });
        expect(setTextEnv.ok).toBe(true);

        const frEnv = await findReplaceTool.handler({
          document_id: docEnv.result!.document_id,
          find: "people",
          replace: "individuals",
        });
        expect(frEnv.ok).toBe(true);
        if (!frEnv.ok) return;
        expect(frEnv.result?.matches_changed).toBe(1);
        expect(frEnv.document_state_delta?.changed_frames).toEqual([]);

        const dupEnv = await duplicateFrameTool.handler({
          document_id: docEnv.result!.document_id,
          frame_id: frameId,
          offset_mm: { x: 0, y: 70 },
        });
        expect(dupEnv.ok).toBe(true);
        if (!dupEnv.ok) return;
        expect(dupEnv.result?.duplicate_frame_id).not.toBe(frameId);
        expect(dupEnv.result?.duplicate_type).toBe("text");
        expect(dupEnv.document_state_delta?.new_frames?.[0].type).toBe("text");

        const pagesEnv = await listPagesTool.handler({ document_id: docEnv.result!.document_id });
        expect(pagesEnv.ok).toBe(true);
        if (!pagesEnv.ok) return;
        expect(pagesEnv.result!.pages.length).toBeGreaterThanOrEqual(1);
        expect(pagesEnv.result!.pages[0].index).toBe(0);
        expect(typeof pagesEnv.result!.pages[0].side).toBe("string");
        expect(typeof pagesEnv.result!.pages[0].applied_parent_name).toBe("string");

        const exportEnv = await exportPdfTool.handler({ document_id: docEnv.result!.document_id, path: pdfPath });
        expect(exportEnv.ok).toBe(true);
        expect(existsSync(pdfPath)).toBe(true);
        expect(statSync(pdfPath).size).toBeGreaterThan(0);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    INTEGRATION_TIMEOUT_MS * 4,
  );
});
