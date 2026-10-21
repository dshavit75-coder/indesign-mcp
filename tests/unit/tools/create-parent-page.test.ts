import { describe, it, expect, vi, beforeEach } from "vitest";
import { createParentPageTool } from "../../../src/tools/create-parent-page.js";
import { lastCall, expectFailure } from "../_helpers.js";

vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

import { runScriptWithResultFile } from "../../../src/transport/result-file.js";

describe("create_parent_page tool", () => {
  beforeEach(() => {
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("has the expected metadata", () => {
    expect(createParentPageTool.name).toBe("create_parent_page");
    expect(createParentPageTool.description.length).toBeGreaterThan(0);
  });

  it("accepts minimal valid input — base_name only", () => {
    expect(
      createParentPageTool.inputSchema.safeParse({ document_id: "doc-1", base_name: "Footer" }).success,
    ).toBe(true);
  });

  it("accepts base_name with optional name_prefix and facing", () => {
    expect(
      createParentPageTool.inputSchema.safeParse({
        document_id: "doc-1",
        base_name: "Chapter",
        name_prefix: "B",
        facing: true,
      }).success,
    ).toBe(true);
  });

  it("rejects missing document_id", () => {
    expect(createParentPageTool.inputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects empty document_id", () => {
    expect(createParentPageTool.inputSchema.safeParse({ document_id: "" }).success).toBe(false);
  });

  it("rejects whitespace-only document_id", () => {
    expect(createParentPageTool.inputSchema.safeParse({ document_id: "   " }).success).toBe(false);
  });

  it("rejects empty base_name", () => {
    expect(
      createParentPageTool.inputSchema.safeParse({ document_id: "doc-1", base_name: "" }).success,
    ).toBe(false);
  });

  it("rejects base_name longer than 60 characters", () => {
    expect(
      createParentPageTool.inputSchema.safeParse({
        document_id: "doc-1",
        base_name: "A".repeat(61),
      }).success,
    ).toBe(false);
  });

  it("rejects name_prefix that is not a single uppercase letter", () => {
    expect(
      createParentPageTool.inputSchema.safeParse({
        document_id: "doc-1",
        base_name: "Footer",
        name_prefix: "AB",
      }).success,
    ).toBe(false);

    expect(
      createParentPageTool.inputSchema.safeParse({
        document_id: "doc-1",
        base_name: "Footer",
        name_prefix: "a",
      }).success,
    ).toBe(false);

    expect(
      createParentPageTool.inputSchema.safeParse({
        document_id: "doc-1",
        base_name: "Footer",
        name_prefix: "1",
      }).success,
    ).toBe(false);
  });

  it("accepts a valid single-letter uppercase name_prefix", () => {
    expect(
      createParentPageTool.inputSchema.safeParse({
        document_id: "doc-1",
        base_name: "Footer",
        name_prefix: "Z",
      }).success,
    ).toBe(true);
  });

  it("dispatches a script that calls masterSpreads.add with baseName", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { parent_name: "A-Footer", page_ids: ["ms1", "ms2"], page_count: 2 },
    });

    await createParentPageTool.handler({ document_id: "doc-1", base_name: "Footer" });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("masterSpreads.add");
    expect(arg.scriptTemplate).toContain("baseName");
    expect(arg.scriptTemplate).toContain("Footer");
  });

  it("includes namePrefix in script when provided", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { parent_name: "B-Footer", page_ids: ["ms3"], page_count: 1 },
    });

    await createParentPageTool.handler({ document_id: "doc-1", base_name: "Footer", name_prefix: "B" });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("namePrefix");
    expect(arg.scriptTemplate).toContain("\\\"B\\\"");
  });

  it("returns parent_name, page_ids, and new_parent_spreads delta", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { parent_name: "A-Footer", page_ids: ["ms1", "ms2"], page_count: 2 },
    });

    const env = await createParentPageTool.handler({ document_id: "doc-1", base_name: "Footer" });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.result).toEqual({ parent_name: "A-Footer", page_ids: ["ms1", "ms2"] });
    expect(env.document_state_delta).toEqual({
      new_parent_spreads: [{ name: "A-Footer", page_count: 2 }],
    });
  });

  it("propagates failure envelopes verbatim", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: false,
      error: { kind: "script_error", message: "bad prefix letter" },
    });

    const env = await createParentPageTool.handler({ document_id: "doc-1", base_name: "Footer" });

    expectFailure(env);
    expect(env.error.kind).toBe("script_error");
  });
});
