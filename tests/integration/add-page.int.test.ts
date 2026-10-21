import { afterEach, it, expect } from "vitest";
import { integrationGate, INTEGRATION_TIMEOUT_MS, closeAllDocuments } from "./helpers.js";
import { createDocumentTool } from "../../src/tools/create-document.js";
import { addPageTool } from "../../src/tools/add-page.js";

integrationGate("add_page (integration)", () => {
  afterEach(async () => {
    await closeAllDocuments();
  });

  it(
    "appends a page to a fresh A4 document",
    async () => {
      const create = await createDocumentTool.handler({
        preset: "A4",
        pages: 1,
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      expect(create.ok).toBe(true);
      if (!create.ok) return;

      const add = await addPageTool.handler({ document_id: create.result!.document_id });
      expect(add.ok).toBe(true);
      if (!add.ok) return;
      expect(add.document_state_delta?.page_count).toBe(2);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "inserts a page after a specific page id",
    async () => {
      const create = await createDocumentTool.handler({
        preset: "A4",
        pages: 2,
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      expect(create.ok).toBe(true);
      if (!create.ok) return;
      const firstPage = create.result!.page_ids[0];

      const add = await addPageTool.handler({ document_id: create.result!.document_id, at: { after_page_id: firstPage } });
      expect(add.ok).toBe(true);
      if (!add.ok) return;
      expect(add.result?.position_index).toBe(1);
      expect(add.document_state_delta?.page_count).toBe(3);
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
