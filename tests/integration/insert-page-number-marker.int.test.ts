import { afterEach, it, expect } from "vitest";
import { integrationGate, INTEGRATION_TIMEOUT_MS, closeAllDocuments } from "./helpers.js";
import { createDocumentTool } from "../../src/tools/create-document.js";
import { createParentPageTool } from "../../src/tools/create-parent-page.js";
import { createTextFrameTool } from "../../src/tools/create-text-frame.js";
import { insertPageNumberMarkerTool } from "../../src/tools/insert-page-number-marker.js";

integrationGate("insert_page_number_marker (integration)", () => {
  afterEach(async () => {
    await closeAllDocuments();
  });

  it(
    "inserts an AUTO_PAGE_NUMBER marker at the end of a text frame on a master page",
    async () => {
      const createDoc = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      expect(createDoc.ok).toBe(true);
      if (!createDoc.ok) return;

      const createParent = await createParentPageTool.handler({
        document_id: createDoc.result!.document_id,
        base_name: "Footer",
      });
      expect(createParent.ok).toBe(true);
      if (!createParent.ok) return;
      const masterPageId = createParent.result!.page_ids[0];

      const createFrame = await createTextFrameTool.handler({
        document_id: createDoc.result!.document_id,
        page_id: masterPageId,
        bounds_mm: { x: 10, y: 275, width: 190, height: 10 },
      });
      expect(createFrame.ok).toBe(true);
      if (!createFrame.ok) return;
      const frameId = createFrame.result!.frame_id;

      const env = await insertPageNumberMarkerTool.handler({
        document_id: createDoc.result!.document_id,
        frame_id: frameId,
        position: "end",
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.result?.frame_id).toBe(frameId);
      expect(env.result?.inserted_at).toBe("end");
      expect(env.document_state_delta?.changed_frames?.[0].id).toBe(frameId);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "inserts at start when position is start",
    async () => {
      const createDoc2 = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      if (!createDoc2.ok) return;

      const createParent = await createParentPageTool.handler({
        document_id: createDoc2.result!.document_id,
        base_name: "Header",
      });
      if (!createParent.ok) return;
      const masterPageId = createParent.result!.page_ids[0];

      const createFrame = await createTextFrameTool.handler({
        document_id: createDoc2.result!.document_id,
        page_id: masterPageId,
        bounds_mm: { x: 10, y: 5, width: 190, height: 10 },
      });
      if (!createFrame.ok) return;
      const frameId = createFrame.result!.frame_id;

      const env = await insertPageNumberMarkerTool.handler({
        document_id: createDoc2.result!.document_id,
        frame_id: frameId,
        position: "start",
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.result?.inserted_at).toBe("start");
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "returns not_found for a non-existent frame_id",
    async () => {
      const createDoc3 = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      if (!createDoc3.ok) return;

      const env = await insertPageNumberMarkerTool.handler({
        document_id: createDoc3.result!.document_id,
        frame_id: "999999999",
      });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.kind).toBe("not_found");
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
