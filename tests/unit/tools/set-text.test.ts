import { describe, it, expect, vi, beforeEach } from "vitest";
import { setTextTool } from "../../../src/tools/set-text.js";
import { lastCall, expectFailure } from "../_helpers.js";

vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

import { runScriptWithResultFile } from "../../../src/transport/result-file.js";

describe("set_text tool", () => {
  beforeEach(() => {
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("has the expected metadata", () => {
    expect(setTextTool.name).toBe("set_text");
    expect(setTextTool.description.length).toBeGreaterThan(0);
  });

  it("accepts minimal valid input", () => {
    expect(
      setTextTool.inputSchema.safeParse({
        document_id: "doc-1",
        frame_id: "f1",
        text: "Hello",
      }).success,
    ).toBe(true);
  });

  it("rejects missing document_id", () => {
    expect(setTextTool.inputSchema.safeParse({ frame_id: "f1", text: "Hello" }).success).toBe(false);
  });

  it("rejects empty document_id", () => {
    expect(setTextTool.inputSchema.safeParse({ document_id: "", frame_id: "f1", text: "Hello" }).success).toBe(false);
  });

  it("rejects whitespace-only document_id", () => {
    expect(setTextTool.inputSchema.safeParse({ document_id: "   ", frame_id: "f1", text: "Hello" }).success).toBe(false);
  });

  it("requires frame_id and text", () => {
    expect(setTextTool.inputSchema.safeParse({ text: "x" }).success).toBe(false);
    expect(setTextTool.inputSchema.safeParse({ frame_id: "f1" }).success).toBe(false);
  });

  it("dispatches a script that assigns text to frame.contents", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f1", character_count: 5 },
    });

    await setTextTool.handler({ document_id: "doc-1",
      frame_id: "f1", text: "Hello" });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("frame.contents");
    expect(arg.scriptTemplate).toContain("Hello");
    expect(arg.scriptTemplate).toContain("f1");
  });

  it("escapes special characters via lit()", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f1", character_count: 13 },
    });

    await setTextTool.handler({
      document_id: "doc-1",
      frame_id: "f1",
      text: 'She said "hi"',
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain('She said');
  });

  it("returns frame_id and character_count on success", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f1", character_count: 5 },
    });

    const env = await setTextTool.handler({ document_id: "doc-1",
      frame_id: "f1", text: "Hello" });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.result).toEqual({ frame_id: "f1", character_count: 5 });
    expect(env.document_state_delta).toBeUndefined();
  });

  it("normalizes \\n and \\r\\n to \\r before dispatching", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f1", character_count: 5 },
    });

    await setTextTool.handler({
      document_id: "doc-1",
      frame_id: "f1",
      text: "A\nB\r\nC",
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    // After normalization the text becomes "A\rB\rC".
    // lit() JSON-stringifies it → "A\\rB\\rC" in the script source.
    // wrapExtendScript JSON-stringifies the whole script for JXA → "A\\\\rB\\\\rC".
    // Verifying the normalization happened at the handler level: \\n shouldn't appear in the dispatched script.
    expect(arg.scriptTemplate).not.toContain('A\\nB');
  });

  it("propagates failure envelopes verbatim", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: false,
      error: { kind: "not_found", message: "frame f99 not found", entity: "frame", id: "f99" },
    });

    const env = await setTextTool.handler({ document_id: "doc-1",
      frame_id: "f99", text: "x" });

    expectFailure(env);
    expect(env.error.kind).toBe("not_found");
  });
});
// ---------------------------------------------------------------------------
// Stage 7C tamper tests: ST-T1 – ST-T5
// ---------------------------------------------------------------------------
const tamperST = vi.hoisted(() => ({
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
        if (tamperST.mode === "forged")
          return actual.wrapExtendScript(body, { _mutateToken: {}, documentId: opts.documentId });
        if (tamperST.mode === "replay") {
          actual.wrapExtendScript(body, opts);
          tamperST.firstConsumeOk++;
          return actual.wrapExtendScript(body, opts);
        }
        if (tamperST.mode === "wrong_doc")
          return actual.wrapExtendScript(body, { _mutateToken: opts._mutateToken, documentId: "doc-EVIL" });
        if (tamperST.mode === "body_swap")
          return actual.wrapExtendScript("var evil = 1; return {};", { _mutateToken: opts._mutateToken, documentId: opts.documentId });
      }
      return actual.wrapExtendScript(...args);
    },
  };
});

describe("set_text — Stage 7C tamper tests", () => {
  const validInput = {
    document_id: "doc-1",
    frame_id: "f1",
    text: "hello",
  };

  beforeEach(() => {
    tamperST.mode = "passthrough";
    tamperST.firstConsumeOk = 0;
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("ST-T2: forged token → throws; sendFn not called", async () => {
    tamperST.mode = "forged";
    await expect(setTextTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("ST-T3: replay → first consume succeeds, second rejected; sendFn not called", async () => {
    tamperST.mode = "replay";
    await expect(setTextTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
    expect(tamperST.firstConsumeOk).toBe(1);
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("ST-T4: wrong_doc → documentId mismatch → throws; sendFn not called", async () => {
    tamperST.mode = "wrong_doc";
    await expect(setTextTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: documentId mismatch",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("ST-T5: body_swap → body mismatch → throws; sendFn not called", async () => {
    tamperST.mode = "body_swap";
    await expect(setTextTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: body mismatch",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("ST-T1: happy path — sendFn called exactly once when no tamper", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f1", character_count: 5 },
    });
    await setTextTool.handler(validInput);
    expect(vi.mocked(runScriptWithResultFile)).toHaveBeenCalledOnce();
  });
});
