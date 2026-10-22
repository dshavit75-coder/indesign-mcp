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

// ---------------------------------------------------------------------------
// Stage B9-S5 tamper tests: IPNM-T1 – IPNM-T5
// ---------------------------------------------------------------------------
const tamperIPNM = vi.hoisted(() => ({
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
        if (tamperIPNM.mode === "forged")
          return actual.wrapExtendScript(body, { _mutateToken: {}, documentId: opts.documentId });
        if (tamperIPNM.mode === "replay") {
          actual.wrapExtendScript(body, opts);
          tamperIPNM.firstConsumeOk++;
          return actual.wrapExtendScript(body, opts);
        }
        if (tamperIPNM.mode === "wrong_doc")
          return actual.wrapExtendScript(body, { _mutateToken: opts._mutateToken, documentId: "doc-EVIL" });
        if (tamperIPNM.mode === "body_swap")
          return actual.wrapExtendScript("var evil = 1; return {};", { _mutateToken: opts._mutateToken, documentId: opts.documentId });
      }
      return actual.wrapExtendScript(...args);
    },
  };
});

describe("insert_page_number_marker — Stage B9-S5 tamper tests", () => {
  const validInput = {
    document_id: "doc-1",
    frame_id: "f1",
  };

  beforeEach(() => {
    tamperIPNM.mode = "passthrough";
    tamperIPNM.firstConsumeOk = 0;
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("IPNM-T2: forged token → throws; sendFn not called", async () => {
    tamperIPNM.mode = "forged";
    await expect(insertPageNumberMarkerTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("IPNM-T3: replay → first consume succeeds, second rejected; sendFn not called", async () => {
    tamperIPNM.mode = "replay";
    await expect(insertPageNumberMarkerTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
    expect(tamperIPNM.firstConsumeOk).toBe(1);
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("IPNM-T4: wrong_doc → documentId mismatch → throws; sendFn not called", async () => {
    tamperIPNM.mode = "wrong_doc";
    await expect(insertPageNumberMarkerTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: documentId mismatch",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("IPNM-T5: body_swap → body mismatch → throws; sendFn not called", async () => {
    tamperIPNM.mode = "body_swap";
    await expect(insertPageNumberMarkerTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: body mismatch",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("IPNM-T1: happy path — sendFn called exactly once when no tamper", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f1", inserted_at: "end" },
    });
    await insertPageNumberMarkerTool.handler(validInput);
    expect(vi.mocked(runScriptWithResultFile)).toHaveBeenCalledOnce();
  });
});
