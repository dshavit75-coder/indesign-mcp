import { describe, it, expect, vi, beforeEach } from "vitest";
import { threadTextFramesTool } from "../../../src/tools/thread-text-frames.js";
import { lastCall, expectFailure } from "../_helpers.js";

vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

import { runScriptWithResultFile } from "../../../src/transport/result-file.js";

describe("thread_text_frames tool", () => {
  beforeEach(() => {
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("has the expected metadata", () => {
    expect(threadTextFramesTool.name).toBe("thread_text_frames");
    expect(threadTextFramesTool.description.length).toBeGreaterThan(0);
  });

  // --- Schema validation ---

  it("rejects missing document_id", () => {
    expect(threadTextFramesTool.inputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects empty document_id", () => {
    expect(threadTextFramesTool.inputSchema.safeParse({ document_id: "" }).success).toBe(false);
  });

  it("rejects whitespace-only document_id", () => {
    expect(threadTextFramesTool.inputSchema.safeParse({ document_id: "   " }).success).toBe(false);
  });

  it("requires source_frame_id", () => {
    expect(
      threadTextFramesTool.inputSchema.safeParse({ document_id: "doc-1", target_frame_id: "f2" }).success,
    ).toBe(false);
  });

  it("requires target_frame_id", () => {
    expect(
      threadTextFramesTool.inputSchema.safeParse({ document_id: "doc-1", source_frame_id: "f1" }).success,
    ).toBe(false);
  });

  it("accepts minimal valid input", () => {
    expect(
      threadTextFramesTool.inputSchema.safeParse({
        document_id: "doc-1",
        source_frame_id: "f1",
        target_frame_id: "f2",
      }).success,
    ).toBe(true);
  });

  it("rejects source_frame_id === target_frame_id", () => {
    expect(
      threadTextFramesTool.inputSchema.safeParse({
        document_id: "doc-1",
        source_frame_id: "f1",
        target_frame_id: "f1",
      }).success,
    ).toBe(false);
  });

  it("accepts valid document_id", () => {
    expect(
      threadTextFramesTool.inputSchema.safeParse({
        source_frame_id: "f1",
        target_frame_id: "f2",
        document_id: "doc1",
      }).success,
    ).toBe(true);
  });

  it("rejects extra keys (strict schema)", () => {
    expect(
      threadTextFramesTool.inputSchema.safeParse({
        document_id: "doc-1",
        source_frame_id: "f1",
        target_frame_id: "f2",
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  // --- Script dispatch ---

  it("dispatches a script referencing nextTextFrame", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        source_frame_id: "f1",
        target_frame_id: "f2",
        story_length_after: 42,
      },
    });

    await threadTextFramesTool.handler({
      document_id: "doc-1",
      source_frame_id: "f1",
      target_frame_id: "f2",
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("nextTextFrame");
    expect(arg.scriptTemplate).toContain("findFrameById");
    expect(arg.scriptTemplate).toContain("parentStory");
  });

  it("includes idempotency check in the script", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        source_frame_id: "f1",
        target_frame_id: "f2",
        story_length_after: 42,
      },
    });

    await threadTextFramesTool.handler({
      document_id: "doc-1",
      source_frame_id: "f1",
      target_frame_id: "f2",
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    // Script should check if frames are already threaded before assigning.
    // InDesign returns `null` for an unthreaded `nextTextFrame`.
    expect(arg.scriptTemplate).toContain("!== null");
    expect(arg.scriptTemplate).toContain("alreadyLinked");
  });

  it("includes TextFrame validation for both frames", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        source_frame_id: "f1",
        target_frame_id: "f2",
        story_length_after: 0,
      },
    });

    await threadTextFramesTool.handler({
      document_id: "doc-1",
      source_frame_id: "f1",
      target_frame_id: "f2",
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("TextFrame");
    expect(arg.scriptTemplate).toContain("invalid_args");
    // Both frame IDs should appear in the script.
    expect(arg.scriptTemplate).toContain("f1");
    expect(arg.scriptTemplate).toContain("f2");
  });

  // --- Return value ---

  it("returns source_frame_id, target_frame_id, story_length_after, and changed_frames delta", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        source_frame_id: "f1",
        target_frame_id: "f2",
        story_length_after: 100,
      },
    });

    const env = await threadTextFramesTool.handler({
      document_id: "doc-1",
      source_frame_id: "f1",
      target_frame_id: "f2",
    });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.result).toEqual({
      source_frame_id: "f1",
      target_frame_id: "f2",
      story_length_after: 100,
    });
    expect(env.document_state_delta).toEqual({
      changed_frames: [{ id: "f1", threaded_to_frame_id: "f2" }],
    });
  });

  it("propagates not_found failures verbatim", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: false,
      error: {
        kind: "not_found",
        message: "frame not found",
        entity: "frame",
        id: "f2",
      },
    });

    const env = await threadTextFramesTool.handler({
      document_id: "doc-1",
      source_frame_id: "f1",
      target_frame_id: "f2",
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
        message: "target is not a text frame",
        entity: "frame",
        id: "f2",
      },
    });

    const env = await threadTextFramesTool.handler({
      document_id: "doc-1",
      source_frame_id: "f1",
      target_frame_id: "f2",
    });

    expectFailure(env);
    expect(env.error.kind).toBe("invalid_args");
  });
});

// ---------------------------------------------------------------------------
// Stage B9-S5 tamper tests: TTF-T1 – TTF-T5
// ---------------------------------------------------------------------------
const tamperTTF = vi.hoisted(() => ({
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
        if (tamperTTF.mode === "forged")
          return actual.wrapExtendScript(body, { _mutateToken: {}, documentId: opts.documentId });
        if (tamperTTF.mode === "replay") {
          actual.wrapExtendScript(body, opts);
          tamperTTF.firstConsumeOk++;
          return actual.wrapExtendScript(body, opts);
        }
        if (tamperTTF.mode === "wrong_doc")
          return actual.wrapExtendScript(body, { _mutateToken: opts._mutateToken, documentId: "doc-EVIL" });
        if (tamperTTF.mode === "body_swap")
          return actual.wrapExtendScript("var evil = 1; return {};", { _mutateToken: opts._mutateToken, documentId: opts.documentId });
      }
      return actual.wrapExtendScript(...args);
    },
  };
});

describe("thread_text_frames — Stage B9-S5 tamper tests", () => {
  const validInput = {
    document_id: "doc-1",
    source_frame_id: "f1",
    target_frame_id: "f2",
  };

  beforeEach(() => {
    tamperTTF.mode = "passthrough";
    tamperTTF.firstConsumeOk = 0;
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("TTF-T2: forged token → throws; sendFn not called", async () => {
    tamperTTF.mode = "forged";
    await expect(threadTextFramesTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("TTF-T3: replay → first consume succeeds, second rejected; sendFn not called", async () => {
    tamperTTF.mode = "replay";
    await expect(threadTextFramesTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
    expect(tamperTTF.firstConsumeOk).toBe(1);
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("TTF-T4: wrong_doc → documentId mismatch → throws; sendFn not called", async () => {
    tamperTTF.mode = "wrong_doc";
    await expect(threadTextFramesTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: documentId mismatch",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("TTF-T5: body_swap → body mismatch → throws; sendFn not called", async () => {
    tamperTTF.mode = "body_swap";
    await expect(threadTextFramesTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: body mismatch",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("TTF-T1: happy path — sendFn called exactly once when no tamper", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        source_frame_id: "f1",
        target_frame_id: "f2",
        story_length_after: 42,
      },
    });
    await threadTextFramesTool.handler(validInput);
    expect(vi.mocked(runScriptWithResultFile)).toHaveBeenCalledOnce();
  });
});
