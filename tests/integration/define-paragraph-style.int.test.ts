import { afterEach, it, expect } from "vitest";
import { integrationGate, INTEGRATION_TIMEOUT_MS, closeAllDocuments } from "./helpers.js";
import { createDocumentTool } from "../../src/tools/create-document.js";
import { defineParagraphStyleTool } from "../../src/tools/define-paragraph-style.js";

integrationGate("define_paragraph_style (integration)", () => {
  afterEach(async () => {
    await closeAllDocuments();
  });

  it(
    "creates a basic paragraph style",
    async () => {
      const create1 = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      if (!create1.ok) return;
      const docId1 = create1.result!.document_id;

      const env = await defineParagraphStyleTool.handler({
        document_id: docId1,
        name: "Body",
        size_pt: 11,
        leading_pt: 14,
        alignment: "left",
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.result?.name).toBe("Body");
      expect(typeof env.result?.style_id).toBe("string");
      expect(env.result?.on_collision_outcome).toBe("created");
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "creates a paragraph style with color, returns swatch_id",
    async () => {
      const create2 = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      if (!create2.ok) return;
      const docId2 = create2.result!.document_id;

      const env = await defineParagraphStyleTool.handler({
        document_id: docId2,
        name: "Headline",
        size_pt: 36,
        color_hex: "#FF6600",
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(typeof env.result?.swatch_id).toBe("string");
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "name_collision when style exists and on_collision is 'error'",
    async () => {
      const create3 = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      if (!create3.ok) return;
      const docId3 = create3.result!.document_id;

      const first = await defineParagraphStyleTool.handler({ document_id: docId3, name: "Body" });
      expect(first.ok).toBe(true);

      const second = await defineParagraphStyleTool.handler({
        document_id: docId3,
        name: "Body",
        on_collision: "error",
      });
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.error.kind).toBe("name_collision");
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "on_collision 'version' creates 'Body 2' when 'Body' exists",
    async () => {
      const create4 = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      if (!create4.ok) return;
      const docId4 = create4.result!.document_id;

      const first = await defineParagraphStyleTool.handler({ document_id: docId4, name: "Body" });
      expect(first.ok).toBe(true);

      const second = await defineParagraphStyleTool.handler({
        document_id: docId4,
        name: "Body",
        on_collision: "version",
      });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.result?.name).toBe("Body 2");
      expect(second.result?.on_collision_outcome).toBe("versioned");
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
