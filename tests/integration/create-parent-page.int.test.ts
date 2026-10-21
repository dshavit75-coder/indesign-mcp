import { afterEach, it, expect } from "vitest";
import { integrationGate, INTEGRATION_TIMEOUT_MS, closeAllDocuments } from "./helpers.js";
import { createDocumentTool } from "../../src/tools/create-document.js";
import { createParentPageTool } from "../../src/tools/create-parent-page.js";

integrationGate("create_parent_page (integration)", () => {
  afterEach(async () => {
    await closeAllDocuments();
  });

  it(
    "creates a master spread in a fresh A4 document",
    async () => {
      const create = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      expect(create.ok).toBe(true);
      if (!create.ok) return;

      const env = await createParentPageTool.handler({ document_id: create.result!.document_id, base_name: "Footer" });
      expect(env.ok).toBe(true);
      if (!env.ok) return;

      // InDesign auto-assigns the first available prefix; "A" is taken by
      // the default "[None]" spread, so the first custom one is typically "A"
      // or "B" depending on the version. Accept any single-letter prefix.
      expect(env.result?.parent_name).toMatch(/^[A-Z]-Footer$/);
      expect(Array.isArray(env.result?.page_ids)).toBe(true);
      expect(env.result?.page_ids.length).toBeGreaterThanOrEqual(1);
      expect(env.document_state_delta?.new_parent_spreads?.[0].name).toMatch(/Footer/);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "creates a master spread with an explicit name_prefix",
    async () => {
      const create2 = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      if (!create2.ok) return;

      const env = await createParentPageTool.handler({
        document_id: create2.result!.document_id,
        base_name: "Chapter",
        name_prefix: "C",
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      // May be "C-Chapter" if C is free; InDesign may adjust if C is taken.
      expect(env.result?.parent_name).toContain("Chapter");
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
