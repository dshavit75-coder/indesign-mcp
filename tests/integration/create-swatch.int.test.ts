import { afterEach, it, expect } from "vitest";
import { integrationGate, INTEGRATION_TIMEOUT_MS, closeAllDocuments } from "./helpers.js";
import { createDocumentTool } from "../../src/tools/create-document.js";
import { createSwatchTool } from "../../src/tools/create-swatch.js";

integrationGate("create_swatch (integration)", () => {
  afterEach(async () => {
    await closeAllDocuments();
  });

  it(
    "creates a named swatch and returns swatch_id",
    async () => {
      const create = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      if (!create.ok) return;
      const docId = create.result!.document_id;

      const env = await createSwatchTool.handler({ document_id: docId, name: "Brand Orange", hex: "#FF6600" });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.result?.swatch_name).toBe("Brand Orange");
      expect(typeof env.result?.swatch_id).toBe("string");
      expect(env.result?.on_collision_outcome).toBe("created");
      expect(env.document_state_delta?.new_swatches).toEqual([{ name: "Brand Orange" }]);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "name_collision when swatch exists and on_collision is 'error'",
    async () => {
      const create = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      if (!create.ok) return;
      const docId = create.result!.document_id;

      await createSwatchTool.handler({ document_id: docId, name: "Brand Orange", hex: "#FF6600" });

      const second = await createSwatchTool.handler({
        document_id: docId,
        name: "Brand Orange",
        hex: "#0000FF",
        on_collision: "error",
      });
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.error.kind).toBe("name_collision");
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "on_collision 'update' modifies the existing swatch RGB values",
    async () => {
      const create = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      if (!create.ok) return;
      const docId = create.result!.document_id;

      await createSwatchTool.handler({ document_id: docId, name: "Brand Orange", hex: "#FF6600" });

      const env = await createSwatchTool.handler({
        document_id: docId,
        name: "Brand Orange",
        hex: "#0000FF",
        on_collision: "update",
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.result?.swatch_name).toBe("Brand Orange");
      expect(env.result?.on_collision_outcome).toBe("updated");
      expect(env.document_state_delta).toBeUndefined();
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "on_collision 'version' creates 'Brand Orange 2' when 'Brand Orange' exists",
    async () => {
      const create = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      if (!create.ok) return;
      const docId = create.result!.document_id;

      await createSwatchTool.handler({ document_id: docId, name: "Brand Orange", hex: "#FF6600" });

      const env = await createSwatchTool.handler({
        document_id: docId,
        name: "Brand Orange",
        hex: "#0000FF",
        on_collision: "version",
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.result?.swatch_name).toBe("Brand Orange 2");
      expect(env.result?.on_collision_outcome).toBe("versioned");
      expect(env.document_state_delta?.new_swatches).toEqual([{ name: "Brand Orange 2" }]);
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
