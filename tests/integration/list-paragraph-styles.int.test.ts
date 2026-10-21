import { afterEach, it, expect } from "vitest";
import { integrationGate, INTEGRATION_TIMEOUT_MS, closeAllDocuments } from "./helpers.js";
import { createDocumentTool } from "../../src/tools/create-document.js";
import { defineParagraphStyleTool } from "../../src/tools/define-paragraph-style.js";
import { listParagraphStylesTool } from "../../src/tools/list-paragraph-styles.js";

integrationGate("list_paragraph_styles (integration)", () => {
  afterEach(async () => {
    await closeAllDocuments();
  });

  it(
    "returns defined styles, excludes internal [ styles",
    async () => {
      const create1 = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      if (!create1.ok) return;
      const docId1 = create1.result!.document_id;

      await defineParagraphStyleTool.handler({ document_id: docId1, name: "Body", size_pt: 11, leading_pt: 14 });
      await defineParagraphStyleTool.handler({ document_id: docId1, name: "Headline", size_pt: 36 });

      const env = await listParagraphStylesTool.handler({ document_id: docId1 });
      expect(env.ok).toBe(true);
      if (!env.ok) return;

      const styles = env.result!.paragraph_styles;
      // Must not contain internal styles
      for (const s of styles) {
        expect(s.name.charAt(0)).not.toBe("[");
      }

      const bodyStyle = styles.find((s) => s.name === "Body");
      expect(bodyStyle).toBeDefined();
      expect(bodyStyle!.point_size).toBeCloseTo(11, 1);
      expect(bodyStyle!.leading_pt).toBeCloseTo(14, 1);

      const headlineStyle = styles.find((s) => s.name === "Headline");
      expect(headlineStyle).toBeDefined();
      expect(headlineStyle!.point_size).toBeCloseTo(36, 1);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "returns color_swatch_name when style has a fill colour",
    async () => {
      const create2 = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      if (!create2.ok) return;
      const docId2 = create2.result!.document_id;

      await defineParagraphStyleTool.handler({
        document_id: docId2,
        name: "Coloured",
        size_pt: 12,
        color_hex: "#FF6600",
      });

      const env = await listParagraphStylesTool.handler({ document_id: docId2 });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      const coloured = env.result!.paragraph_styles.find((s) => s.name === "Coloured");
      expect(coloured).toBeDefined();
      expect(typeof coloured!.color_swatch_name).toBe("string");
      expect(coloured!.color_swatch_name!.length).toBeGreaterThan(0);
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
