import { afterEach, it, expect } from "vitest";
import { integrationGate, INTEGRATION_TIMEOUT_MS, closeAllDocuments } from "./helpers.js";
import { createDocumentTool } from "../../src/tools/create-document.js";
import { createTextFrameTool } from "../../src/tools/create-text-frame.js";
import { setTextTool } from "../../src/tools/set-text.js";
import { threadTextFramesTool } from "../../src/tools/thread-text-frames.js";

integrationGate("thread_text_frames (integration)", () => {
  afterEach(async () => {
    await closeAllDocuments();
  });

  it(
    "threads two text frames and reports story_length_after",
    async () => {
      const create = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      expect(create.ok).toBe(true);
      if (!create.ok) return;

      const frame1 = await createTextFrameTool.handler({
        document_id: create.result!.document_id,
        page_id: create.result!.page_ids[0],
        bounds_mm: { x: 12, y: 12, width: 186, height: 40 },
      });
      expect(frame1.ok).toBe(true);
      if (!frame1.ok) return;

      const frame2 = await createTextFrameTool.handler({
        document_id: create.result!.document_id,
        page_id: create.result!.page_ids[0],
        bounds_mm: { x: 12, y: 60, width: 186, height: 40 },
      });
      expect(frame2.ok).toBe(true);
      if (!frame2.ok) return;

      await setTextTool.handler({
        document_id: create.result!.document_id,
        frame_id: frame1.result!.frame_id,
        text: "Hello world",
      });

      const env = await threadTextFramesTool.handler({
        document_id: create.result!.document_id,
        source_frame_id: frame1.result!.frame_id,
        target_frame_id: frame2.result!.frame_id,
      });

      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.result?.source_frame_id).toBe(frame1.result!.frame_id);
      expect(env.result?.target_frame_id).toBe(frame2.result!.frame_id);
      expect(env.result?.story_length_after).toBeGreaterThan(0);
      expect(env.document_state_delta?.changed_frames?.[0].id).toBe(
        frame1.result!.frame_id,
      );
      expect(env.document_state_delta?.changed_frames?.[0].threaded_to_frame_id).toBe(
        frame2.result!.frame_id,
      );
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "is idempotent — calling twice returns success both times",
    async () => {
      const create = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      expect(create.ok).toBe(true);
      if (!create.ok) return;

      const frame1 = await createTextFrameTool.handler({
        document_id: create.result!.document_id,
        page_id: create.result!.page_ids[0],
        bounds_mm: { x: 12, y: 12, width: 186, height: 40 },
      });
      expect(frame1.ok).toBe(true);
      if (!frame1.ok) return;

      const frame2 = await createTextFrameTool.handler({
        document_id: create.result!.document_id,
        page_id: create.result!.page_ids[0],
        bounds_mm: { x: 12, y: 60, width: 186, height: 40 },
      });
      expect(frame2.ok).toBe(true);
      if (!frame2.ok) return;

      const first = await threadTextFramesTool.handler({
        document_id: create.result!.document_id,
        source_frame_id: frame1.result!.frame_id,
        target_frame_id: frame2.result!.frame_id,
      });
      expect(first.ok).toBe(true);

      // Call again — should succeed without error.
      const second = await threadTextFramesTool.handler({
        document_id: create.result!.document_id,
        source_frame_id: frame1.result!.frame_id,
        target_frame_id: frame2.result!.frame_id,
      });
      expect(second.ok).toBe(true);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "returns invalid_args when source is not a text frame",
    async () => {
      const create = await createDocumentTool.handler({ preset: "A4", margins_mm: { top: 12, bottom: 12, left: 12, right: 12 } });
      expect(create.ok).toBe(true);
      if (!create.ok) return;

      const { createRectangleTool } = await import("../../src/tools/create-rectangle.js");
      const rect = await createRectangleTool.handler({
        document_id: create.result!.document_id,
        page_id: create.result!.page_ids[0],
        bounds_mm: { x: 20, y: 20, width: 80, height: 60 },
      });
      expect(rect.ok).toBe(true);
      if (!rect.ok) return;

      const frame2 = await createTextFrameTool.handler({
        document_id: create.result!.document_id,
        page_id: create.result!.page_ids[0],
        bounds_mm: { x: 20, y: 100, width: 80, height: 60 },
      });
      expect(frame2.ok).toBe(true);
      if (!frame2.ok) return;

      const env = await threadTextFramesTool.handler({
        document_id: create.result!.document_id,
        source_frame_id: rect.result!.frame_id,
        target_frame_id: frame2.result!.frame_id,
      });

      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.kind).toBe("invalid_args");
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
