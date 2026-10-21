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
