import { describe, it, expect, vi, beforeEach } from "vitest";
import { listParagraphStylesTool } from "../../../src/tools/list-paragraph-styles.js";
import { lastCall } from "../_helpers.js";

vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

// Tamper layer: modifies the _readToken arguments, then ALWAYS forwards to the
// real wrapExtendScript, so the real consumeReadToken enforcement runs.
const tamper = vi.hoisted(() => ({
  mode: "passthrough" as "passthrough" | "forged" | "wrong_doc" | "replay",
}));

vi.mock("../../../src/compose.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/compose.js")>();
  return {
    ...actual,
    wrapExtendScript: (...args: Parameters<typeof actual.wrapExtendScript>) => {
      const [body, opts] = args;
      if (opts !== undefined && "_readToken" in opts) {
        if (tamper.mode === "forged") {
          return actual.wrapExtendScript(body, { _readToken: {}, documentId: opts.documentId });
        }
        if (tamper.mode === "wrong_doc") {
          return actual.wrapExtendScript(body, { _readToken: opts._readToken, documentId: "doc-B" });
        }
        if (tamper.mode === "replay") {
          actual.wrapExtendScript(body, opts); // first use consumes the token
          return actual.wrapExtendScript(body, opts); // same, already-consumed token
        }
      }
      return actual.wrapExtendScript(...args);
    },
  };
});

import { runScriptWithResultFile } from "../../../src/transport/result-file.js";

describe("list_paragraph_styles tool", () => {
  beforeEach(() => {
    vi.mocked(runScriptWithResultFile).mockReset();
    tamper.mode = "passthrough";
  });

  it("has the expected metadata", () => {
    expect(listParagraphStylesTool.name).toBe("list_paragraph_styles");
    expect(listParagraphStylesTool.description.length).toBeGreaterThan(0);
  });

  // --- Schema validation ---

  it("rejects missing document_id", () => {
    expect(listParagraphStylesTool.inputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects empty document_id", () => {
    expect(listParagraphStylesTool.inputSchema.safeParse({ document_id: "" }).success).toBe(false);
  });

  it("rejects whitespace-only document_id", () => {
    expect(listParagraphStylesTool.inputSchema.safeParse({ document_id: "   " }).success).toBe(false);
  });

  it("accepts valid document_id", () => {
    expect(
      listParagraphStylesTool.inputSchema.safeParse({ document_id: "doc1" }).success,
    ).toBe(true);
  });

  it("rejects extra keys (strict schema)", () => {
    expect(
      listParagraphStylesTool.inputSchema.safeParse({ extra: true }).success,
    ).toBe(false);
  });

  // --- Script dispatch ---

  it("dispatches a script referencing doc.paragraphStyles", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { paragraph_styles: [] },
    });

    await listParagraphStylesTool.handler({ document_id: "doc-xyz" });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("paragraphStyles");
    expect(arg.scriptTemplate).toContain("pointSize");
    expect(arg.scriptTemplate).toContain("fillColor");
  });

  it("skips names starting with [ in the script", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { paragraph_styles: [] },
    });

    await listParagraphStylesTool.handler({ document_id: "doc-xyz" });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    // The script should filter out styles whose name starts with "["
    expect(arg.scriptTemplate).toContain("[");
    expect(arg.scriptTemplate).toContain("charAt");
  });

  // --- Result shape ---

  it("returns paragraph_styles array", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        paragraph_styles: [
          { name: "Body", point_size: 11, leading_pt: 14, color_swatch_name: "Black" },
          { name: "Headline", point_size: 36 },
        ],
      },
    });

    const env = await listParagraphStylesTool.handler({ document_id: "doc-xyz" });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.result?.paragraph_styles).toHaveLength(2);
    expect(env.result?.paragraph_styles[0].name).toBe("Body");
    expect(env.result?.paragraph_styles[0].point_size).toBe(11);
    expect(env.result?.paragraph_styles[0].leading_pt).toBe(14);
    expect(env.result?.paragraph_styles[1].name).toBe("Headline");
    expect(env.result?.paragraph_styles[1].leading_pt).toBeUndefined();
  });

  it("does not emit a document_state_delta (read-only)", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { paragraph_styles: [] },
    });

    const env = await listParagraphStylesTool.handler({ document_id: "doc-xyz" });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.document_state_delta).toBeUndefined();
  });

  // --- ReadToken enforcement (Stage 7B) ---

  it("PS-T1: valid token (null documentId) — sendFn is called", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { paragraph_styles: [] },
    });

    await listParagraphStylesTool.handler({ document_id: "doc-xyz" });

    expect(vi.mocked(runScriptWithResultFile)).toHaveBeenCalledTimes(1);
  });

  it("PS-T2: valid token (string documentId) — sendFn is called", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { paragraph_styles: [] },
    });

    await listParagraphStylesTool.handler({ document_id: "doc-abc" });

    expect(vi.mocked(runScriptWithResultFile)).toHaveBeenCalledTimes(1);
    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("doc-abc");
  });

  it("PS-T3: forged token — real wrapExtendScript rejects, sendFn is NOT called", async () => {
    tamper.mode = "forged";
    await expect(listParagraphStylesTool.handler({ document_id: "doc-xyz" })).rejects.toThrow(
      "read_not_authorized: token not issued by this guard",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("PS-T4: documentId mismatch — real wrapExtendScript rejects, sendFn is NOT called", async () => {
    tamper.mode = "wrong_doc";
    await expect(listParagraphStylesTool.handler({ document_id: "doc-A" })).rejects.toThrow(
      "read_not_authorized: documentId mismatch",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("PS-T5: token replay — second use of the consumed token is rejected, sendFn is NOT called", async () => {
    tamper.mode = "replay";
    await expect(listParagraphStylesTool.handler({ document_id: "doc-xyz" })).rejects.toThrow(
      "read_not_authorized: token not issued by this guard",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });
});
