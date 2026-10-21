import { afterEach, it, expect } from "vitest";
import { integrationGate, INTEGRATION_TIMEOUT_MS, closeAllDocuments } from "./helpers.js";
import { createDocumentTool } from "../../src/tools/create-document.js";
import { createTextFrameTool } from "../../src/tools/create-text-frame.js";
import { setTextTool } from "../../src/tools/set-text.js";
import { findReplaceTool } from "../../src/tools/find-replace.js";

integrationGate("find_replace (integration)", () => {
  afterEach(async () => {
    await closeAllDocuments();
  });

  it(
    "literal mode replaces a word in the document",
    async () => {
      const docEnv = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 20, bottom: 20, left: 20, right: 20 },
      });
      expect(docEnv.ok).toBe(true);
      if (!docEnv.ok) return;
      const pageId = docEnv.result!.page_ids[0];

      const frameEnv = await createTextFrameTool.handler({
        document_id: docEnv.result!.document_id,
        page_id: pageId,
        bounds_mm: { x: 20, y: 20, width: 160, height: 60 },
      });
      expect(frameEnv.ok).toBe(true);
      if (!frameEnv.ok) return;

      await setTextTool.handler({
        document_id: docEnv.result!.document_id,
        frame_id: frameEnv.result!.frame_id,
        text: "Total displaced: 1.5M people",
      });

      const env = await findReplaceTool.handler({ document_id: docEnv.result!.document_id, find: "people", replace: "individuals" });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.result?.matches_changed).toBe(1);
      expect(env.result?.scope).toBe("document");
      expect(env.result?.mode).toBe("literal");
      expect(env.document_state_delta?.changed_frames).toEqual([]);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "returns 0 when find string is not in the document",
    async () => {
      const create2 = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 20, bottom: 20, left: 20, right: 20 },
      });
      if (!create2.ok) return;

      const env = await findReplaceTool.handler({ document_id: create2.result!.document_id, find: "xyzzy_notpresent", replace: "b" });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.result?.matches_changed).toBe(0);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "scope 'frame' restricts replacement to the target frame's story",
    async () => {
      const docEnv = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 20, bottom: 20, left: 20, right: 20 },
      });
      expect(docEnv.ok).toBe(true);
      if (!docEnv.ok) return;
      const pageId = docEnv.result!.page_ids[0];

      const frame1Env = await createTextFrameTool.handler({
        document_id: docEnv.result!.document_id,
        page_id: pageId,
        bounds_mm: { x: 20, y: 20, width: 160, height: 40 },
      });
      expect(frame1Env.ok).toBe(true);
      if (!frame1Env.ok) return;
      const frame1Id = frame1Env.result!.frame_id;

      const frame2Env = await createTextFrameTool.handler({
        document_id: docEnv.result!.document_id,
        page_id: pageId,
        bounds_mm: { x: 20, y: 80, width: 160, height: 40 },
      });
      expect(frame2Env.ok).toBe(true);
      if (!frame2Env.ok) return;
      const frame2Id = frame2Env.result!.frame_id;

      await setTextTool.handler({ document_id: docEnv.result!.document_id, frame_id: frame1Id, text: "Hello world" });
      await setTextTool.handler({ document_id: docEnv.result!.document_id, frame_id: frame2Id, text: "Hello world" });

      // Replace only in frame1 — only 1 match, not 2
      const env = await findReplaceTool.handler({
        document_id: docEnv.result!.document_id,
        find: "world",
        replace: "there",
        scope: "frame",
        frame_id: frame1Id,
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.result?.matches_changed).toBe(1);
      expect(env.result?.scope).toBe("frame");
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    "grep mode replaces using a regex pattern",
    async () => {
      const docEnv = await createDocumentTool.handler({
        preset: "A4",
        margins_mm: { top: 20, bottom: 20, left: 20, right: 20 },
      });
      expect(docEnv.ok).toBe(true);
      if (!docEnv.ok) return;
      const pageId = docEnv.result!.page_ids[0];

      const frameEnv = await createTextFrameTool.handler({
        document_id: docEnv.result!.document_id,
        page_id: pageId,
        bounds_mm: { x: 20, y: 20, width: 160, height: 60 },
      });
      expect(frameEnv.ok).toBe(true);
      if (!frameEnv.ok) return;

      await setTextTool.handler({
        document_id: docEnv.result!.document_id,
        frame_id: frameEnv.result!.frame_id,
        text: "cat and Cat and CAT",
      });

      // GREP is case-sensitive by default in InDesign — match lowercase "cat" only
      const env = await findReplaceTool.handler({
        document_id: docEnv.result!.document_id,
        find: "cat",
        replace: "dog",
        mode: "grep",
      });
      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.result?.matches_changed).toBeGreaterThanOrEqual(1);
      expect(env.result?.mode).toBe("grep");
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
