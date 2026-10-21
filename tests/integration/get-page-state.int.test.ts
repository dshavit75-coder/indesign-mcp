import { afterEach, it, expect } from "vitest";
import { integrationGate, INTEGRATION_TIMEOUT_MS, closeAllDocuments } from "./helpers.js";
import { createDocumentTool } from "../../src/tools/create-document.js";
import { createTextFrameTool } from "../../src/tools/create-text-frame.js";
import { setTextTool } from "../../src/tools/set-text.js";
import { defineParagraphStyleTool } from "../../src/tools/define-paragraph-style.js";
import { applyParagraphStyleTool } from "../../src/tools/apply-paragraph-style.js";
import { getPageStateTool } from "../../src/tools/get-page-state.js";

integrationGate("get_page_state (integration)", () => {
  afterEach(async () => {
    await closeAllDocuments();
  });

  it(
    "reports an empty page when no frames have been added",
    async () => {
      const create = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      if (!create.ok) return;

      const env = await getPageStateTool.handler({
        document_id: create.result!.document_id,
        page_id: create.result!.page_ids[0],
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.result?.page_index).toBe(0);
      expect(env.result?.frames).toHaveLength(0);
      expect(env.result?.bounds_mm.width).toBe(210);
      expect(env.result?.bounds_mm.height).toBe(297);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "reports a styled text frame with style name and text snippet",
    async () => {
      const create = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      if (!create.ok) return;
      const pageId = create.result!.page_ids[0];

      const frame = await createTextFrameTool.handler({
        document_id: create.result!.document_id,
        page_id: pageId,
        bounds_mm: { x: 12, y: 12, width: 186, height: 50 },
      });
      if (!frame.ok) return;

      await setTextTool.handler({
        document_id: create.result!.document_id,
        frame_id: frame.result!.frame_id,
        text: "The quick brown fox jumps over the lazy dog.",
      });

      await defineParagraphStyleTool.handler({
        document_id: create.result!.document_id,
        name: "Body",
        size_pt: 11,
      });

      await applyParagraphStyleTool.handler({
        document_id: create.result!.document_id,
        frame_id: frame.result!.frame_id,
        style_name: "Body",
      });

      const env = await getPageStateTool.handler({ document_id: create.result!.document_id, page_id: pageId });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.result?.frames).toHaveLength(1);
      const f = env.result!.frames[0];
      expect(f.type).toBe("text");
      expect(f.paragraph_style_name).toBe("Body");
      expect(f.text_snippet).toContain("The quick brown fox");
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
