import { afterEach, it, expect } from "vitest";
import { integrationGate, INTEGRATION_TIMEOUT_MS, closeAllDocuments } from "./helpers.js";
import { createDocumentTool } from "../../src/tools/create-document.js";
import { createTextFrameTool } from "../../src/tools/create-text-frame.js";
import { setTextTool } from "../../src/tools/set-text.js";

integrationGate("set_text (integration)", () => {
  afterEach(async () => {
    await closeAllDocuments();
  });

  it(
    "replaces text content in an existing frame",
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
        initial_text: "Old",
      });
      if (!frame.ok) return;

      const env = await setTextTool.handler({
        document_id: create.result!.document_id,
        frame_id: frame.result!.frame_id,
        text: "New body content here",
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.result?.character_count).toBe(21);
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
