import { afterEach, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  integrationGate,
  INTEGRATION_TIMEOUT_MS,
  closeAllDocuments,
  tinyPngBytes,
} from "./helpers.js";
import { createDocumentTool } from "../../src/tools/create-document.js";
import { createImageFrameTool } from "../../src/tools/create-image-frame.js";
import { placeImageTool } from "../../src/tools/place-image.js";
import { createRectangleTool } from "../../src/tools/create-rectangle.js";
import { createLineTool } from "../../src/tools/create-line.js";
import { exportPdfTool } from "../../src/tools/export-pdf.js";

integrationGate("Plan B3 end-to-end (integration)", () => {
  afterEach(async () => {
    await closeAllDocuments();
  });

  it(
    "composes a page with image, stat pill, top rule; exports PDF",
    async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "indesign-mcp-b3-"));
      const imagePath = join(tmpDir, "test.png");
      const pdfPath = join(tmpDir, "out.pdf");
      writeFileSync(imagePath, tinyPngBytes());

      try {
        const create = await createDocumentTool.handler({
          preset: "A4",
          margins_mm: { top: 18, bottom: 18, left: 18, right: 18 },
        });
        expect(create.ok).toBe(true);
        if (!create.ok) return;
        const pageId = create.result!.page_ids[0];

        const topRule = await createLineTool.handler({
          document_id: create.result!.document_id,
          page_id: pageId,
          start_mm: { x: 18, y: 12 },
          end_mm: { x: 192, y: 12 },
          stroke_hex: "#333333",
          stroke_weight_pt: 0.5,
        });
        expect(topRule.ok).toBe(true);

        const imageFrame = await createImageFrameTool.handler({
          document_id: create.result!.document_id,
          page_id: pageId,
          bounds_mm: { x: 18, y: 30, width: 100, height: 60 },
        });
        expect(imageFrame.ok).toBe(true);
        if (!imageFrame.ok) return;

        const place = await placeImageTool.handler({
          document_id: create.result!.document_id,
          frame_id: imageFrame.result!.frame_id,
          image_path: imagePath,
        });
        expect(place.ok).toBe(true);

        const pill = await createRectangleTool.handler({
          document_id: create.result!.document_id,
          page_id: pageId,
          bounds_mm: { x: 18, y: 100, width: 60, height: 12 },
          fill_hex: "#FF6600",
          corner_radius_mm: 6,
        });
        expect(pill.ok).toBe(true);

        const exported = await exportPdfTool.handler({ document_id: create.result!.document_id, path: pdfPath });
        expect(exported.ok).toBe(true);
        if (!exported.ok) return;
        expect(existsSync(pdfPath)).toBe(true);
        expect(statSync(pdfPath).size).toBeGreaterThan(0);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    INTEGRATION_TIMEOUT_MS * 3,
  );
});
