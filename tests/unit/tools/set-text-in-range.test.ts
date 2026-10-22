import { describe, it, expect, vi, beforeEach } from "vitest";
import { setTextInRangeTool } from "../../../src/tools/set-text-in-range.js";
import { lastCall, expectFailure } from "../_helpers.js";

vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

import { runScriptWithResultFile } from "../../../src/transport/result-file.js";

describe("set_text_in_range tool", () => {
  beforeEach(() => {
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("has the expected metadata", () => {
    expect(setTextInRangeTool.name).toBe("set_text_in_range");
    expect(setTextInRangeTool.description.length).toBeGreaterThan(0);
  });

  // --- Schema validation ---

  it("accepts valid input with non-empty text", () => {
    expect(
      setTextInRangeTool.inputSchema.safeParse({
        document_id: "doc-1",
        frame_id: "f1",
        start_index: 0,
        end_index: 5,
        text: "world",
      }).success,
    ).toBe(true);
  });

  it("accepts empty text (deletion)", () => {
    expect(
      setTextInRangeTool.inputSchema.safeParse({
        document_id: "doc-1",
        frame_id: "f1",
        start_index: 0,
        end_index: 5,
        text: "",
      }).success,
    ).toBe(true);
  });

  it("rejects missing document_id", () => {
    expect(setTextInRangeTool.inputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects empty document_id", () => {
    expect(setTextInRangeTool.inputSchema.safeParse({ document_id: "" }).success).toBe(false);
  });

  it("rejects whitespace-only document_id", () => {
    expect(setTextInRangeTool.inputSchema.safeParse({ document_id: "   " }).success).toBe(false);
  });

  it("rejects empty frame_id", () => {
    expect(
      setTextInRangeTool.inputSchema.safeParse({
        document_id: "doc-1",
        frame_id: "",
        start_index: 0,
        end_index: 5,
        text: "hi",
      }).success,
    ).toBe(false);
  });

  it("rejects start_index < 0", () => {
    expect(
      setTextInRangeTool.inputSchema.safeParse({
        document_id: "doc-1",
        frame_id: "f1",
        start_index: -1,
        end_index: 5,
        text: "hi",
      }).success,
    ).toBe(false);
  });

  it("rejects end_index <= start_index", () => {
    expect(
      setTextInRangeTool.inputSchema.safeParse({
        document_id: "doc-1",
        frame_id: "f1",
        start_index: 5,
        end_index: 5,
        text: "hi",
      }).success,
    ).toBe(false);
    expect(
      setTextInRangeTool.inputSchema.safeParse({
        document_id: "doc-1",
        frame_id: "f1",
        start_index: 6,
        end_index: 3,
        text: "hi",
      }).success,
    ).toBe(false);
  });

  it("accepts valid document_id", () => {
    expect(
      setTextInRangeTool.inputSchema.safeParse({
        frame_id: "f1",
        start_index: 0,
        end_index: 5,
        text: "hello",
        document_id: "doc1",
      }).success,
    ).toBe(true);
  });

  // --- Normalization ---

  it("normalizes CRLF to CR before dispatching", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        frame_id: "f1",
        removed_chars: 5,
        inserted_chars: 3,
        total_length_after: 8,
      },
    });

    await setTextInRangeTool.handler({
      document_id: "doc-1",
      frame_id: "f1",
      start_index: 0,
      end_index: 5,
      text: "a\r\nb",
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    // After normalization \r\n → \r, the text is "a\rb". The encoded literal
    // in the script should not contain "a\\nb" (un-normalized CRLF would produce
    // "a\\r\\nb", LF alone would produce "a\\nb").
    expect(arg.scriptTemplate).not.toContain("a\\nb");
  });

  it("normalizes bare LF to CR before dispatching", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        frame_id: "f1",
        removed_chars: 5,
        inserted_chars: 3,
        total_length_after: 8,
      },
    });

    await setTextInRangeTool.handler({
      document_id: "doc-1",
      frame_id: "f1",
      start_index: 0,
      end_index: 5,
      text: "a\nb",
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    // After normalization \n → \r, the encoded literal should not contain "a\\nb".
    expect(arg.scriptTemplate).not.toContain("a\\nb");
  });

  // --- Script dispatch ---

  it("dispatches a script that uses itemByRange and sets contents", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        frame_id: "f1",
        removed_chars: 5,
        inserted_chars: 5,
        total_length_after: 10,
      },
    });

    await setTextInRangeTool.handler({
      document_id: "doc-1",
      frame_id: "f1",
      start_index: 0,
      end_index: 5,
      text: "world",
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("itemByRange");
    expect(arg.scriptTemplate).toContain("range.contents");
  });

  it("dispatches a script that bounds-checks end_index", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        frame_id: "f1",
        removed_chars: 5,
        inserted_chars: 5,
        total_length_after: 10,
      },
    });

    await setTextInRangeTool.handler({
      document_id: "doc-1",
      frame_id: "f1",
      start_index: 0,
      end_index: 5,
      text: "world",
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("characters.length");
    expect(arg.scriptTemplate).toContain("invalid_args");
  });

  it("dispatches a script that reads total_length_after from parentStory.length", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        frame_id: "f1",
        removed_chars: 5,
        inserted_chars: 5,
        total_length_after: 10,
      },
    });

    await setTextInRangeTool.handler({
      document_id: "doc-1",
      frame_id: "f1",
      start_index: 0,
      end_index: 5,
      text: "world",
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("parentStory.length");
  });

  // --- Result shape ---

  it("returns frame_id, removed_chars, inserted_chars, total_length_after", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        frame_id: "f1",
        removed_chars: 6,
        inserted_chars: 11,
        total_length_after: 30,
      },
    });

    const env = await setTextInRangeTool.handler({
      document_id: "doc-1",
      frame_id: "f1",
      start_index: 7,
      end_index: 13,
      text: "individuals",
    });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.result?.frame_id).toBe("f1");
    expect(env.result?.removed_chars).toBe(6);
    expect(env.result?.inserted_chars).toBe(11);
    expect(env.result?.total_length_after).toBe(30);
  });

  it("propagates not_found failures verbatim", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: false,
      error: { kind: "not_found", message: "frame f1 not found" },
    });

    const env = await setTextInRangeTool.handler({
      document_id: "doc-1",
      frame_id: "f1",
      start_index: 0,
      end_index: 5,
      text: "hi",
    });

    expectFailure(env);
    expect(env.error.kind).toBe("not_found");
  });

  it("emits a changed_frames delta on success", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f1", removed_chars: 5, inserted_chars: 2, total_length_after: 18 },
    });

    const env = await setTextInRangeTool.handler({
      document_id: "doc-1",
      frame_id: "f1",
      start_index: 0,
      end_index: 5,
      text: "hi",
    });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.document_state_delta).toEqual({
      changed_frames: [{ id: "f1" }],
    });
  });
});
// ---------------------------------------------------------------------------
// Stage 7C tamper tests: STIR-T1 – STIR-T5
// ---------------------------------------------------------------------------
const tamperSTIR = vi.hoisted(() => ({
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
        if (tamperSTIR.mode === "forged")
          return actual.wrapExtendScript(body, { _mutateToken: {}, documentId: opts.documentId });
        if (tamperSTIR.mode === "replay") {
          actual.wrapExtendScript(body, opts);
          tamperSTIR.firstConsumeOk++;
          return actual.wrapExtendScript(body, opts);
        }
        if (tamperSTIR.mode === "wrong_doc")
          return actual.wrapExtendScript(body, { _mutateToken: opts._mutateToken, documentId: "doc-EVIL" });
        if (tamperSTIR.mode === "body_swap")
          return actual.wrapExtendScript("var evil = 1; return {};", { _mutateToken: opts._mutateToken, documentId: opts.documentId });
      }
      return actual.wrapExtendScript(...args);
    },
  };
});

describe("set_text_in_range — Stage 7C tamper tests", () => {
  const validInput = {
    document_id: "doc-1",
    frame_id: "f1",
    start_index: 0,
    end_index: 3,
    text: "hi",
  };

  beforeEach(() => {
    tamperSTIR.mode = "passthrough";
    tamperSTIR.firstConsumeOk = 0;
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("STIR-T2: forged token → throws; sendFn not called", async () => {
    tamperSTIR.mode = "forged";
    await expect(setTextInRangeTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("STIR-T3: replay → first consume succeeds, second rejected; sendFn not called", async () => {
    tamperSTIR.mode = "replay";
    await expect(setTextInRangeTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
    expect(tamperSTIR.firstConsumeOk).toBe(1);
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("STIR-T4: wrong_doc → documentId mismatch → throws; sendFn not called", async () => {
    tamperSTIR.mode = "wrong_doc";
    await expect(setTextInRangeTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: documentId mismatch",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("STIR-T5: body_swap → body mismatch → throws; sendFn not called", async () => {
    tamperSTIR.mode = "body_swap";
    await expect(setTextInRangeTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: body mismatch",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("STIR-T1: happy path — sendFn called exactly once when no tamper", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f1", removed_chars: 3, inserted_chars: 2, total_length_after: 10 },
    });
    await setTextInRangeTool.handler(validInput);
    expect(vi.mocked(runScriptWithResultFile)).toHaveBeenCalledOnce();
  });
});
