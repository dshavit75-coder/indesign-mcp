import { describe, it, expect, vi, beforeEach } from "vitest";
import { setFrameColumnsTool } from "../../../src/tools/set-frame-columns.js";
import { lastCall, expectFailure } from "../_helpers.js";

vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

import { runScriptWithResultFile } from "../../../src/transport/result-file.js";

describe("set_frame_columns tool", () => {
  beforeEach(() => {
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("has the expected metadata", () => {
    expect(setFrameColumnsTool.name).toBe("set_frame_columns");
    expect(setFrameColumnsTool.description.length).toBeGreaterThan(0);
  });

  // --- Schema validation ---

  it("rejects missing document_id", () => {
    expect(setFrameColumnsTool.inputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects empty document_id", () => {
    expect(setFrameColumnsTool.inputSchema.safeParse({ document_id: "" }).success).toBe(false);
  });

  it("rejects whitespace-only document_id", () => {
    expect(setFrameColumnsTool.inputSchema.safeParse({ document_id: "   " }).success).toBe(false);
  });

  it("requires frame_id", () => {
    expect(
      setFrameColumnsTool.inputSchema.safeParse({ document_id: "doc-1", count: 2 }).success,
    ).toBe(false);
  });

  it("requires count", () => {
    expect(
      setFrameColumnsTool.inputSchema.safeParse({ document_id: "doc-1", frame_id: "f1" }).success,
    ).toBe(false);
  });

  it("accepts count = 1 (single column)", () => {
    expect(
      setFrameColumnsTool.inputSchema.safeParse({
        document_id: "doc-1",
        frame_id: "f1",
        count: 1,
      }).success,
    ).toBe(true);
  });

  it("accepts count = 3 with explicit gutter_mm", () => {
    expect(
      setFrameColumnsTool.inputSchema.safeParse({
        document_id: "doc-1",
        frame_id: "f1",
        count: 3,
        gutter_mm: 5,
      }).success,
    ).toBe(true);
  });

  it("rejects count = 0", () => {
    expect(
      setFrameColumnsTool.inputSchema.safeParse({
        document_id: "doc-1",
        frame_id: "f1",
        count: 0,
      }).success,
    ).toBe(false);
  });

  it("rejects non-integer count", () => {
    expect(
      setFrameColumnsTool.inputSchema.safeParse({
        document_id: "doc-1",
        frame_id: "f1",
        count: 1.5,
      }).success,
    ).toBe(false);
  });

  it("rejects negative gutter_mm", () => {
    expect(
      setFrameColumnsTool.inputSchema.safeParse({
        document_id: "doc-1",
        frame_id: "f1",
        count: 2,
        gutter_mm: -1,
      }).success,
    ).toBe(false);
  });

  it("accepts gutter_mm = 0", () => {
    expect(
      setFrameColumnsTool.inputSchema.safeParse({
        document_id: "doc-1",
        frame_id: "f1",
        count: 2,
        gutter_mm: 0,
      }).success,
    ).toBe(true);
  });

  it("accepts valid document_id", () => {
    expect(
      setFrameColumnsTool.inputSchema.safeParse({
        frame_id: "f1",
        count: 2,
        document_id: "doc1",
      }).success,
    ).toBe(true);
  });

  it("rejects extra keys (strict schema)", () => {
    expect(
      setFrameColumnsTool.inputSchema.safeParse({
        document_id: "doc-1",
        frame_id: "f1",
        count: 2,
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  // --- Script dispatch ---

  it("dispatches a script referencing textColumnCount and MILLIMETERS", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f1", count: 2, gutter_mm: 4 },
    });

    await setFrameColumnsTool.handler({ document_id: "doc-1", frame_id: "f1", count: 2 });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("textColumnCount");
    expect(arg.scriptTemplate).toContain("textColumnGutter");
    expect(arg.scriptTemplate).toContain("MILLIMETERS");
    expect(arg.scriptTemplate).toContain("findFrameById");
    expect(arg.scriptTemplate).toContain("textFramePreferences");
  });

  it("uses default gutter of 4 when gutter_mm is omitted", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f1", count: 2, gutter_mm: 4 },
    });

    await setFrameColumnsTool.handler({ document_id: "doc-1", frame_id: "f1", count: 2 });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("4");
  });

  it("embeds the explicit gutter value in the script", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f1", count: 3, gutter_mm: 6.5 },
    });

    await setFrameColumnsTool.handler({ document_id: "doc-1", frame_id: "f1", count: 3, gutter_mm: 6.5 });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("6.5");
  });

  it("includes TextFrame validation in the script", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f1", count: 2, gutter_mm: 4 },
    });

    await setFrameColumnsTool.handler({ document_id: "doc-1", frame_id: "f1", count: 2 });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("TextFrame");
    expect(arg.scriptTemplate).toContain("invalid_args");
  });

  it("includes try/finally for measurementUnit pinning", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f1", count: 2, gutter_mm: 4 },
    });

    await setFrameColumnsTool.handler({ document_id: "doc-1", frame_id: "f1", count: 2 });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("try");
    expect(arg.scriptTemplate).toContain("finally");
    expect(arg.scriptTemplate).toContain("measurementUnit");
  });

  // --- Return value ---

  it("returns frame_id, count, gutter_mm, and changed_frames delta", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f1", count: 2, gutter_mm: 4 },
    });

    const env = await setFrameColumnsTool.handler({ document_id: "doc-1", frame_id: "f1", count: 2 });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.result).toEqual({ frame_id: "f1", count: 2, gutter_mm: 4 });
    expect(env.document_state_delta).toEqual({
      changed_frames: [{ id: "f1", columns: { count: 2, gutter_mm: 4 } }],
    });
  });

  it("propagates not_found failures verbatim", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: false,
      error: {
        kind: "not_found",
        message: "frame not found",
        entity: "frame",
        id: "f1",
      },
    });

    const env = await setFrameColumnsTool.handler({ document_id: "doc-1", frame_id: "f1", count: 2 });

    expectFailure(env);
    expect(env.error.kind).toBe("not_found");
    expect(env.error.entity).toBe("frame");
  });

  it("propagates invalid_args failures verbatim", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: false,
      error: {
        kind: "invalid_args",
        message: "frame is not a text frame",
        entity: "frame",
        id: "f1",
      },
    });

    const env = await setFrameColumnsTool.handler({ document_id: "doc-1", frame_id: "f1", count: 2 });

    expectFailure(env);
    expect(env.error.kind).toBe("invalid_args");
  });
});
