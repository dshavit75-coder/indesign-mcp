import { afterEach, it, expect } from "vitest";
import { integrationGate, INTEGRATION_TIMEOUT_MS, closeAllDocuments } from "./helpers.js";
import { createDocumentTool } from "../../src/tools/create-document.js";
import { createImageFrameTool } from "../../src/tools/create-image-frame.js";

integrationGate("create_image_frame (integration)", () => {
  afterEach(async () => {
    await closeAllDocuments();
  });

  it(
    "creates an image-receptive rectangle on a fresh A4 page",
    async () => {
      const create = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      if (!create.ok) return;

      const env = await createImageFrameTool.handler({
        document_id: create.result!.document_id,
        page_id: create.result!.page_ids[0],
        bounds_mm: { x: 12, y: 12, width: 100, height: 60 },
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(typeof env.result?.frame_id).toBe("string");
      expect(env.document_state_delta?.new_frames?.[0].type).toBe("rectangle");
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
