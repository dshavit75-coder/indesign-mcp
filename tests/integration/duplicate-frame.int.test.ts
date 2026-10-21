import { afterEach, it, expect } from "vitest";
import { integrationGate, INTEGRATION_TIMEOUT_MS, closeAllDocuments } from "./helpers.js";
import { createDocumentTool } from "../../src/tools/create-document.js";
import { createTextFrameTool } from "../../src/tools/create-text-frame.js";
import { duplicateFrameTool } from "../../src/tools/duplicate-frame.js";

integrationGate("duplicate_frame (integration)", () => {
  afterEach(async () => {
    await closeAllDocuments();
  });

  it(
    "duplicates a text frame and returns a new frame_id",
    async () => {
      const docEnv = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 20, bottom: 20, left: 20, right: 20 },
      });
      expect(docEnv.ok).toBe(true);
      if (!docEnv.ok) return;
      const pageId = docEnv.result!.page_ids[0];

      const frameEnv = await createTextFrameTool.handler({
        document_id: docEnv.result!.document_id,
        page_id: pageId,
        bounds_mm: { x: 20, y: 20, width: 80, height: 40 },
      });
      expect(frameEnv.ok).toBe(true);
      if (!frameEnv.ok) return;
      const sourceId = frameEnv.result!.frame_id;

      const dupEnv = await duplicateFrameTool.handler({ document_id: docEnv.result!.document_id, frame_id: sourceId });
      expect(dupEnv.ok).toBe(true);
      if (!dupEnv.ok) return;
      expect(dupEnv.result?.source_frame_id).toBe(sourceId);
      expect(typeof dupEnv.result?.duplicate_frame_id).toBe("string");
      expect(dupEnv.result?.duplicate_frame_id).not.toBe(sourceId);
      expect(dupEnv.result?.duplicate_type).toBe("text");
      expect(dupEnv.document_state_delta?.new_frames?.[0].id).toBe(
        dupEnv.result?.duplicate_frame_id,
      );
      expect(dupEnv.document_state_delta?.new_frames?.[0].type).toBe("text");
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "duplicates with offset — duplicate is at a different position",
    async () => {
      const docEnv = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 20, bottom: 20, left: 20, right: 20 },
      });
      expect(docEnv.ok).toBe(true);
      if (!docEnv.ok) return;
      const pageId = docEnv.result!.page_ids[0];

      const frameEnv = await createTextFrameTool.handler({
        document_id: docEnv.result!.document_id,
        page_id: pageId,
        bounds_mm: { x: 20, y: 20, width: 80, height: 40 },
      });
      expect(frameEnv.ok).toBe(true);
      if (!frameEnv.ok) return;
      const sourceId = frameEnv.result!.frame_id;

      const dupEnv = await duplicateFrameTool.handler({
        document_id: docEnv.result!.document_id,
        frame_id: sourceId,
        offset_mm: { x: 0, y: 50 },
      });
      expect(dupEnv.ok).toBe(true);
      if (!dupEnv.ok) return;
      expect(dupEnv.result?.duplicate_frame_id).not.toBe(sourceId);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "not_found when frame_id is invalid",
    async () => {
      const create3 = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 20, bottom: 20, left: 20, right: 20 },
      });
      if (!create3.ok) return;

      const env = await duplicateFrameTool.handler({ document_id: create3.result!.document_id, frame_id: "nonexistent-999" });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.kind).toBe("not_found");
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
