import { afterEach, it, expect } from "vitest";
import { integrationGate, INTEGRATION_TIMEOUT_MS, closeAllDocuments } from "./helpers.js";
import { createDocumentTool } from "../../src/tools/create-document.js";
import { createTextFrameTool } from "../../src/tools/create-text-frame.js";
import { setFrameColumnsTool } from "../../src/tools/set-frame-columns.js";

integrationGate("set_frame_columns (integration)", () => {
  afterEach(async () => {
    await closeAllDocuments();
  });

  it(
    "sets column count on a text frame using default gutter",
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

      const env = await setFrameColumnsTool.handler({
        document_id: create.result!.document_id,
        frame_id: frame.result!.frame_id,
        count: 2,
      });

      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.result?.count).toBe(2);
      expect(env.result?.gutter_mm).toBeCloseTo(4, 1);
      expect(env.document_state_delta?.changed_frames?.[0].columns?.count).toBe(2);
      expect(env.document_state_delta?.changed_frames?.[0].columns?.gutter_mm).toBeCloseTo(4, 1);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "sets column count with explicit gutter",
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

      const env = await setFrameColumnsTool.handler({
        document_id: create.result!.document_id,
        frame_id: frame.result!.frame_id,
        count: 3,
        gutter_mm: 5,
      });

      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.result?.count).toBe(3);
      expect(env.result?.gutter_mm).toBeCloseTo(5, 1);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "collapses to single column with count = 1",
    async () => {
      const create = await createDocumentTool.handler({ preset: "A4", margins_mm: { top: 12, bottom: 12, left: 12, right: 12 } });
      expect(create.ok).toBe(true);
      if (!create.ok) return;

      const frame = await createTextFrameTool.handler({
        document_id: create.result!.document_id,
        page_id: create.result!.page_ids[0],
        bounds_mm: { x: 12, y: 12, width: 186, height: 100 },
      });
      expect(frame.ok).toBe(true);
      if (!frame.ok) return;

      // First set to 2 columns, then collapse back to 1.
      await setFrameColumnsTool.handler({
        document_id: create.result!.document_id,
        frame_id: frame.result!.frame_id,
        count: 2,
      });

      const env = await setFrameColumnsTool.handler({
        document_id: create.result!.document_id,
        frame_id: frame.result!.frame_id,
        count: 1,
      });

      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.result?.count).toBe(1);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "returns invalid_args for a non-text frame",
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

      const env = await setFrameColumnsTool.handler({
        document_id: create.result!.document_id,
        frame_id: rect.result!.frame_id,
        count: 2,
      });

      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.kind).toBe("invalid_args");
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
