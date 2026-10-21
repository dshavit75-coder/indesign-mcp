import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTextFrameTool } from "../../../src/tools/create-text-frame.js";
import { lastCall, expectFailure } from "../_helpers.js";

vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

import { runScriptWithResultFile } from "../../../src/transport/result-file.js";

describe("create_text_frame tool", () => {
  beforeEach(() => {
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("has the expected metadata", () => {
    expect(createTextFrameTool.name).toBe("create_text_frame");
    expect(createTextFrameTool.description.length).toBeGreaterThan(0);
  });

  it("accepts a minimal valid input", () => {
    const result = createTextFrameTool.inputSchema.safeParse({
      document_id: "doc-1",
      page_id: "p1",
      bounds_mm: { x: 10, y: 10, width: 100, height: 50 },
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing document_id", () => {
    expect(createTextFrameTool.inputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects empty document_id", () => {
    expect(createTextFrameTool.inputSchema.safeParse({ document_id: "" }).success).toBe(false);
  });

  it("rejects whitespace-only document_id", () => {
    expect(createTextFrameTool.inputSchema.safeParse({ document_id: "   " }).success).toBe(false);
  });

  it("rejects zero or negative width/height", () => {
    expect(
      createTextFrameTool.inputSchema.safeParse({
        document_id: "doc-1",
        page_id: "p1",
        bounds_mm: { x: 10, y: 10, width: 0, height: 50 },
      }).success,
    ).toBe(false);
    expect(
      createTextFrameTool.inputSchema.safeParse({
        document_id: "doc-1",
        page_id: "p1",
        bounds_mm: { x: 10, y: 10, width: 100, height: -1 },
      }).success,
    ).toBe(false);
  });

  it("rejects negative x/y", () => {
    expect(
      createTextFrameTool.inputSchema.safeParse({
        document_id: "doc-1",
        page_id: "p1",
        bounds_mm: { x: -1, y: 10, width: 100, height: 50 },
      }).success,
    ).toBe(false);
  });

  it("accepts initial_text", () => {
    expect(
      createTextFrameTool.inputSchema.safeParse({
        document_id: "doc-1",
        page_id: "p1",
        bounds_mm: { x: 10, y: 10, width: 100, height: 50 },
        initial_text: "Hello, world",
      }).success,
    ).toBe(true);
  });

  it("dispatches a script that converts {x,y,w,h} to InDesign's [y1,x1,y2,x2] geometricBounds", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f1", page_id: "p1" },
    });

    await createTextFrameTool.handler({
      document_id: "doc-1",
      page_id: "p1",
      bounds_mm: { x: 10, y: 20, width: 100, height: 50 },
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.language).toBe("JavaScript");
    expect(arg.scriptTemplate).toContain("[20, 10, 70, 110]");
  });

  it("dispatches a script that sets initial_text when provided", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f1", page_id: "p1" },
    });

    await createTextFrameTool.handler({
      document_id: "doc-1",
      page_id: "p1",
      bounds_mm: { x: 10, y: 20, width: 100, height: 50 },
      initial_text: "Headline goes here",
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("Headline goes here");
    expect(arg.scriptTemplate).toContain("frame.contents");
  });

  it("returns the frame and document_state_delta", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f7", page_id: "p1" },
    });

    const env = await createTextFrameTool.handler({
      document_id: "doc-1",
      page_id: "p1",
      bounds_mm: { x: 10, y: 10, width: 100, height: 50 },
    });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.result).toEqual({ frame_id: "f7", page_id: "p1" });
    expect(env.document_state_delta).toEqual({
      new_frames: [{ id: "f7", type: "text" }],
    });
  });

  it("propagates failure envelopes verbatim", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: false,
      error: { kind: "not_found", message: "page p99 not found", entity: "page", id: "p99" },
    });

    const env = await createTextFrameTool.handler({
      document_id: "doc-1",
      page_id: "p99",
      bounds_mm: { x: 10, y: 10, width: 100, height: 50 },
    });

    expectFailure(env);
    expect(env.error.kind).toBe("not_found");
  });
});
