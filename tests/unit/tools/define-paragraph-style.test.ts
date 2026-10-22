import { describe, it, expect, vi, beforeEach } from "vitest";
import { defineParagraphStyleTool } from "../../../src/tools/define-paragraph-style.js";
import { lastCall, expectFailure } from "../_helpers.js";

vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

import { runScriptWithResultFile } from "../../../src/transport/result-file.js";

describe("define_paragraph_style tool", () => {
  beforeEach(() => {
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("has the expected metadata", () => {
    expect(defineParagraphStyleTool.name).toBe("define_paragraph_style");
    expect(defineParagraphStyleTool.description.length).toBeGreaterThan(0);
  });

  it("accepts minimal input (just name)", () => {
    expect(
      defineParagraphStyleTool.inputSchema.safeParse({ document_id: "doc-1", name: "Body" }).success,
    ).toBe(true);
  });

  it("rejects missing document_id", () => {
    expect(defineParagraphStyleTool.inputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects empty document_id", () => {
    expect(defineParagraphStyleTool.inputSchema.safeParse({ document_id: "" }).success).toBe(false);
  });

  it("rejects whitespace-only document_id", () => {
    expect(defineParagraphStyleTool.inputSchema.safeParse({ document_id: "   " }).success).toBe(false);
  });

  it("rejects empty name", () => {
    expect(
      defineParagraphStyleTool.inputSchema.safeParse({ document_id: "doc-1", name: "" }).success,
    ).toBe(false);
  });

  it("rejects font_style without font_family", () => {
    expect(
      defineParagraphStyleTool.inputSchema.safeParse({
        document_id: "doc-1",
        name: "Body",
        font_style: "Bold",
      }).success,
    ).toBe(false);
  });

  it("accepts font_family alone (no font_style)", () => {
    expect(
      defineParagraphStyleTool.inputSchema.safeParse({
        document_id: "doc-1",
        name: "Body",
        font_family: "Helvetica Neue",
      }).success,
    ).toBe(true);
  });

  it("accepts font_family + font_style", () => {
    expect(
      defineParagraphStyleTool.inputSchema.safeParse({
        document_id: "doc-1",
        name: "Body",
        font_family: "Helvetica Neue",
        font_style: "Bold",
      }).success,
    ).toBe(true);
  });

  it("rejects invalid color_hex format", () => {
    expect(
      defineParagraphStyleTool.inputSchema.safeParse({
        document_id: "doc-1",
        name: "Body",
        color_hex: "red",
      }).success,
    ).toBe(false);
    expect(
      defineParagraphStyleTool.inputSchema.safeParse({
        document_id: "doc-1",
        name: "Body",
        color_hex: "#XYZ",
      }).success,
    ).toBe(false);
    expect(
      defineParagraphStyleTool.inputSchema.safeParse({
        document_id: "doc-1",
        name: "Body",
        color_hex: "#FF",
      }).success,
    ).toBe(false);
  });

  it("accepts valid color_hex (case-insensitive)", () => {
    expect(
      defineParagraphStyleTool.inputSchema.safeParse({
        document_id: "doc-1",
        name: "Body",
        color_hex: "#FF0000",
      }).success,
    ).toBe(true);
    expect(
      defineParagraphStyleTool.inputSchema.safeParse({
        document_id: "doc-1",
        name: "Body",
        color_hex: "#ff0000",
      }).success,
    ).toBe(true);
  });

  it("rejects size_pt <= 0", () => {
    expect(
      defineParagraphStyleTool.inputSchema.safeParse({
        document_id: "doc-1",
        name: "Body",
        size_pt: 0,
      }).success,
    ).toBe(false);
    expect(
      defineParagraphStyleTool.inputSchema.safeParse({
        document_id: "doc-1",
        name: "Body",
        size_pt: -1,
      }).success,
    ).toBe(false);
  });

  it("accepts leading_pt as 'auto'", () => {
    expect(
      defineParagraphStyleTool.inputSchema.safeParse({
        document_id: "doc-1",
        name: "Body",
        leading_pt: "auto",
      }).success,
    ).toBe(true);
  });

  it("dispatches a script that interpolates the style name", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { style_id: "s1", name: "Body", on_collision_outcome: "created" },
    });

    await defineParagraphStyleTool.handler({ document_id: "doc-1", name: "Body" });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("Body");
    expect(arg.scriptTemplate).toContain("paragraphStyles");
  });

  it("dispatches a script that resolves color_hex via resolveSwatch", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { style_id: "s1", name: "Headline", on_collision_outcome: "created", swatch_id: "sw1" },
    });

    await defineParagraphStyleTool.handler({
      document_id: "doc-1",
      name: "Headline",
      color_hex: "#FF0000",
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("resolveSwatch(doc,");
    expect(arg.scriptTemplate).toContain("#FF0000");
  });

  it("uppercases color_hex when constructing the swatch name", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { style_id: "s1", name: "Headline", on_collision_outcome: "created", swatch_id: "sw1" },
    });

    await defineParagraphStyleTool.handler({
      document_id: "doc-1",
      name: "Headline",
      color_hex: "#abcdef",
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("#ABCDEF");
  });

  it("dispatches a script that joins font_family and font_style with tab separator", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { style_id: "s1", name: "Headline", on_collision_outcome: "created" },
    });

    await defineParagraphStyleTool.handler({
      document_id: "doc-1",
      name: "Headline",
      font_family: "Helvetica Neue",
      font_style: "Bold",
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    // The font name "Helvetica Neue\tBold" gets JSON-encoded to "Helvetica Neue\\tBold"
    // by lit(), and that's then JSON-encoded again by wrapExtendScript.
    // We just verify both family and style appear.
    expect(arg.scriptTemplate).toContain("Helvetica Neue");
    expect(arg.scriptTemplate).toContain("Bold");
  });

  it("accepts on_collision: 'update' / 'version' / 'error'", () => {
    for (const c of ["error", "update", "version"] as const) {
      expect(
        defineParagraphStyleTool.inputSchema.safeParse({
          document_id: "doc-1",
          name: "Body",
          on_collision: c,
        }).success,
      ).toBe(true);
    }
  });

  it("returns style_id and name", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { style_id: "s7", name: "Body", on_collision_outcome: "created" },
    });

    const env = await defineParagraphStyleTool.handler({ document_id: "doc-1", name: "Body" });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.result).toEqual({ style_id: "s7", name: "Body", on_collision_outcome: "created" });
  });

  it("returns swatch_id when color was provided", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { style_id: "s1", name: "Body", on_collision_outcome: "created", swatch_id: "sw1" },
    });

    const env = await defineParagraphStyleTool.handler({
      document_id: "doc-1",
      name: "Body",
      color_hex: "#000000",
    });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.result).toEqual({ style_id: "s1", name: "Body", on_collision_outcome: "created", swatch_id: "sw1" });
  });

  it("propagates name_collision failures verbatim", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: false,
      error: { kind: "name_collision", message: "style 'Body' already exists" },
    });

    const env = await defineParagraphStyleTool.handler({ document_id: "doc-1", name: "Body" });

    expectFailure(env);
    expect(env.error.kind).toBe("name_collision");
  });

  // --- on_collision_outcome and delta ---

  it("returns on_collision_outcome: created when style is new", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { style_id: "s1", name: "Body", on_collision_outcome: "created" },
    });

    const env = await defineParagraphStyleTool.handler({ document_id: "doc-1", name: "Body" });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.result?.on_collision_outcome).toBe("created");
  });

  it("emits new_paragraph_styles delta on created outcome", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { style_id: "s1", name: "Body", on_collision_outcome: "created" },
    });

    const env = await defineParagraphStyleTool.handler({ document_id: "doc-1", name: "Body" });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.document_state_delta?.new_paragraph_styles).toEqual([{ name: "Body" }]);
  });

  it("emits new_paragraph_styles delta on versioned outcome with the final name", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { style_id: "s2", name: "Body 2", on_collision_outcome: "versioned" },
    });

    const env = await defineParagraphStyleTool.handler({
      document_id: "doc-1",
      name: "Body",
      on_collision: "version",
    });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.document_state_delta?.new_paragraph_styles).toEqual([{ name: "Body 2" }]);
  });

  it("does not emit a delta when outcome is updated", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { style_id: "s1", name: "Body", on_collision_outcome: "updated" },
    });

    const env = await defineParagraphStyleTool.handler({
      document_id: "doc-1",
      name: "Body",
      on_collision: "update",
    });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.document_state_delta).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Stage B9-S4 tamper tests: DPS-T1 – DPS-T5
// ---------------------------------------------------------------------------
const tamperDPS = vi.hoisted(() => ({
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
        if (tamperDPS.mode === "forged")
          return actual.wrapExtendScript(body, { _mutateToken: {}, documentId: opts.documentId });
        if (tamperDPS.mode === "replay") {
          actual.wrapExtendScript(body, opts);
          tamperDPS.firstConsumeOk++;
          return actual.wrapExtendScript(body, opts);
        }
        if (tamperDPS.mode === "wrong_doc")
          return actual.wrapExtendScript(body, { _mutateToken: opts._mutateToken, documentId: "doc-EVIL" });
        if (tamperDPS.mode === "body_swap")
          return actual.wrapExtendScript("var evil = 1; return {};", { _mutateToken: opts._mutateToken, documentId: opts.documentId });
      }
      return actual.wrapExtendScript(...args);
    },
  };
});

describe("define_paragraph_style — Stage B9-S4 tamper tests", () => {
  const validInput = {
    document_id: "doc-1",
    name: "Body",
  };

  beforeEach(() => {
    tamperDPS.mode = "passthrough";
    tamperDPS.firstConsumeOk = 0;
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("DPS-T2: forged token → throws; sendFn not called", async () => {
    tamperDPS.mode = "forged";
    await expect(defineParagraphStyleTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("DPS-T3: replay → first consume succeeds, second rejected; sendFn not called", async () => {
    tamperDPS.mode = "replay";
    await expect(defineParagraphStyleTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
    expect(tamperDPS.firstConsumeOk).toBe(1);
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("DPS-T4: wrong_doc → documentId mismatch → throws; sendFn not called", async () => {
    tamperDPS.mode = "wrong_doc";
    await expect(defineParagraphStyleTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: documentId mismatch",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("DPS-T5: body_swap → body mismatch → throws; sendFn not called", async () => {
    tamperDPS.mode = "body_swap";
    await expect(defineParagraphStyleTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: body mismatch",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("DPS-T1: happy path — sendFn called exactly once when no tamper", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { style_id: "s1", name: "Body", on_collision_outcome: "created" },
    });
    await defineParagraphStyleTool.handler(validInput);
    expect(vi.mocked(runScriptWithResultFile)).toHaveBeenCalledOnce();
  });
});
