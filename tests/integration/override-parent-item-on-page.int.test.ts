import { afterEach, it, expect } from "vitest";
import { integrationGate, INTEGRATION_TIMEOUT_MS, closeAllDocuments } from "./helpers.js";
import { createDocumentTool } from "../../src/tools/create-document.js";
import { createParentPageTool } from "../../src/tools/create-parent-page.js";
import { createTextFrameTool } from "../../src/tools/create-text-frame.js";
import { applyParentToPageTool } from "../../src/tools/apply-parent-to-page.js";
import { overrideParentItemOnPageTool } from "../../src/tools/override-parent-item-on-page.js";

integrationGate("override_parent_item_on_page (integration)", () => {
  afterEach(async () => {
    await closeAllDocuments();
  });

  it(
    "overrides a master text frame onto a document page",
    async () => {
      // 1. Create doc
      const createDoc = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      expect(createDoc.ok).toBe(true);
      if (!createDoc.ok) return;
      const docPageId = createDoc.result!.page_ids[0];

      // 2. Create parent page
      const createParent = await createParentPageTool.handler({
        document_id: createDoc.result!.document_id,
        base_name: "TestMaster",
      });
      expect(createParent.ok).toBe(true);
      if (!createParent.ok) return;
      const masterPageId = createParent.result!.page_ids[0];
      const parentName = createParent.result!.parent_name;

      // 3. Add a text frame to the master page
      const createFrame = await createTextFrameTool.handler({
        document_id: createDoc.result!.document_id,
        page_id: masterPageId,
        bounds_mm: { x: 10, y: 270, width: 190, height: 15 },
      });
      expect(createFrame.ok).toBe(true);
      if (!createFrame.ok) return;
      const masterFrameId = createFrame.result!.frame_id;

      // 4. Apply the parent to the doc page
      const applyEnv = await applyParentToPageTool.handler({
        document_id: createDoc.result!.document_id,
        page_id: docPageId,
        parent_name: parentName,
      });
      expect(applyEnv.ok).toBe(true);

      // 5. Override the master frame onto the doc page
      const env = await overrideParentItemOnPageTool.handler({
        document_id: createDoc.result!.document_id,
        page_id: docPageId,
        parent_item_id: masterFrameId,
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(typeof env.result?.overridden_frame_id).toBe("string");
      expect(env.result?.overridden_frame_id).not.toBe(masterFrameId);
      expect(env.document_state_delta?.new_frames?.[0].type).toBe("text");
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
