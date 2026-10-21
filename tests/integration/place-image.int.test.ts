import { afterEach, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
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

integrationGate("place_image (integration)", () => {
  afterEach(async () => {
    await closeAllDocuments();
  });

  it(
    "places a real image into a rectangle and reports NORMAL link status",
    async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "indesign-mcp-place-"));
      const imagePath = join(tmpDir, "test.png");
      writeFileSync(imagePath, tinyPngBytes());

      try {
        const create = await createDocumentTool.handler({
          preset: "A4",
          margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
        });
        if (!create.ok) return;

        const frame = await createImageFrameTool.handler({
          document_id: create.result!.document_id,
          page_id: create.result!.page_ids[0],
          bounds_mm: { x: 12, y: 12, width: 100, height: 60 },
        });
        if (!frame.ok) return;

        const env = await placeImageTool.handler({
          document_id: create.result!.document_id,
          frame_id: frame.result!.frame_id,
          image_path: imagePath,
        });
        expect(env.ok).toBe(true);
        if (!env.ok) return;
        expect(env.result?.link_status).toBe("NORMAL");
        expect(env.document_state_delta?.changed_frames?.[0].applied_image_path).toBe(imagePath);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "returns io_error for a missing image file before dispatching",
    async () => {
      const create2 = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 12, bottom: 12, left: 12, right: 12 },
      });
      if (!create2.ok) return;
      const env = await placeImageTool.handler({
        document_id: create2.result!.document_id,
        frame_id: "anything",
        image_path: "/no/such/file.png",
      });
      expect(env.ok).toBe(false);
      if (env.ok) return;
      expect(env.error.kind).toBe("io_error");
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
