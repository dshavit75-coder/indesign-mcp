import { describe, it, expect, vi, beforeEach } from "vitest";
import { findReplaceTool } from "../../../src/tools/find-replace.js";
import { lastCall } from "../_helpers.js";

vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

import { runScriptWithResultFile } from "../../../src/transport/result-file.js";

describe("find_replace tool", () => {
  beforeEach(() => {
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("has the expected metadata", () => {
    expect(findReplaceTool.name).toBe("find_replace");
    expect(findReplaceTool.description.length).toBeGreaterThan(0);
  });

  // --- Schema validation ---

  it("rejects missing document_id", () => {
    expect(findReplaceTool.inputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects empty document_id", () => {
    expect(findReplaceTool.inputSchema.safeParse({ document_id: "" }).success).toBe(false);
  });

  it("rejects whitespace-only document_id", () => {
    expect(findReplaceTool.inputSchema.safeParse({ document_id: "   " }).success).toBe(false);
  });

  it("requires find and replace", () => {
    expect(findReplaceTool.inputSchema.safeParse({ document_id: "doc-1", find: "a" }).success).toBe(false);
    expect(findReplaceTool.inputSchema.safeParse({ document_id: "doc-1", replace: "b" }).success).toBe(false);
    expect(findReplaceTool.inputSchema.safeParse({ document_id: "doc-1" }).success).toBe(false);
  });

  it("accepts minimal input with find and replace", () => {
    expect(
      findReplaceTool.inputSchema.safeParse({ document_id: "doc-1", find: "people", replace: "individuals" }).success,
    ).toBe(true);
  });

  it("accepts mode: literal and grep", () => {
    expect(
      findReplaceTool.inputSchema.safeParse({ document_id: "doc-1", find: "a", replace: "b", mode: "literal" }).success,
    ).toBe(true);
    expect(
      findReplaceTool.inputSchema.safeParse({ document_id: "doc-1", find: "a", replace: "b", mode: "grep" }).success,
    ).toBe(true);
  });

  it("rejects invalid mode", () => {
    expect(
      findReplaceTool.inputSchema.safeParse({ document_id: "doc-1", find: "a", replace: "b", mode: "regex" }).success,
    ).toBe(false);
  });

  it("accepts scope: document and frame", () => {
    expect(
      findReplaceTool.inputSchema.safeParse({ document_id: "doc-1", find: "a", replace: "b", scope: "document" }).success,
    ).toBe(true);
    expect(
      findReplaceTool.inputSchema.safeParse({
        document_id: "doc-1",
        find: "a",
        replace: "b",
        scope: "frame",
        frame_id: "f1",
      }).success,
    ).toBe(true);
  });

  it("rejects scope 'frame' without frame_id (refine)", () => {
    expect(
      findReplaceTool.inputSchema.safeParse({ document_id: "doc-1", find: "a", replace: "b", scope: "frame" }).success,
    ).toBe(false);
  });

  it("accepts scope 'document' without frame_id", () => {
    expect(
      findReplaceTool.inputSchema.safeParse({ document_id: "doc-1", find: "a", replace: "b", scope: "document" }).success,
    ).toBe(true);
  });

  it("frame_id is allowed (and ignored) when scope is 'document'", () => {
    // frame_id is optional — not required to be absent for document scope
    expect(
      findReplaceTool.inputSchema.safeParse({
        document_id: "doc-1",
        find: "a",
        replace: "b",
        scope: "document",
        frame_id: "f1",
      }).success,
    ).toBe(true);
  });

  it("accepts valid document_id", () => {
    expect(
      findReplaceTool.inputSchema.safeParse({
        find: "a",
        replace: "b",
        document_id: "doc1",
      }).success,
    ).toBe(true);
  });

  it("rejects extra keys (strict schema)", () => {
    expect(
      findReplaceTool.inputSchema.safeParse({ document_id: "doc-1", find: "a", replace: "b", extra: true }).success,
    ).toBe(false);
  });

  // --- Script dispatch ---

  it("dispatches a script with findTextPreferences for literal mode", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { matches_changed: 1, scope: "document", mode: "literal" },
    });

    await findReplaceTool.handler({ document_id: "doc-1", find: "people", replace: "individuals" });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("findTextPreferences");
    expect(arg.scriptTemplate).toContain("changeTextPreferences");
    expect(arg.scriptTemplate).toContain("changeText");
    expect(arg.scriptTemplate).toContain("people");
    expect(arg.scriptTemplate).toContain("individuals");
  });

  it("dispatches a script with findGrepPreferences for grep mode", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { matches_changed: 2, scope: "document", mode: "grep" },
    });

    await findReplaceTool.handler({ document_id: "doc-1", find: "\\bpeople\\b", replace: "individuals", mode: "grep" });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("findGrepPreferences");
    expect(arg.scriptTemplate).toContain("changeGrepPreferences");
    expect(arg.scriptTemplate).toContain("changeGrep");
    expect(arg.scriptTemplate).toContain("NothingEnum");
  });

  it("resets grep preferences in the script for safety (even in literal mode)", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { matches_changed: 0, scope: "document", mode: "literal" },
    });

    await findReplaceTool.handler({ document_id: "doc-1", find: "a", replace: "b" });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("NothingEnum");
    expect(arg.scriptTemplate).toContain("findGrepPreferences");
    expect(arg.scriptTemplate).toContain("changeGrepPreferences");
  });

  it("references parentStory when scope is frame", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { matches_changed: 1, scope: "frame", mode: "literal" },
    });

    await findReplaceTool.handler({
      document_id: "doc-1",
      find: "a",
      replace: "b",
      scope: "frame",
      frame_id: "f1",
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("parentStory");
    expect(arg.scriptTemplate).toContain("findFrameById");
  });

  it("validates frame is a TextFrame when scope is frame", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { matches_changed: 0, scope: "frame", mode: "literal" },
    });

    await findReplaceTool.handler({
      document_id: "doc-1",
      find: "a",
      replace: "b",
      scope: "frame",
      frame_id: "f1",
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("TextFrame");
    expect(arg.scriptTemplate).toContain("invalid_args");
  });

  // --- Result shape ---

  it("returns matches_changed, scope, mode", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { matches_changed: 3, scope: "document", mode: "literal" },
    });

    const env = await findReplaceTool.handler({ document_id: "doc-1", find: "a", replace: "b" });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.result?.matches_changed).toBe(3);
    expect(env.result?.scope).toBe("document");
    expect(env.result?.mode).toBe("literal");
  });

  it("emits empty changed_frames delta", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { matches_changed: 1, scope: "document", mode: "literal" },
    });

    const env = await findReplaceTool.handler({ document_id: "doc-1", find: "a", replace: "b" });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.document_state_delta?.changed_frames).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Stage B9-S5 tamper tests: FR-T1 – FR-T5
// ---------------------------------------------------------------------------
const tamperFR = vi.hoisted(() => ({
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
        if (tamperFR.mode === "forged")
          return actual.wrapExtendScript(body, { _mutateToken: {}, documentId: opts.documentId });
        if (tamperFR.mode === "replay") {
          actual.wrapExtendScript(body, opts);
          tamperFR.firstConsumeOk++;
          return actual.wrapExtendScript(body, opts);
        }
        if (tamperFR.mode === "wrong_doc")
          return actual.wrapExtendScript(body, { _mutateToken: opts._mutateToken, documentId: "doc-EVIL" });
        if (tamperFR.mode === "body_swap")
          return actual.wrapExtendScript("var evil = 1; return {};", { _mutateToken: opts._mutateToken, documentId: opts.documentId });
      }
      return actual.wrapExtendScript(...args);
    },
  };
});

describe("find_replace — Stage B9-S5 tamper tests", () => {
  const validInput = {
    document_id: "doc-1",
    find: "people",
    replace: "individuals",
  };

  beforeEach(() => {
    tamperFR.mode = "passthrough";
    tamperFR.firstConsumeOk = 0;
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("FR-T2: forged token → throws; sendFn not called", async () => {
    tamperFR.mode = "forged";
    await expect(findReplaceTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("FR-T3: replay → first consume succeeds, second rejected; sendFn not called", async () => {
    tamperFR.mode = "replay";
    await expect(findReplaceTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
    expect(tamperFR.firstConsumeOk).toBe(1);
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("FR-T4: wrong_doc → documentId mismatch → throws; sendFn not called", async () => {
    tamperFR.mode = "wrong_doc";
    await expect(findReplaceTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: documentId mismatch",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("FR-T5: body_swap → body mismatch → throws; sendFn not called", async () => {
    tamperFR.mode = "body_swap";
    await expect(findReplaceTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: body mismatch",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("FR-T1: happy path — sendFn called exactly once when no tamper", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { matches_changed: 1, scope: "document", mode: "literal" },
    });
    await findReplaceTool.handler(validInput);
    expect(vi.mocked(runScriptWithResultFile)).toHaveBeenCalledOnce();
  });
});
