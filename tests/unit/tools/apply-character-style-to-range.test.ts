import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyCharacterStyleToRangeTool } from "../../../src/tools/apply-character-style-to-range.js";
import { lastCall, expectFailure } from "../_helpers.js";

vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

import { runScriptWithResultFile } from "../../../src/transport/result-file.js";

describe("apply_character_style_to_range tool", () => {
  beforeEach(() => {
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("has the expected metadata", () => {
    expect(applyCharacterStyleToRangeTool.name).toBe("apply_character_style_to_range");
    expect(applyCharacterStyleToRangeTool.description.length).toBeGreaterThan(0);
  });

  // --- Schema validation ---

  it("accepts valid minimal input", () => {
    expect(
      applyCharacterStyleToRangeTool.inputSchema.safeParse({
        frame_id: "f1",
        character_style_name: "Accent",
        start_index: 0,
        end_index: 5,
      }).success,
    ).toBe(true);
  });

  it("rejects empty frame_id", () => {
    expect(
      applyCharacterStyleToRangeTool.inputSchema.safeParse({
        frame_id: "",
        character_style_name: "Accent",
        start_index: 0,
        end_index: 5,
      }).success,
    ).toBe(false);
  });

  it("rejects empty character_style_name", () => {
    expect(
      applyCharacterStyleToRangeTool.inputSchema.safeParse({
        frame_id: "f1",
        character_style_name: "",
        start_index: 0,
        end_index: 5,
      }).success,
    ).toBe(false);
  });

  it("rejects start_index < 0", () => {
    expect(
      applyCharacterStyleToRangeTool.inputSchema.safeParse({
        frame_id: "f1",
        character_style_name: "Accent",
        start_index: -1,
        end_index: 5,
      }).success,
    ).toBe(false);
  });

  it("rejects end_index <= start_index", () => {
    expect(
      applyCharacterStyleToRangeTool.inputSchema.safeParse({
        frame_id: "f1",
        character_style_name: "Accent",
        start_index: 5,
        end_index: 5,
      }).success,
    ).toBe(false);
    expect(
      applyCharacterStyleToRangeTool.inputSchema.safeParse({
        frame_id: "f1",
        character_style_name: "Accent",
        start_index: 5,
        end_index: 3,
      }).success,
    ).toBe(false);
  });

  it("accepts optional document_id", () => {
    expect(
      applyCharacterStyleToRangeTool.inputSchema.safeParse({
        frame_id: "f1",
        character_style_name: "Accent",
        start_index: 0,
        end_index: 5,
        document_id: "doc1",
      }).success,
    ).toBe(true);
  });

  // --- Script dispatch ---

  it("dispatches a script that references itemByRange with end_index - 1", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        frame_id: "f1",
        character_style_name: "Accent",
        start_index: 10,
        end_index: 13,
        applied_chars: 3,
      },
    });

    await applyCharacterStyleToRangeTool.handler({
      frame_id: "f1",
      character_style_name: "Accent",
      start_index: 10,
      end_index: 13,
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("itemByRange");
    // end_index - 1 = 12 — verify the translated value appears
    expect(arg.scriptTemplate).toContain("12");
    expect(arg.scriptTemplate).toContain("applyCharacterStyle");
  });

  it("dispatches a script that bounds-checks end_index against story length", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        frame_id: "f1",
        character_style_name: "Accent",
        start_index: 0,
        end_index: 5,
        applied_chars: 5,
      },
    });

    await applyCharacterStyleToRangeTool.handler({
      frame_id: "f1",
      character_style_name: "Accent",
      start_index: 0,
      end_index: 5,
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("characters.length");
    expect(arg.scriptTemplate).toContain("invalid_args");
  });

  it("dispatches a script that calls findCharacterStyleByName", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        frame_id: "f1",
        character_style_name: "Accent",
        start_index: 0,
        end_index: 5,
        applied_chars: 5,
      },
    });

    await applyCharacterStyleToRangeTool.handler({
      frame_id: "f1",
      character_style_name: "Accent",
      start_index: 0,
      end_index: 5,
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("findCharacterStyleByName");
    expect(arg.scriptTemplate).toContain("Accent");
  });

  // --- Result shape ---

  it("returns frame_id, character_style_name, start_index, end_index, applied_chars", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        frame_id: "f1",
        character_style_name: "Accent",
        start_index: 10,
        end_index: 13,
        applied_chars: 3,
      },
    });

    const env = await applyCharacterStyleToRangeTool.handler({
      frame_id: "f1",
      character_style_name: "Accent",
      start_index: 10,
      end_index: 13,
    });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.result?.frame_id).toBe("f1");
    expect(env.result?.character_style_name).toBe("Accent");
    expect(env.result?.start_index).toBe(10);
    expect(env.result?.end_index).toBe(13);
    expect(env.result?.applied_chars).toBe(3);
  });

  it("propagates not_found failures verbatim", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: false,
      error: { kind: "not_found", message: "character style Accent not found" },
    });

    const env = await applyCharacterStyleToRangeTool.handler({
      frame_id: "f1",
      character_style_name: "Accent",
      start_index: 0,
      end_index: 5,
    });

    expectFailure(env);
    expect(env.error.kind).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// Stage 7C tamper tests: AC-T1 – AC-T5
// ---------------------------------------------------------------------------

const tamperAC = vi.hoisted(() => ({
  mode: "passthrough" as
    | "passthrough"
    | "forged"
    | "replay"
    | "wrong_doc"
    | "body_swap",
}));

vi.mock("../../../src/compose.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/compose.js")>();
  return {
    ...actual,
    wrapExtendScript: (...args: Parameters<typeof actual.wrapExtendScript>) => {
      const [body, opts] = args;
      if (opts !== undefined && "_mutateToken" in opts) {
        if (tamperAC.mode === "forged")
          return actual.wrapExtendScript(body, {
            _mutateToken: {},
            documentId: opts.documentId,
          });
        if (tamperAC.mode === "replay") {
          actual.wrapExtendScript(body, opts);
          return actual.wrapExtendScript(body, opts);
        }
        if (tamperAC.mode === "wrong_doc")
          return actual.wrapExtendScript(body, {
            _mutateToken: opts._mutateToken,
            documentId: "doc-EVIL",
          });
        if (tamperAC.mode === "body_swap")
          return actual.wrapExtendScript("var evil = 1; return {};", {
            _mutateToken: opts._mutateToken,
            documentId: opts.documentId,
          });
      }
      return actual.wrapExtendScript(...args);
    },
  };
});

describe("apply_character_style_to_range — Stage 7C tamper tests", () => {
  const validInput = {
    frame_id: "f1",
    character_style_name: "Accent",
    start_index: 0,
    end_index: 5,
  };

  beforeEach(() => {
    tamperAC.mode = "passthrough";
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("AC-T1: happy path — sendFn called exactly once when no tamper", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        frame_id: "f1",
        character_style_name: "Accent",
        start_index: 0,
        end_index: 5,
        affected_characters: 5,
      },
    });
    await applyCharacterStyleToRangeTool.handler(validInput);
    expect(vi.mocked(runScriptWithResultFile)).toHaveBeenCalledOnce();
  });

  it("AC-T2: forged token → real wrapExtendScript → throws; sendFn not called", async () => {
    tamperAC.mode = "forged";
    await expect(applyCharacterStyleToRangeTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("AC-T3: replay → second consume throws; sendFn not called", async () => {
    tamperAC.mode = "replay";
    await expect(applyCharacterStyleToRangeTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("AC-T4: wrong_doc → documentId mismatch → throws; sendFn not called", async () => {
    tamperAC.mode = "wrong_doc";
    await expect(applyCharacterStyleToRangeTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: documentId mismatch",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("AC-T5: body_swap → body mismatch → throws; sendFn not called", async () => {
    tamperAC.mode = "body_swap";
    await expect(applyCharacterStyleToRangeTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: body mismatch",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });
});
