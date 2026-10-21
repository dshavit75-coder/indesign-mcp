import { afterEach, it, expect } from "vitest";
import { integrationGate, INTEGRATION_TIMEOUT_MS, closeAllDocuments } from "./helpers.js";
import { createDocumentTool } from "../../src/tools/create-document.js";
import { createTextFrameTool } from "../../src/tools/create-text-frame.js";
import { setTextTool } from "../../src/tools/set-text.js";
import { defineCharacterStyleTool } from "../../src/tools/define-character-style.js";
import { applyCharacterStyleToRangeTool } from "../../src/tools/apply-character-style-to-range.js";

integrationGate("apply_character_style_to_range (integration)", () => {
  afterEach(async () => {
    await closeAllDocuments();
  });

  it(
    "applies a character style to a mid-word range",
    async () => {
      const doc = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      expect(doc.ok).toBe(true);
      if (!doc.ok) return;

      const frame = await createTextFrameTool.handler({
        document_id: doc.result!.document_id,
        page_id: doc.result!.page_ids[0],
        bounds_mm: { x: 12, y: 12, width: 186, height: 50 },
      });
      expect(frame.ok).toBe(true);
      if (!frame.ok) return;

      await setTextTool.handler({
        document_id: doc.result!.document_id,
        frame_id: frame.result!.frame_id,
        text: "Hello world",
      });

      await defineCharacterStyleTool.handler({
        document_id: doc.result!.document_id,
        name: "Accent",
        fill_hex: "#FF0000",
      });

      // Apply "Accent" to "world" (chars 6..11)
      const env = await applyCharacterStyleToRangeTool.handler({
        document_id: doc.result!.document_id,
        frame_id: frame.result!.frame_id,
        character_style_name: "Accent",
        start_index: 6,
        end_index: 11,
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.result?.applied_chars).toBe(5);
      expect(env.result?.character_style_name).toBe("Accent");
      expect(env.document_state_delta?.changed_frames?.[0].id).toBe(frame.result!.frame_id);
      expect(env.document_state_delta?.changed_frames?.[0].applied_character_style_range?.character_style_name).toBe("Accent");
      expect(env.document_state_delta?.changed_frames?.[0].applied_character_style_range?.start_index).toBe(6);
      expect(env.document_state_delta?.changed_frames?.[0].applied_character_style_range?.end_index).toBe(11);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "returns not_found for a missing character style",
    async () => {
      const doc = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      expect(doc.ok).toBe(true);
      if (!doc.ok) return;

      const frame = await createTextFrameTool.handler({
        document_id: doc.result!.document_id,
        page_id: doc.result!.page_ids[0],
        bounds_mm: { x: 12, y: 12, width: 186, height: 50 },
      });
      expect(frame.ok).toBe(true);
      if (!frame.ok) return;

      await setTextTool.handler({
        document_id: doc.result!.document_id,
        frame_id: frame.result!.frame_id,
        text: "Hello",
      });

      const env = await applyCharacterStyleToRangeTool.handler({
        document_id: doc.result!.document_id,
        frame_id: frame.result!.frame_id,
        character_style_name: "DoesNotExist",
        start_index: 0,
        end_index: 5,
      });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.kind).toBe("not_found");
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "returns invalid_args when end_index exceeds story length",
    async () => {
      const doc = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      expect(doc.ok).toBe(true);
      if (!doc.ok) return;

      const frame = await createTextFrameTool.handler({
        document_id: doc.result!.document_id,
        page_id: doc.result!.page_ids[0],
        bounds_mm: { x: 12, y: 12, width: 186, height: 50 },
      });
      expect(frame.ok).toBe(true);
      if (!frame.ok) return;

      await setTextTool.handler({
        document_id: doc.result!.document_id,
        frame_id: frame.result!.frame_id,
        text: "Hi",  // 2 chars
      });

      await defineCharacterStyleTool.handler({
        document_id: doc.result!.document_id,
        name: "Accent",
        fill_hex: "#FF0000",
      });

      const env = await applyCharacterStyleToRangeTool.handler({
        document_id: doc.result!.document_id,
        frame_id: frame.result!.frame_id,
        character_style_name: "Accent",
        start_index: 0,
        end_index: 100,  // way beyond story
      });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.kind).toBe("invalid_args");
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
