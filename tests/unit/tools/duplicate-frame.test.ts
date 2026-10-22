import { describe, it, expect, vi, beforeEach } from "vitest";
import { duplicateFrameTool } from "../../../src/tools/duplicate-frame.js";
import { lastCall, expectFailure } from "../_helpers.js";

vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

import { runScriptWithResultFile } from "../../../src/transport/result-file.js";

describe("duplicate_frame tool", () => {
  beforeEach(() => {
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("has the expected metadata", () => {
    expect(duplicateFrameTool.name).toBe("duplicate_frame");
    expect(duplicateFrameTool.description.length).toBeGreaterThan(0);
  });

  // --- Schema validation ---

  it("rejects missing document_id", () => {
    expect(duplicateFrameTool.inputSchema.safeParse({ frame_id: "f1" }).success).toBe(false);
  });

  it("rejects empty document_id", () => {
    expect(duplicateFrameTool.inputSchema.safeParse({ document_id: "", frame_id: "f1" }).success).toBe(false);
  });

  it("rejects whitespace-only document_id", () => {
    expect(duplicateFrameTool.inputSchema.safeParse({ document_id: "   ", frame_id: "f1" }).success).toBe(false);
  });

  it("requires frame_id", () => {
    expect(duplicateFrameTool.inputSchema.safeParse({}).success).toBe(false);
  });

  it("accepts frame_id alone (no offset)", () => {
    expect(
      duplicateFrameTool.inputSchema.safeParse({ document_id: "doc-1", frame_id: "f1" }).success,
    ).toBe(true);
  });

  it("accepts frame_id + offset_mm", () => {
    expect(
      duplicateFrameTool.inputSchema.safeParse({
        document_id: "doc-1",
        frame_id: "f1",
        offset_mm: { x: 10, y: 20 },
      }).success,
    ).toBe(true);
  });

  it("accepts zero offset", () => {
    expect(
      duplicateFrameTool.inputSchema.safeParse({
        document_id: "doc-1",
        frame_id: "f1",
        offset_mm: { x: 0, y: 0 },
      }).success,
    ).toBe(true);
  });

  it("accepts negative offset (valid — offset can be left/up)", () => {
    expect(
      duplicateFrameTool.inputSchema.safeParse({
        document_id: "doc-1",
        frame_id: "f1",
        offset_mm: { x: -5, y: -10 },
      }).success,
    ).toBe(true);
  });

  it("rejects offset_mm with missing x or y", () => {
    expect(
      duplicateFrameTool.inputSchema.safeParse({
        frame_id: "f1",
        offset_mm: { x: 10 },
      }).success,
    ).toBe(false);
    expect(
      duplicateFrameTool.inputSchema.safeParse({
        frame_id: "f1",
        offset_mm: { y: 10 },
      }).success,
    ).toBe(false);
  });

  it("accepts optional document_id", () => {
    expect(
      duplicateFrameTool.inputSchema.safeParse({
        frame_id: "f1",
        document_id: "doc1",
      }).success,
    ).toBe(true);
  });

  it("rejects extra keys (strict schema)", () => {
    expect(
      duplicateFrameTool.inputSchema.safeParse({ frame_id: "f1", extra: true }).success,
    ).toBe(false);
  });

  // --- Script dispatch ---

  it("dispatches a script referencing frame.duplicate and MILLIMETERS", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { source_frame_id: "f1", duplicate_frame_id: "f2", duplicate_type: "text" },
    });

    await duplicateFrameTool.handler({ document_id: "doc-1", frame_id: "f1" });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("duplicate");
    expect(arg.scriptTemplate).toContain("MILLIMETERS");
    expect(arg.scriptTemplate).toContain("findFrameById");
  });

  it("embeds the offset in the script when provided", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { source_frame_id: "f1", duplicate_frame_id: "f2", duplicate_type: "text" },
    });

    await duplicateFrameTool.handler({ document_id: "doc-1", frame_id: "f1", offset_mm: { x: 10, y: 20 } });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("10");
    expect(arg.scriptTemplate).toContain("20");
  });

  it("uses 0,0 offset when offset_mm is omitted", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { source_frame_id: "f1", duplicate_frame_id: "f2", duplicate_type: "text" },
    });

    await duplicateFrameTool.handler({ document_id: "doc-1", frame_id: "f1" });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    // Default offset is 0, 0 — look for the array literal
    expect(arg.scriptTemplate).toContain("[0, 0]");
  });

  // --- Result shape ---

  it("returns source_frame_id, duplicate_frame_id, duplicate_type", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { source_frame_id: "f1", duplicate_frame_id: "f99", duplicate_type: "text" },
    });

    const env = await duplicateFrameTool.handler({ document_id: "doc-1", frame_id: "f1" });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.result?.source_frame_id).toBe("f1");
    expect(env.result?.duplicate_frame_id).toBe("f99");
    expect(env.result?.duplicate_type).toBe("text");
  });

  it("emits new_frames delta with the duplicate id and type", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { source_frame_id: "f1", duplicate_frame_id: "f99", duplicate_type: "rectangle" },
    });

    const env = await duplicateFrameTool.handler({ document_id: "doc-1", frame_id: "f1" });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.document_state_delta?.new_frames).toEqual([{ id: "f99", type: "rectangle" }]);
  });

  it("propagates not_found failures verbatim", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: false,
      error: { kind: "not_found", message: "frame f1 not found" },
    });

    const env = await duplicateFrameTool.handler({ document_id: "doc-1", frame_id: "f1" });

    expectFailure(env);
    expect(env.error.kind).toBe("not_found");
  });
});
// ---------------------------------------------------------------------------
// Stage 7C tamper tests: DF-T1 – DF-T5
// ---------------------------------------------------------------------------
const tamperDF = vi.hoisted(() => ({
  mode: "passthrough" as
    | "passthrough" | "forged" | "replay" | "wrong_doc" | "body_swap",
  firstConsumeOk: 0,
}));

vi.mock("../../../src/compose.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/compose.js")>();
  return {
    ...actual,
    wrapExtendScript: (...args: Parameters<typeof actual.wrapExtendScript>) => {
      const [body, opts] = args;
      if (opts !== undefined && "_mutateToken" in opts) {
        if (tamperDF.mode === "forged")
          return actual.wrapExtendScript(body, { _mutateToken: {}, documentId: opts.documentId });
        if (tamperDF.mode === "replay") {
          actual.wrapExtendScript(body, opts);
          tamperDF.firstConsumeOk++;
          return actual.wrapExtendScript(body, opts);
        }
        if (tamperDF.mode === "wrong_doc")
          return actual.wrapExtendScript(body, { _mutateToken: opts._mutateToken, documentId: "doc-EVIL" });
        if (tamperDF.mode === "body_swap")
          return actual.wrapExtendScript("var evil = 1; return {};", { _mutateToken: opts._mutateToken, documentId: opts.documentId });
      }
      return actual.wrapExtendScript(...args);
    },
  };
});

describe("duplicate_frame — Stage 7C tamper tests", () => {
  const validInput = {
    document_id: "doc-1",
    frame_id: "f1",
  };

  beforeEach(() => {
    tamperDF.mode = "passthrough";
    tamperDF.firstConsumeOk = 0;
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("DF-T2: forged token → throws; sendFn not called", async () => {
    tamperDF.mode = "forged";
    await expect(duplicateFrameTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("DF-T3: replay → first consume succeeds, second rejected; sendFn not called", async () => {
    tamperDF.mode = "replay";
    await expect(duplicateFrameTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
    expect(tamperDF.firstConsumeOk).toBe(1);
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("DF-T4: wrong_doc → documentId mismatch → throws; sendFn not called", async () => {
    tamperDF.mode = "wrong_doc";
    await expect(duplicateFrameTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: documentId mismatch",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("DF-T5: body_swap → body mismatch → throws; sendFn not called", async () => {
    tamperDF.mode = "body_swap";
    await expect(duplicateFrameTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: body mismatch",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("DF-T1: happy path — sendFn called exactly once when no tamper", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        source_frame_id: "f1",
        duplicate_frame_id: "f2",
        duplicate_type: "text",
      },
    });
    await duplicateFrameTool.handler(validInput);
    expect(vi.mocked(runScriptWithResultFile)).toHaveBeenCalledOnce();
  });
});
