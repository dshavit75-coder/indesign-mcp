import { describe, it, expect, vi, beforeEach } from "vitest";
import { addPageTool } from "../../../src/tools/add-page.js";
import { lastCall, expectFailure } from "../_helpers.js";

vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

import { runScriptWithResultFile } from "../../../src/transport/result-file.js";

describe("add_page tool", () => {
  beforeEach(() => {
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("has the expected metadata", () => {
    expect(addPageTool.name).toBe("add_page");
    expect(addPageTool.description.length).toBeGreaterThan(0);
  });

  it("rejects missing document_id", () => {
    expect(addPageTool.inputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects empty document_id", () => {
    expect(addPageTool.inputSchema.safeParse({ document_id: "" }).success).toBe(false);
  });

  it("rejects whitespace-only document_id", () => {
    expect(addPageTool.inputSchema.safeParse({ document_id: "   " }).success).toBe(false);
  });

  it("accepts valid document_id", () => {
    expect(addPageTool.inputSchema.safeParse({ document_id: "doc-1" }).success).toBe(true);
  });

  it("accepts at: 'start' / 'end'", () => {
    expect(addPageTool.inputSchema.safeParse({ document_id: "doc-1", at: "start" }).success).toBe(true);
    expect(addPageTool.inputSchema.safeParse({ document_id: "doc-1", at: "end" }).success).toBe(true);
  });

  it("accepts at: { after_page_id: '...' } and at: { before_page_id: '...' }", () => {
    expect(
      addPageTool.inputSchema.safeParse({ document_id: "doc-1", at: { after_page_id: "p1" } }).success,
    ).toBe(true);
    expect(
      addPageTool.inputSchema.safeParse({ document_id: "doc-1", at: { before_page_id: "p1" } }).success,
    ).toBe(true);
  });

  it("rejects at: 'middle' (invalid string)", () => {
    expect(addPageTool.inputSchema.safeParse({ at: "middle" }).success).toBe(false);
  });

  it("rejects at object with both after_page_id and before_page_id", () => {
    const result = addPageTool.inputSchema.safeParse({
      at: { after_page_id: "p1", before_page_id: "p2" },
    });
    expect(result.success).toBe(false);
  });

  it("dispatches a script using findDocumentById (no activeDocument fallback)", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { new_page_id: "p2", position_index: 1, page_count: 2 },
    });

    await addPageTool.handler({ document_id: "doc-1" });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("findDocumentById");
    expect(arg.scriptTemplate).not.toContain("app.activeDocument");
  });

  it("dispatches a script that resolves a document by id when document_id is given", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { new_page_id: "p2", position_index: 0, page_count: 2 },
    });

    await addPageTool.handler({ document_id: "doc-1" });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("doc-1");
  });

  it("returns new_page_id, position_index, and a state delta", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { new_page_id: "p7", position_index: 4, page_count: 5 },
    });

    const env = await addPageTool.handler({ document_id: "doc-1", at: "end" });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.result).toEqual({ new_page_id: "p7", position_index: 4 });
    expect(env.document_state_delta).toEqual({
      page_count: 5,
      new_page_ids: ["p7"],
    });
  });

  it("propagates failure envelopes verbatim", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: false,
      error: { kind: "not_found", message: "doc not found", entity: "document", id: "x" },
    });

    const env = await addPageTool.handler({ document_id: "x" });

    expectFailure(env);
    expect(env.error.kind).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// Stage B9-S5 tamper tests: AP-T1 – AP-T5
// ---------------------------------------------------------------------------
const tamperAP = vi.hoisted(() => ({
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
        if (tamperAP.mode === "forged")
          return actual.wrapExtendScript(body, { _mutateToken: {}, documentId: opts.documentId });
        if (tamperAP.mode === "replay") {
          actual.wrapExtendScript(body, opts);
          tamperAP.firstConsumeOk++;
          return actual.wrapExtendScript(body, opts);
        }
        if (tamperAP.mode === "wrong_doc")
          return actual.wrapExtendScript(body, { _mutateToken: opts._mutateToken, documentId: "doc-EVIL" });
        if (tamperAP.mode === "body_swap")
          return actual.wrapExtendScript("var evil = 1; return {};", { _mutateToken: opts._mutateToken, documentId: opts.documentId });
      }
      return actual.wrapExtendScript(...args);
    },
  };
});

describe("add_page — Stage B9-S5 tamper tests", () => {
  const validInput = {
    document_id: "doc-1",
  };

  beforeEach(() => {
    tamperAP.mode = "passthrough";
    tamperAP.firstConsumeOk = 0;
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("AP-T2: forged token → throws; sendFn not called", async () => {
    tamperAP.mode = "forged";
    await expect(addPageTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("AP-T3: replay → first consume succeeds, second rejected; sendFn not called", async () => {
    tamperAP.mode = "replay";
    await expect(addPageTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
    expect(tamperAP.firstConsumeOk).toBe(1);
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("AP-T4: wrong_doc → documentId mismatch → throws; sendFn not called", async () => {
    tamperAP.mode = "wrong_doc";
    await expect(addPageTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: documentId mismatch",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("AP-T5: body_swap → body mismatch → throws; sendFn not called", async () => {
    tamperAP.mode = "body_swap";
    await expect(addPageTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: body mismatch",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("AP-T1: happy path — sendFn called exactly once when no tamper", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { new_page_id: "p2", position_index: 1, page_count: 2 },
    });
    await addPageTool.handler(validInput);
    expect(vi.mocked(runScriptWithResultFile)).toHaveBeenCalledOnce();
  });
});
