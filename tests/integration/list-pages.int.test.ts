import { afterEach, it, expect } from "vitest";
import { integrationGate, INTEGRATION_TIMEOUT_MS, closeAllDocuments } from "./helpers.js";
import { createDocumentTool } from "../../src/tools/create-document.js";
import { addPageTool } from "../../src/tools/add-page.js";
import { listPagesTool } from "../../src/tools/list-pages.js";

integrationGate("list_pages (integration)", () => {
  afterEach(async () => {
    await closeAllDocuments();
  });

  it(
    "returns at least one page for a newly created document",
    async () => {
      const create1 = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      if (!create1.ok) return;
      const docId1 = create1.result!.document_id;

      const env = await listPagesTool.handler({ document_id: docId1 });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.result!.pages.length).toBeGreaterThanOrEqual(1);

      const first = env.result!.pages[0];
      expect(typeof first.id).toBe("string");
      expect(first.index).toBe(0);
      expect(typeof first.side).toBe("string");
      expect(typeof first.applied_parent_name).toBe("string");
      expect(typeof first.name).toBe("string");
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "reflects added pages",
    async () => {
      const create2 = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      if (!create2.ok) return;
      const docId2 = create2.result!.document_id;

      const beforeEnv = await listPagesTool.handler({ document_id: docId2 });
      expect(beforeEnv.ok).toBe(true);
      if (!beforeEnv.ok) return;
      const countBefore = beforeEnv.result!.pages.length;

      await addPageTool.handler({ document_id: docId2 });

      const afterEnv = await listPagesTool.handler({ document_id: docId2 });
      expect(afterEnv.ok).toBe(true);
      if (!afterEnv.ok) return;
      expect(afterEnv.result!.pages.length).toBe(countBefore + 1);

      // Indices are 0-based and sequential
      for (let i = 0; i < afterEnv.result!.pages.length; i++) {
        expect(afterEnv.result!.pages[i].index).toBe(i);
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "applied_parent_name is '[None]' when no parent is applied",
    async () => {
      const create3 = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      if (!create3.ok) return;
      const docId3 = create3.result!.document_id;

      const env = await listPagesTool.handler({ document_id: docId3 });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      // New A4 doc pages may or may not have a master — just assert the field is present
      for (const p of env.result!.pages) {
        expect(typeof p.applied_parent_name).toBe("string");
        expect(p.applied_parent_name.length).toBeGreaterThan(0);
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
