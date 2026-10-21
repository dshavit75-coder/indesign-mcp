import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { placeImageTool } from "../../../src/tools/place-image.js";
import { lastCall, expectFailure } from "../_helpers.js";

vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

import { runScriptWithResultFile } from "../../../src/transport/result-file.js";

describe("place_image tool", () => {
  beforeEach(() => {
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("has the expected metadata", () => {
    expect(placeImageTool.name).toBe("place_image");
    expect(placeImageTool.description.length).toBeGreaterThan(0);
  });

  it("rejects missing document_id", () => {
    expect(placeImageTool.inputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects empty document_id", () => {
    expect(placeImageTool.inputSchema.safeParse({ document_id: "" }).success).toBe(false);
  });

  it("rejects whitespace-only document_id", () => {
    expect(placeImageTool.inputSchema.safeParse({ document_id: "   " }).success).toBe(false);
  });

  it("requires frame_id and image_path", () => {
    expect(
      placeImageTool.inputSchema.safeParse({ document_id: "doc-1", image_path: "/x" }).success,
    ).toBe(false);
    expect(
      placeImageTool.inputSchema.safeParse({ document_id: "doc-1", frame_id: "f1" }).success,
    ).toBe(false);
  });

  it("accepts each fit value", () => {
    for (const fit of [
      "fill_proportionally",
      "fit_proportionally",
      "fit_content_to_frame",
      "center_content",
    ] as const) {
      expect(
        placeImageTool.inputSchema.safeParse({
          document_id: "doc-1",
          frame_id: "f1",
          image_path: "/img.png",
          fit,
        }).success,
      ).toBe(true);
    }
  });

  it("rejects an invalid fit value", () => {
    expect(
      placeImageTool.inputSchema.safeParse({
        document_id: "doc-1",
        frame_id: "f1",
        image_path: "/img.png",
        fit: "stretch",
      }).success,
    ).toBe(false);
  });

  it("returns io_error before dispatching when image file does not exist", async () => {
    const env = await placeImageTool.handler({
      document_id: "doc-1",
      frame_id: "f1",
      image_path: "/nonexistent/path/image.png",
    });

    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.kind).toBe("io_error");
    expect(env.error.message).toMatch(/not found|does not exist/i);
    expect(runScriptWithResultFile).not.toHaveBeenCalled();
  });

  it("dispatches a script with the resolved absolute path and fit value", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "place-image-test-"));
    const imagePath = join(tmpDir, "test.png");
    writeFileSync(imagePath, "fake png content");

    try {
      vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
        ok: true,
        result: { frame_id: "f1", image_path: imagePath, link_status: "NORMAL" },
      });

      await placeImageTool.handler({
        document_id: "doc-1",
        frame_id: "f1",
        image_path: imagePath,
        fit: "fit_proportionally",
      });

      const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
      expect(arg.scriptTemplate).toContain(imagePath);
      expect(arg.scriptTemplate).toContain("FitOptions.PROPORTIONALLY");
      expect(arg.scriptTemplate).toContain("frame.place");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns frame, image_path, link_status, and changed_frames delta", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "place-image-test-"));
    const imagePath = join(tmpDir, "test.png");
    writeFileSync(imagePath, "fake png content");

    try {
      vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
        ok: true,
        result: { frame_id: "f1", image_path: imagePath, link_status: "NORMAL" },
      });

      const env = await placeImageTool.handler({
        document_id: "doc-1",
        frame_id: "f1",
        image_path: imagePath,
      });

      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.result?.link_status).toBe("NORMAL");
      expect(env.document_state_delta).toEqual({
        changed_frames: [{ id: "f1", applied_image_path: imagePath }],
      });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
