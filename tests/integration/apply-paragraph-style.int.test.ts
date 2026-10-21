import { afterEach, it, expect } from "vitest";
import { integrationGate, INTEGRATION_TIMEOUT_MS, closeAllDocuments } from "./helpers.js";
import { createDocumentTool } from "../../src/tools/create-document.js";
import { createTextFrameTool } from "../../src/tools/create-text-frame.js";
import { setTextTool } from "../../src/tools/set-text.js";
import { defineParagraphStyleTool } from "../../src/tools/define-paragraph-style.js";
import { applyParagraphStyleTool } from "../../src/tools/apply-paragraph-style.js";

integrationGate("apply_paragraph_style (integration)", () => {
  afterEach(async () => {
    await closeAllDocuments();
  });

  it(
    "applies a defined style to a frame with text",
    async () => {
      const create = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      if (!create.ok) return;

      const frame = await createTextFrameTool.handler({
        document_id: create.result!.document_id,
        page_id: create.result!.page_ids[0],
        bounds_mm: { x: 12, y: 12, width: 186, height: 100 },
      });
      if (!frame.ok) return;

      await setTextTool.handler({
        document_id: create.result!.document_id,
        frame_id: frame.result!.frame_id,
        text: "First paragraph.\nSecond paragraph.\nThird paragraph.",
      });

      await defineParagraphStyleTool.handler({
        document_id: create.result!.document_id,
        name: "Body",
        size_pt: 11,
        leading_pt: 14,
      });

      const env = await applyParagraphStyleTool.handler({
        document_id: create.result!.document_id,
        frame_id: frame.result!.frame_id,
        style_name: "Body",
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.result?.affected_paragraphs).toBe(3);
      expect(env.document_state_delta?.changed_frames?.[0].applied_paragraph_style).toBe("Body");
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "returns not_found for a missing style",
    async () => {
      const create = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      if (!create.ok) return;

      const frame = await createTextFrameTool.handler({
        document_id: create.result!.document_id,
        page_id: create.result!.page_ids[0],
        bounds_mm: { x: 12, y: 12, width: 186, height: 50 },
      });
      if (!frame.ok) return;

      const env = await applyParagraphStyleTool.handler({
        document_id: create.result!.document_id,
        frame_id: frame.result!.frame_id,
        style_name: "DoesNotExist",
      });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.kind).toBe("not_found");
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
