import { afterEach, it, expect } from "vitest";
import { mkdtempSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { integrationGate, INTEGRATION_TIMEOUT_MS, closeAllDocuments } from "./helpers.js";
import { createDocumentTool } from "../../src/tools/create-document.js";
import { createTextFrameTool } from "../../src/tools/create-text-frame.js";
import { setTextTool } from "../../src/tools/set-text.js";
import { defineParagraphStyleTool } from "../../src/tools/define-paragraph-style.js";
import { applyParagraphStyleTool } from "../../src/tools/apply-paragraph-style.js";
import { defineCharacterStyleTool } from "../../src/tools/define-character-style.js";
import { applyCharacterStyleToRangeTool } from "../../src/tools/apply-character-style-to-range.js";
import { setTextInRangeTool } from "../../src/tools/set-text-in-range.js";
import { exportPdfTool } from "../../src/tools/export-pdf.js";

integrationGate("Plan B5 end-to-end (integration)", () => {
  afterEach(async () => {
    await closeAllDocuments();
  });

  it(
    "creates stat pill text, applies character style to numeral, replaces word, exports PDF",
    async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "indesign-mcp-b5-"));
      const pdfPath = join(tmpDir, "b5-smoke.pdf");

      try {
        const createDoc = await createDocumentTool.handler({
          preset: "A4",
          margins_mm: { top: 20, bottom: 20, left: 20, right: 20 },
        });
        expect(createDoc.ok).toBe(true);
        if (!createDoc.ok) return;
        const pageId = createDoc.result!.page_ids[0];

        const bodyStyle = await defineParagraphStyleTool.handler({
          document_id: createDoc.result!.document_id,
          name: "Body",
          size_pt: 12,
          leading_pt: 16,
          alignment: "left",
        });
        expect(bodyStyle.ok).toBe(true);

        const accentStyle = await defineCharacterStyleTool.handler({
          document_id: createDoc.result!.document_id,
          name: "Accent",
          fill_hex: "#FF6600",
        });
        expect(accentStyle.ok).toBe(true);
        if (!accentStyle.ok) return;
        expect(accentStyle.result?.character_style_name).toBe("Accent");
        expect(accentStyle.result?.on_collision_outcome).toBe("created");
        expect(accentStyle.document_state_delta?.new_character_styles).toEqual([{ name: "Accent" }]);

        const frameEnv = await createTextFrameTool.handler({
          document_id: createDoc.result!.document_id,
          page_id: pageId,
          bounds_mm: { x: 20, y: 40, width: 170, height: 30 },
        });
        expect(frameEnv.ok).toBe(true);
        if (!frameEnv.ok) return;
        const frameId = frameEnv.result!.frame_id;

        // "Total displaced: 1.5M people" — 28 visible chars
        const setTextEnv = await setTextTool.handler({
          document_id: createDoc.result!.document_id,
          frame_id: frameId,
          text: "Total displaced: 1.5M people",
        });
        expect(setTextEnv.ok).toBe(true);

        const applyBody = await applyParagraphStyleTool.handler({
          document_id: createDoc.result!.document_id,
          frame_id: frameId,
          style_name: "Body",
        });
        expect(applyBody.ok).toBe(true);

        // "Total displaced: " = 17 chars; "1.5M" = chars 17..20 inclusive = end_index 21 exclusive.
        const applyAccent = await applyCharacterStyleToRangeTool.handler({
          document_id: createDoc.result!.document_id,
          frame_id: frameId,
          character_style_name: "Accent",
          start_index: 17,
          end_index: 21,
        });
        expect(applyAccent.ok).toBe(true);
        if (!applyAccent.ok) return;
        expect(applyAccent.result?.applied_chars).toBe(4);
        const accentDelta = applyAccent.document_state_delta?.changed_frames?.find(
          (f) => f.id === frameId,
        );
        expect(accentDelta).toBeDefined();
        expect(accentDelta!.applied_character_style_range?.character_style_name).toBe("Accent");
        expect(accentDelta!.applied_character_style_range?.start_index).toBe(17);
        expect(accentDelta!.applied_character_style_range?.end_index).toBe(21);

        // Replace "people" (chars 22..27 inclusive, end_index 28 exclusive) with "individuals".
        const replaceEnv = await setTextInRangeTool.handler({
          document_id: createDoc.result!.document_id,
          frame_id: frameId,
          start_index: 22,
          end_index: 28,
          text: "individuals",
        });
        expect(replaceEnv.ok).toBe(true);
        if (!replaceEnv.ok) return;
        expect(replaceEnv.result?.removed_chars).toBe(6);
        expect(replaceEnv.result?.inserted_chars).toBe(11);
        // Final visible content: "Total displaced: 1.5M individuals" = 33 chars.
        // InDesign's Story.length may include a trailing CR (= 34) or not. Accept both.
        expect(replaceEnv.result?.total_length_after).toBeGreaterThanOrEqual(33);
        expect(replaceEnv.result?.total_length_after).toBeLessThanOrEqual(34);

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
