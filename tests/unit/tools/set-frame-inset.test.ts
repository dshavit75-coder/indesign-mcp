import { describe, it, expect, vi, beforeEach } from "vitest";
import { setFrameInsetTool } from "../../../src/tools/set-frame-inset.js";
import { lastCall, expectFailure } from "../_helpers.js";

vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

import { runScriptWithResultFile } from "../../../src/transport/result-file.js";

describe("set_frame_inset tool", () => {
  beforeEach(() => {
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("has the expected metadata", () => {
    expect(setFrameInsetTool.name).toBe("set_frame_inset");
    expect(setFrameInsetTool.description.length).toBeGreaterThan(0);
  });

  // --- Schema validation ---

  it("rejects missing document_id", () => {
    expect(setFrameInsetTool.inputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects empty document_id", () => {
    expect(setFrameInsetTool.inputSchema.safeParse({ document_id: "" }).success).toBe(false);
  });

  it("rejects whitespace-only document_id", () => {
    expect(setFrameInsetTool.inputSchema.safeParse({ document_id: "   " }).success).toBe(false);
  });

  it("requires frame_id", () => {
    expect(
      setFrameInsetTool.inputSchema.safeParse({
        document_id: "doc-1",
        inset_mm: { top: 5, left: 5, bottom: 5, right: 5 },
      }).success,
    ).toBe(false);
  });

  it("requires inset_mm", () => {
    expect(
      setFrameInsetTool.inputSchema.safeParse({ document_id: "doc-1", frame_id: "f1" }).success,
    ).toBe(false);
  });

  it("requires all four inset sides", () => {
    expect(
      setFrameInsetTool.inputSchema.safeParse({
        document_id: "doc-1",
        frame_id: "f1",
        inset_mm: { top: 5, left: 5, bottom: 5 },
      }).success,
    ).toBe(false);
    expect(
      setFrameInsetTool.inputSchema.safeParse({
        document_id: "doc-1",
        frame_id: "f1",
        inset_mm: { top: 5, left: 5, right: 5 },
      }).success,
    ).toBe(false);
  });

  it("accepts zero insets", () => {
    expect(
      setFrameInsetTool.inputSchema.safeParse({
        document_id: "doc-1",
        frame_id: "f1",
        inset_mm: { top: 0, left: 0, bottom: 0, right: 0 },
      }).success,
    ).toBe(true);
  });

  it("accepts asymmetric insets", () => {
    expect(
      setFrameInsetTool.inputSchema.safeParse({
        document_id: "doc-1",
        frame_id: "f1",
        inset_mm: { top: 3, left: 6, bottom: 3, right: 6 },
      }).success,
    ).toBe(true);
  });

  it("rejects negative insets", () => {
    expect(
      setFrameInsetTool.inputSchema.safeParse({
        document_id: "doc-1",
        frame_id: "f1",
        inset_mm: { top: -1, left: 5, bottom: 5, right: 5 },
      }).success,
    ).toBe(false);
    expect(
      setFrameInsetTool.inputSchema.safeParse({
        document_id: "doc-1",
        frame_id: "f1",
        inset_mm: { top: 5, left: 5, bottom: 5, right: -0.1 },
      }).success,
    ).toBe(false);
  });

  it("accepts valid document_id", () => {
    expect(
      setFrameInsetTool.inputSchema.safeParse({
        frame_id: "f1",
        inset_mm: { top: 5, left: 5, bottom: 5, right: 5 },
        document_id: "doc1",
      }).success,
    ).toBe(true);
  });

  it("rejects extra keys (strict schema)", () => {
    expect(
      setFrameInsetTool.inputSchema.safeParse({
        document_id: "doc-1",
        frame_id: "f1",
        inset_mm: { top: 5, left: 5, bottom: 5, right: 5 },
        extra_key: true,
      }).success,
    ).toBe(false);
  });

  // --- Script dispatch ---

  it("dispatches a script referencing insetSpacing and MILLIMETERS", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        frame_id: "f1",
        inset_mm: { top: 5, left: 5, bottom: 5, right: 5 },
      },
    });

    await setFrameInsetTool.handler({
      document_id: "doc-1",
      frame_id: "f1",
      inset_mm: { top: 5, left: 5, bottom: 5, right: 5 },
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("insetSpacing");
    expect(arg.scriptTemplate).toContain("MILLIMETERS");
    expect(arg.scriptTemplate).toContain("findFrameById");
    expect(arg.scriptTemplate).toContain("textFramePreferences");
  });

  it("embeds inset values in the script", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        frame_id: "f1",
        inset_mm: { top: 3, left: 6, bottom: 3, right: 6 },
      },
    });

    await setFrameInsetTool.handler({
      document_id: "doc-1",
      frame_id: "f1",
      inset_mm: { top: 3, left: 6, bottom: 3, right: 6 },
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("3");
    expect(arg.scriptTemplate).toContain("6");
  });

  it("includes TextFrame validation in the script", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        frame_id: "f1",
        inset_mm: { top: 5, left: 5, bottom: 5, right: 5 },
      },
    });

    await setFrameInsetTool.handler({
      document_id: "doc-1",
      frame_id: "f1",
      inset_mm: { top: 5, left: 5, bottom: 5, right: 5 },
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("TextFrame");
    expect(arg.scriptTemplate).toContain("invalid_args");
  });

  it("includes try/finally for measurementUnit pinning", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        frame_id: "f1",
        inset_mm: { top: 5, left: 5, bottom: 5, right: 5 },
      },
    });

    await setFrameInsetTool.handler({
      document_id: "doc-1",
      frame_id: "f1",
      inset_mm: { top: 5, left: 5, bottom: 5, right: 5 },
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("try");
    expect(arg.scriptTemplate).toContain("finally");
    expect(arg.scriptTemplate).toContain("measurementUnit");
  });

  // --- Return value ---

  it("returns frame_id, inset_mm, and changed_frames delta", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        frame_id: "f1",
        inset_mm: { top: 5, left: 5, bottom: 5, right: 5 },
      },
    });

    const env = await setFrameInsetTool.handler({
      document_id: "doc-1",
      frame_id: "f1",
      inset_mm: { top: 5, left: 5, bottom: 5, right: 5 },
    });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.result).toEqual({
      frame_id: "f1",
      inset_mm: { top: 5, left: 5, bottom: 5, right: 5 },
    });
    expect(env.document_state_delta).toEqual({
      changed_frames: [
        {
          id: "f1",
          inset_mm: { top: 5, left: 5, bottom: 5, right: 5 },
        },
      ],
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

    const env = await setFrameInsetTool.handler({
      document_id: "doc-1",
      frame_id: "f1",
      inset_mm: { top: 5, left: 5, bottom: 5, right: 5 },
    });

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

    const env = await setFrameInsetTool.handler({
      document_id: "doc-1",
      frame_id: "f1",
      inset_mm: { top: 5, left: 5, bottom: 5, right: 5 },
    });

    expectFailure(env);
    expect(env.error.kind).toBe("invalid_args");
  });
});
