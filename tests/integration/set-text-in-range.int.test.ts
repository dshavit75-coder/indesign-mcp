import { afterEach, it, expect } from "vitest";
import { integrationGate, INTEGRATION_TIMEOUT_MS, closeAllDocuments } from "./helpers.js";
import { createDocumentTool } from "../../src/tools/create-document.js";
import { createTextFrameTool } from "../../src/tools/create-text-frame.js";
import { setTextTool } from "../../src/tools/set-text.js";
import { setTextInRangeTool } from "../../src/tools/set-text-in-range.js";

integrationGate("set_text_in_range (integration)", () => {
  afterEach(async () => {
    await closeAllDocuments();
  });

  it(
    "replaces a word in the middle of a string",
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

      // "Hello world" — 11 chars
      await setTextTool.handler({
        document_id: doc.result!.document_id,
        frame_id: frame.result!.frame_id,
        text: "Hello world",
      });

      // Replace "world" (indices 6..11) with "InDesign"
      const env = await setTextInRangeTool.handler({
        document_id: doc.result!.document_id,
        frame_id: frame.result!.frame_id,
        start_index: 6,
        end_index: 11,
        text: "InDesign",
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.result?.removed_chars).toBe(5);
      expect(env.result?.inserted_chars).toBe(8);
      // "Hello InDesign" = 14 chars
      expect(env.result?.total_length_after).toBe(14);
      expect(env.document_state_delta?.changed_frames?.[0].id).toBe(frame.result!.frame_id);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "deletes a range when text is empty",
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

      // "Hello world" — 11 chars
      await setTextTool.handler({
        document_id: doc.result!.document_id,
        frame_id: frame.result!.frame_id,
        text: "Hello world",
      });

      // Delete " world" (indices 5..11) — empty replacement
      const env = await setTextInRangeTool.handler({
        document_id: doc.result!.document_id,
        frame_id: frame.result!.frame_id,
        start_index: 5,
        end_index: 11,
        text: "",
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.result?.removed_chars).toBe(6);
      expect(env.result?.inserted_chars).toBe(0);
      // "Hello" = 5 chars
      expect(env.result?.total_length_after).toBe(5);
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
        text: "Hi",
      });

      const env = await setTextInRangeTool.handler({
        document_id: doc.result!.document_id,
        frame_id: frame.result!.frame_id,
        start_index: 0,
        end_index: 999,
        text: "replacement",
      });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.kind).toBe("invalid_args");
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
