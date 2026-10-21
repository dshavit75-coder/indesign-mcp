import { afterEach, it, expect } from "vitest";
import { integrationGate, INTEGRATION_TIMEOUT_MS, closeAllDocuments } from "./helpers.js";
import { createDocumentTool } from "../../src/tools/create-document.js";
import { defineCharacterStyleTool } from "../../src/tools/define-character-style.js";

integrationGate("define_character_style (integration)", () => {
  afterEach(async () => {
    await closeAllDocuments();
  });

  it(
    "creates a character style with font_family",
    async () => {
      const create1 = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      if (!create1.ok) return;
      const docId1 = create1.result!.document_id;

      const env = await defineCharacterStyleTool.handler({
        document_id: docId1,
        name: "Emphasis",
        font_family: "Helvetica Neue",
        font_style: "Italic",
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.result?.character_style_name).toBe("Emphasis");
      expect(env.result?.on_collision_outcome).toBe("created");
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "creates a character style with fill_hex, returns fill_swatch_id",
    async () => {
      const create2 = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      if (!create2.ok) return;
      const docId2 = create2.result!.document_id;

      const env = await defineCharacterStyleTool.handler({
        document_id: docId2,
        name: "Accent",
        fill_hex: "#FF6600",
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.result?.character_style_name).toBe("Accent");
      expect(typeof env.result?.fill_swatch_id).toBe("string");
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

      const first = await defineCharacterStyleTool.handler({
        document_id: docId3,
        name: "Accent",
        fill_hex: "#FF0000",
      });
      expect(first.ok).toBe(true);

      const second = await defineCharacterStyleTool.handler({
        document_id: docId3,
        name: "Accent",
        fill_hex: "#0000FF",
        on_collision: "error",
      });
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.error.kind).toBe("name_collision");
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "on_collision 'update' modifies the existing style without creating a new one",
    async () => {
      const create4 = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      if (!create4.ok) return;
      const docId4 = create4.result!.document_id;

      await defineCharacterStyleTool.handler({
        document_id: docId4,
        name: "Accent",
        fill_hex: "#FF0000",
      });

      const env = await defineCharacterStyleTool.handler({
        document_id: docId4,
        name: "Accent",
        fill_hex: "#0000FF",
        on_collision: "update",
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.result?.character_style_name).toBe("Accent");
      expect(env.result?.on_collision_outcome).toBe("updated");
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "on_collision 'version' creates 'Accent 2' when 'Accent' exists",
    async () => {
      const create5 = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      if (!create5.ok) return;
      const docId5 = create5.result!.document_id;

      await defineCharacterStyleTool.handler({
        document_id: docId5,
        name: "Accent",
        fill_hex: "#FF0000",
      });

      const env = await defineCharacterStyleTool.handler({
        document_id: docId5,
        name: "Accent",
        fill_hex: "#0000FF",
        on_collision: "version",
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.result?.character_style_name).toBe("Accent 2");
      expect(env.result?.on_collision_outcome).toBe("versioned");
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
