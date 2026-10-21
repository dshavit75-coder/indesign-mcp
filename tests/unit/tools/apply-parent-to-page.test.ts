import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyParentToPageTool } from "../../../src/tools/apply-parent-to-page.js";
import { lastCall, expectFailure } from "../_helpers.js";

vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

import { runScriptWithResultFile } from "../../../src/transport/result-file.js";

describe("apply_parent_to_page tool", () => {
  beforeEach(() => {
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("has the expected metadata", () => {
    expect(applyParentToPageTool.name).toBe("apply_parent_to_page");
    expect(applyParentToPageTool.description.length).toBeGreaterThan(0);
  });

  it("accepts valid input with page_id and parent_name", () => {
    expect(
      applyParentToPageTool.inputSchema.safeParse({
        document_id: "doc-1",
        page_id: "pg1",
        parent_name: "A-Footer",
      }).success,
    ).toBe(true);
  });

  it("rejects missing document_id", () => {
    expect(applyParentToPageTool.inputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects empty document_id", () => {
    expect(applyParentToPageTool.inputSchema.safeParse({ document_id: "" }).success).toBe(false);
  });

  it("rejects whitespace-only document_id", () => {
    expect(applyParentToPageTool.inputSchema.safeParse({ document_id: "   " }).success).toBe(false);
  });

  it("rejects missing page_id", () => {
    expect(
      applyParentToPageTool.inputSchema.safeParse({
        document_id: "doc-1",
        parent_name: "A-Footer",
      }).success,
    ).toBe(false);
  });

  it("rejects missing parent_name", () => {
    expect(
      applyParentToPageTool.inputSchema.safeParse({
        document_id: "doc-1",
        page_id: "pg1",
      }).success,
    ).toBe(false);
  });

  it("rejects empty page_id", () => {
    expect(
      applyParentToPageTool.inputSchema.safeParse({
        document_id: "doc-1",
        page_id: "",
        parent_name: "A-Footer",
      }).success,
    ).toBe(false);
  });

  it("rejects empty parent_name", () => {
    expect(
      applyParentToPageTool.inputSchema.safeParse({
        document_id: "doc-1",
        page_id: "pg1",
        parent_name: "",
      }).success,
    ).toBe(false);
  });

  it("dispatches a script using findPageById and findMasterSpreadByName", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { page_id: "pg1", parent_name: "A-Footer" },
    });

    await applyParentToPageTool.handler({
      document_id: "doc-1",
      page_id: "pg1",
      parent_name: "A-Footer",
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("findPageById");
    expect(arg.scriptTemplate).toContain("findMasterSpreadByName");
    expect(arg.scriptTemplate).toContain("appliedMaster");
    expect(arg.scriptTemplate).toContain("pg1");
    expect(arg.scriptTemplate).toContain("A-Footer");
  });

  it("returns page_id, parent_name, and changed_pages delta", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { page_id: "pg1", parent_name: "A-Footer" },
    });

    const env = await applyParentToPageTool.handler({
      document_id: "doc-1",
      page_id: "pg1",
      parent_name: "A-Footer",
    });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.result).toEqual({ page_id: "pg1", parent_name: "A-Footer" });
    expect(env.document_state_delta).toEqual({
      changed_pages: [{ id: "pg1", applied_parent_name: "A-Footer" }],
    });
  });

  it("propagates not_found failure when parent spread is missing", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: false,
      error: {
        kind: "not_found",
        message: 'parent spread "Z-Missing" not found',
        entity: "parent_spread",
        id: "Z-Missing",
      },
    });

    const env = await applyParentToPageTool.handler({
      document_id: "doc-1",
      page_id: "pg1",
      parent_name: "Z-Missing",
    });

    expectFailure(env);
    expect(env.error.kind).toBe("not_found");
    expect(env.error.entity).toBe("parent_spread");
  });

  it("propagates failure envelopes verbatim for page not found", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: false,
      error: { kind: "not_found", message: "page pg99 not found", entity: "page", id: "pg99" },
    });

    const env = await applyParentToPageTool.handler({
      document_id: "doc-1",
      page_id: "pg99",
      parent_name: "A-Footer",
    });

    expectFailure(env);
    expect(env.error.kind).toBe("not_found");
    expect(env.error.entity).toBe("page");
  });
});
