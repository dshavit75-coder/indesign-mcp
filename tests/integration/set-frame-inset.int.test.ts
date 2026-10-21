import { afterEach, it, expect } from "vitest";
import { integrationGate, INTEGRATION_TIMEOUT_MS, closeAllDocuments } from "./helpers.js";
import { createDocumentTool } from "../../src/tools/create-document.js";
import { createTextFrameTool } from "../../src/tools/create-text-frame.js";
import { setFrameInsetTool } from "../../src/tools/set-frame-inset.js";

integrationGate("set_frame_inset (integration)", () => {
  afterEach(async () => {
    await closeAllDocuments();
  });

  it(
    "sets inset spacing on a text frame and reads back confirmed values",
    async () => {
      const create = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      expect(create.ok).toBe(true);
      if (!create.ok) return;

      const frame = await createTextFrameTool.handler({
        document_id: create.result!.document_id,
        page_id: create.result!.page_ids[0],
        bounds_mm: { x: 12, y: 12, width: 186, height: 100 },
      });
      expect(frame.ok).toBe(true);
      if (!frame.ok) return;

      const env = await setFrameInsetTool.handler({
        document_id: create.result!.document_id,
        frame_id: frame.result!.frame_id,
        inset_mm: { top: 5, left: 5, bottom: 5, right: 5 },
      });

      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.result?.inset_mm.top).toBeCloseTo(5, 1);
      expect(env.result?.inset_mm.left).toBeCloseTo(5, 1);
      expect(env.result?.inset_mm.bottom).toBeCloseTo(5, 1);
      expect(env.result?.inset_mm.right).toBeCloseTo(5, 1);
      expect(env.document_state_delta?.changed_frames?.[0].id).toBe(
        frame.result!.frame_id,
      );
      expect(env.document_state_delta?.changed_frames?.[0].inset_mm?.top).toBeCloseTo(5, 1);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "sets asymmetric insets",
    async () => {
      const create = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      expect(create.ok).toBe(true);
      if (!create.ok) return;

      const frame = await createTextFrameTool.handler({
        document_id: create.result!.document_id,
        page_id: create.result!.page_ids[0],
        bounds_mm: { x: 12, y: 12, width: 186, height: 80 },
      });
      expect(frame.ok).toBe(true);
      if (!frame.ok) return;

      const env = await setFrameInsetTool.handler({
        document_id: create.result!.document_id,
        frame_id: frame.result!.frame_id,
        inset_mm: { top: 2, left: 8, bottom: 2, right: 8 },
      });

      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.result?.inset_mm.top).toBeCloseTo(2, 1);
      expect(env.result?.inset_mm.left).toBeCloseTo(8, 1);
      expect(env.result?.inset_mm.right).toBeCloseTo(8, 1);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "returns invalid_args for a non-text frame",
    async () => {
      const create = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      expect(create.ok).toBe(true);
      if (!create.ok) return;

      // Create a rectangle (not a text frame).
      const { createRectangleTool } = await import("../../src/tools/create-rectangle.js");
      const rect = await createRectangleTool.handler({
        document_id: create.result!.document_id,
        page_id: create.result!.page_ids[0],
        bounds_mm: { x: 20, y: 20, width: 80, height: 60 },
      });
      expect(rect.ok).toBe(true);
      if (!rect.ok) return;

      const env = await setFrameInsetTool.handler({
        document_id: create.result!.document_id,
        frame_id: rect.result!.frame_id,
        inset_mm: { top: 5, left: 5, bottom: 5, right: 5 },
      });

      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.kind).toBe("invalid_args");
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
