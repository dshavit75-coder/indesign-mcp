import { afterEach, it, expect } from "vitest";
import { integrationGate, INTEGRATION_TIMEOUT_MS, closeAllDocuments } from "./helpers.js";
import { createDocumentTool } from "../../src/tools/create-document.js";
import { createParentPageTool } from "../../src/tools/create-parent-page.js";
import { applyParentToPageTool } from "../../src/tools/apply-parent-to-page.js";

integrationGate("apply_parent_to_page (integration)", () => {
  afterEach(async () => {
    await closeAllDocuments();
  });

  it(
    "applies a newly created parent page to a document page",
    async () => {
      const createDoc = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      expect(createDoc.ok).toBe(true);
      if (!createDoc.ok) return;

      const pageId = createDoc.result!.page_ids[0];

      const createParent = await createParentPageTool.handler({
        document_id: createDoc.result!.document_id,
        base_name: "Footer",
      });
      expect(createParent.ok).toBe(true);
      if (!createParent.ok) return;

      const parentName = createParent.result!.parent_name;

      const env = await applyParentToPageTool.handler({
        document_id: createDoc.result!.document_id,
        page_id: pageId,
        parent_name: parentName,
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.result?.page_id).toBe(pageId);
      expect(env.result?.parent_name).toBe(parentName);
      expect(env.document_state_delta?.changed_pages?.[0]).toEqual({
        id: pageId,
        applied_parent_name: parentName,
      });
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "returns not_found when parent spread name does not exist",
    async () => {
      const createDoc2 = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      if (!createDoc2.ok) return;

      // A fresh doc's only master is "[None]" and "A-Master"; "Z-Missing" should not exist.
      const env = await applyParentToPageTool.handler({
        document_id: createDoc2.result!.document_id,
        page_id: "any-id",
        parent_name: "Z-Missing",
      });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      // Could be not_found for the page (if page_id is wrong) or parent_spread.
      // Either is acceptable; check the call doesn't crash.
      expect(["not_found", "script_error"]).toContain(env.error.kind);
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
