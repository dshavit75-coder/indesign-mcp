import { afterEach, it, expect } from "vitest";
import { mkdtempSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { integrationGate, INTEGRATION_TIMEOUT_MS, closeAllDocuments } from "./helpers.js";
import { createDocumentTool } from "../../src/tools/create-document.js";
import { createTextFrameTool } from "../../src/tools/create-text-frame.js";
import { setTextTool } from "../../src/tools/set-text.js";
import { setFrameInsetTool } from "../../src/tools/set-frame-inset.js";
import { setFrameColumnsTool } from "../../src/tools/set-frame-columns.js";
import { threadTextFramesTool } from "../../src/tools/thread-text-frames.js";
import { exportPdfTool } from "../../src/tools/export-pdf.js";

integrationGate("Plan B6 end-to-end (integration)", () => {
  afterEach(async () => {
    await closeAllDocuments();
  });

  it(
    "creates 2-column inset frame, threads to second frame, places overflow text, exports PDF",
    async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "indesign-mcp-b6-"));
      const pdfPath = join(tmpDir, "b6-smoke.pdf");

      try {
        const createDoc = await createDocumentTool.handler({
          preset: "A4",
          margins_mm: { top: 20, bottom: 20, left: 20, right: 20 },
        });
        expect(createDoc.ok).toBe(true);
        if (!createDoc.ok) return;
        const pageId = createDoc.result!.page_ids[0];

        const frame1Env = await createTextFrameTool.handler({
          document_id: createDoc.result!.document_id,
          page_id: pageId,
          bounds_mm: { x: 20, y: 30, width: 170, height: 60 },
        });
        expect(frame1Env.ok).toBe(true);
        if (!frame1Env.ok) return;
        const frame1Id = frame1Env.result!.frame_id;

        const frame2Env = await createTextFrameTool.handler({
          document_id: createDoc.result!.document_id,
          page_id: pageId,
          bounds_mm: { x: 20, y: 100, width: 170, height: 120 },
        });
        expect(frame2Env.ok).toBe(true);
        if (!frame2Env.ok) return;
        const frame2Id = frame2Env.result!.frame_id;

        const insetEnv = await setFrameInsetTool.handler({
          document_id: createDoc.result!.document_id,
          frame_id: frame1Id,
          inset_mm: { top: 5, left: 5, bottom: 5, right: 5 },
        });
        expect(insetEnv.ok).toBe(true);
        if (!insetEnv.ok) return;
        expect(insetEnv.result?.inset_mm.top).toBeCloseTo(5, 1);
        expect(insetEnv.document_state_delta?.changed_frames?.[0].id).toBe(frame1Id);
        expect(insetEnv.document_state_delta?.changed_frames?.[0].inset_mm?.top).toBeCloseTo(5, 1);

        const colEnv = await setFrameColumnsTool.handler({
          document_id: createDoc.result!.document_id,
          frame_id: frame1Id,
          count: 2,
          gutter_mm: 4,
        });
        expect(colEnv.ok).toBe(true);
        if (!colEnv.ok) return;
        expect(colEnv.result?.count).toBe(2);
        expect(colEnv.result?.gutter_mm).toBeCloseTo(4, 1);
        expect(colEnv.document_state_delta?.changed_frames?.[0].columns?.count).toBe(2);

        const threadEnv = await threadTextFramesTool.handler({
          document_id: createDoc.result!.document_id,
          source_frame_id: frame1Id,
          target_frame_id: frame2Id,
        });
        expect(threadEnv.ok).toBe(true);
        if (!threadEnv.ok) return;
        expect(threadEnv.result?.source_frame_id).toBe(frame1Id);
        expect(threadEnv.result?.target_frame_id).toBe(frame2Id);
        expect(threadEnv.document_state_delta?.changed_frames?.[0].threaded_to_frame_id).toBe(frame2Id);

        const paragraph =
          "The quick brown fox jumps over the lazy dog. " +
          "Editorial layout requires text to flow gracefully across frames. ";
        const longText = paragraph.repeat(5);

        const setTextEnv = await setTextTool.handler({
          document_id: createDoc.result!.document_id,
          frame_id: frame1Id,
          text: longText,
        });
        expect(setTextEnv.ok).toBe(true);
        if (!setTextEnv.ok) return;
        expect(setTextEnv.result?.character_count).toBeGreaterThan(0);

        const exportEnv = await exportPdfTool.handler({ document_id: createDoc.result!.document_id, path: pdfPath });
        expect(exportEnv.ok).toBe(true);
        expect(existsSync(pdfPath)).toBe(true);
        expect(statSync(pdfPath).size).toBeGreaterThan(0);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    INTEGRATION_TIMEOUT_MS * 3,
  );
});
