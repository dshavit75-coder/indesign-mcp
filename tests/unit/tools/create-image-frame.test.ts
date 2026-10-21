import { describe, it, expect, vi, beforeEach } from "vitest";
import { createImageFrameTool } from "../../../src/tools/create-image-frame.js";
import { lastCall, expectFailure } from "../_helpers.js";

vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

import { runScriptWithResultFile } from "../../../src/transport/result-file.js";

describe("create_image_frame tool", () => {
  beforeEach(() => {
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("has the expected metadata", () => {
    expect(createImageFrameTool.name).toBe("create_image_frame");
    expect(createImageFrameTool.description.length).toBeGreaterThan(0);
  });

  it("accepts minimal valid input", () => {
    expect(
      createImageFrameTool.inputSchema.safeParse({
        document_id: "doc-1",
        page_id: "p1",
        bounds_mm: { x: 10, y: 10, width: 100, height: 50 },
      }).success,
    ).toBe(true);
  });

  it("rejects missing document_id", () => {
    expect(createImageFrameTool.inputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects empty document_id", () => {
    expect(createImageFrameTool.inputSchema.safeParse({ document_id: "" }).success).toBe(false);
  });

  it("rejects whitespace-only document_id", () => {
    expect(createImageFrameTool.inputSchema.safeParse({ document_id: "   " }).success).toBe(false);
  });

  it("rejects zero or negative width/height", () => {
    expect(
      createImageFrameTool.inputSchema.safeParse({
        document_id: "doc-1",
        page_id: "p1",
        bounds_mm: { x: 10, y: 10, width: 0, height: 50 },
      }).success,
    ).toBe(false);
  });

  it("dispatches a script that creates a rectangle and sets fittingOnEmptyFrame", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f1", page_id: "p1" },
    });

    await createImageFrameTool.handler({
      document_id: "doc-1",
      page_id: "p1",
      bounds_mm: { x: 10, y: 20, width: 100, height: 50 },
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("rectangles.add");
    expect(arg.scriptTemplate).toContain("fittingOnEmptyFrame");
    expect(arg.scriptTemplate).toContain("FILL_PROPORTIONALLY");
    // Geometric bounds [y1, x1, y2, x2]: [20, 10, 70, 110]
    expect(arg.scriptTemplate).toContain("[20, 10, 70, 110]");
  });

  it("returns frame and document_state_delta", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f5", page_id: "p1" },
    });

    const env = await createImageFrameTool.handler({
      document_id: "doc-1",
      page_id: "p1",
      bounds_mm: { x: 10, y: 10, width: 100, height: 50 },
    });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.result).toEqual({ frame_id: "f5", page_id: "p1" });
    expect(env.document_state_delta).toEqual({
      new_frames: [{ id: "f5", type: "rectangle" }],
    });
  });

  it("propagates failure envelopes verbatim", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: false,
      error: { kind: "not_found", message: "page p99 not found", entity: "page", id: "p99" },
    });

    const env = await createImageFrameTool.handler({
      document_id: "doc-1",
      page_id: "p99",
      bounds_mm: { x: 10, y: 10, width: 100, height: 50 },
    });

    expectFailure(env);
    expect(env.error.kind).toBe("not_found");
  });
});
