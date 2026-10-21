import { afterEach, it, expect } from "vitest";
import { integrationGate, INTEGRATION_TIMEOUT_MS, closeAllDocuments } from "./helpers.js";
import { createDocumentTool } from "../../src/tools/create-document.js";
import { createLineTool } from "../../src/tools/create-line.js";

integrationGate("create_line (integration)", () => {
  afterEach(async () => {
    await closeAllDocuments();
  });

  it(
    "creates a horizontal rule across the top of an A4 page",
    async () => {
      const create = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      if (!create.ok) return;

      const env = await createLineTool.handler({
        document_id: create.result!.document_id,
        page_id: create.result!.page_ids[0],
        start_mm: { x: 12, y: 12 },
        end_mm: { x: 198, y: 12 },
        stroke_hex: "#333333",
        stroke_weight_pt: 0.75,
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(typeof env.result?.frame_id).toBe("string");
      expect(typeof env.result?.stroke_swatch_id).toBe("string");
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
