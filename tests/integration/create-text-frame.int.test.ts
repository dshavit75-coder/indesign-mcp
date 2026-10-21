import { afterEach, it, expect } from "vitest";
import { integrationGate, INTEGRATION_TIMEOUT_MS, closeAllDocuments } from "./helpers.js";
import { createDocumentTool } from "../../src/tools/create-document.js";
import { createTextFrameTool } from "../../src/tools/create-text-frame.js";

integrationGate("create_text_frame (integration)", () => {
  afterEach(async () => {
    await closeAllDocuments();
  });

  it(
    "creates a text frame on a fresh A4 page",
    async () => {
      const create = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      expect(create.ok).toBe(true);
      if (!create.ok) return;
      const pageId = create.result!.page_ids[0];

      const env = await createTextFrameTool.handler({
        document_id: create.result!.document_id,
        page_id: pageId,
        bounds_mm: { x: 12, y: 12, width: 186, height: 50 },
        initial_text: "Hello, world",
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(typeof env.result?.frame_id).toBe("string");
      expect(env.result?.page_id).toBe(pageId);
      expect(env.document_state_delta?.new_frames?.[0].id).toBe(env.result?.frame_id);
      expect(env.document_state_delta?.new_frames?.[0].type).toBe("text");
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "returns not_found for a missing page",
    async () => {
      const create2 = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      if (!create2.ok) return;

      const env = await createTextFrameTool.handler({
        document_id: create2.result!.document_id,
        page_id: "999999",
        bounds_mm: { x: 10, y: 10, width: 100, height: 50 },
      });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.kind).toBe("not_found");
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
