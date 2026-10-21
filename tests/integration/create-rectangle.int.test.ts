import { afterEach, it, expect } from "vitest";
import { integrationGate, INTEGRATION_TIMEOUT_MS, closeAllDocuments } from "./helpers.js";
import { createDocumentTool } from "../../src/tools/create-document.js";
import { createRectangleTool } from "../../src/tools/create-rectangle.js";

integrationGate("create_rectangle (integration)", () => {
  afterEach(async () => {
    await closeAllDocuments();
  });

  it(
    "creates a basic rectangle",
    async () => {
      const create = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      if (!create.ok) return;

      const env = await createRectangleTool.handler({
        document_id: create.result!.document_id,
        page_id: create.result!.page_ids[0],
        bounds_mm: { x: 12, y: 12, width: 100, height: 50 },
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(typeof env.result?.frame_id).toBe("string");
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "creates a filled, stroked, rounded rectangle",
    async () => {
      const create = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      if (!create.ok) return;

      const env = await createRectangleTool.handler({
        document_id: create.result!.document_id,
        page_id: create.result!.page_ids[0],
        bounds_mm: { x: 12, y: 12, width: 100, height: 30 },
        fill_hex: "#FF6600",
        stroke_hex: "#000000",
        stroke_weight_pt: 1,
        corner_radius_mm: 4,
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(typeof env.result?.fill_swatch_id).toBe("string");
      expect(typeof env.result?.stroke_swatch_id).toBe("string");
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
