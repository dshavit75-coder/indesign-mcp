import { describe, it, expect, vi, beforeEach } from "vitest";
import { insertPageNumberMarkerTool } from "../../../src/tools/insert-page-number-marker.js";
import { lastCall, expectFailure } from "../_helpers.js";

vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

import { runScriptWithResultFile } from "../../../src/transport/result-file.js";

describe("insert_page_number_marker tool", () => {
  beforeEach(() => {
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("has the expected metadata", () => {
    expect(insertPageNumberMarkerTool.name).toBe("insert_page_number_marker");
    expect(insertPageNumberMarkerTool.description.length).toBeGreaterThan(0);
  });

  it("accepts minimal valid input — frame_id only", () => {
    expect(
      insertPageNumberMarkerTool.inputSchema.safeParse({ document_id: "doc-1", frame_id: "f1" }).success,
    ).toBe(true);
  });

  it("accepts frame_id with position start", () => {
    expect(
      insertPageNumberMarkerTool.inputSchema.safeParse({
        document_id: "doc-1",
        frame_id: "f1",
        position: "start",
      }).success,
    ).toBe(true);
  });

  it("accepts frame_id with position end", () => {
    expect(
      insertPageNumberMarkerTool.inputSchema.safeParse({
        document_id: "doc-1",
        frame_id: "f1",
        position: "end",
      }).success,
    ).toBe(true);
  });

  it("rejects missing document_id", () => {
    expect(insertPageNumberMarkerTool.inputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects empty document_id", () => {
    expect(insertPageNumberMarkerTool.inputSchema.safeParse({ document_id: "" }).success).toBe(false);
  });

  it("rejects whitespace-only document_id", () => {
    expect(insertPageNumberMarkerTool.inputSchema.safeParse({ document_id: "   " }).success).toBe(false);
  });

  it("rejects invalid position value", () => {
    expect(
      insertPageNumberMarkerTool.inputSchema.safeParse({
        document_id: "doc-1",
        frame_id: "f1",
        position: "middle",
      }).success,
    ).toBe(false);
  });

  it("rejects missing frame_id", () => {
    expect(
      insertPageNumberMarkerTool.inputSchema.safeParse({ document_id: "doc-1" }).success,
    ).toBe(false);
  });

  it("rejects empty frame_id", () => {
    expect(
      insertPageNumberMarkerTool.inputSchema.safeParse({ document_id: "doc-1", frame_id: "" }).success,
    ).toBe(false);
  });

  it("dispatches a script using findFrameById and AUTO_PAGE_NUMBER at end by default", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f1", inserted_at: "end" },
    });

    await insertPageNumberMarkerTool.handler({ document_id: "doc-1", frame_id: "f1" });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("findFrameById");
    expect(arg.scriptTemplate).toContain("AUTO_PAGE_NUMBER");
    expect(arg.scriptTemplate).toContain("parentStory");
    expect(arg.scriptTemplate).toContain("f1");
    // Default position is end — use insertionPoints[-1]
    expect(arg.scriptTemplate).toContain("[-1]");
  });

  it("dispatches a script using insertionPoints[0] when position is start", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f1", inserted_at: "start" },
    });

    await insertPageNumberMarkerTool.handler({ document_id: "doc-1", frame_id: "f1", position: "start" });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("[0]");
  });

  it("script validates that frame is a TextFrame", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f1", inserted_at: "end" },
    });

    await insertPageNumberMarkerTool.handler({ document_id: "doc-1", frame_id: "f1" });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("TextFrame");
    expect(arg.scriptTemplate).toContain("invalid_args");
  });

  it("returns frame_id, inserted_at, and changed_frames delta", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f1", inserted_at: "end" },
    });

    const env = await insertPageNumberMarkerTool.handler({ document_id: "doc-1", frame_id: "f1" });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.result).toEqual({ frame_id: "f1", inserted_at: "end" });
    expect(env.document_state_delta).toEqual({
      changed_frames: [{ id: "f1" }],
    });
  });

  it("propagates invalid_args when frame is not a TextFrame", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: false,
      error: {
        kind: "invalid_args",
        message: "frame f2 is not a TextFrame",
      },
    });

    const env = await insertPageNumberMarkerTool.handler({ document_id: "doc-1", frame_id: "f2" });

    expectFailure(env);
    expect(env.error.kind).toBe("invalid_args");
  });

  it("propagates failure envelopes verbatim", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: false,
      error: { kind: "not_found", message: "frame f99 not found", entity: "frame" },
    });

    const env = await insertPageNumberMarkerTool.handler({ document_id: "doc-1", frame_id: "f99" });

    expectFailure(env);
    expect(env.error.kind).toBe("not_found");
  });
});
