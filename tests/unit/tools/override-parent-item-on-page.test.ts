import { describe, it, expect, vi, beforeEach } from "vitest";
import { overrideParentItemOnPageTool } from "../../../src/tools/override-parent-item-on-page.js";
import { lastCall, expectFailure } from "../_helpers.js";

vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

import { runScriptWithResultFile } from "../../../src/transport/result-file.js";

describe("override_parent_item_on_page tool", () => {
  beforeEach(() => {
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("has the expected metadata", () => {
    expect(overrideParentItemOnPageTool.name).toBe("override_parent_item_on_page");
    expect(overrideParentItemOnPageTool.description.length).toBeGreaterThan(0);
  });

  it("accepts valid input with page_id and parent_item_id", () => {
    expect(
      overrideParentItemOnPageTool.inputSchema.safeParse({
        document_id: "doc-1",
        page_id: "pg1",
        parent_item_id: "fi1",
      }).success,
    ).toBe(true);
  });

  it("rejects missing document_id", () => {
    expect(overrideParentItemOnPageTool.inputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects empty document_id", () => {
    expect(overrideParentItemOnPageTool.inputSchema.safeParse({ document_id: "" }).success).toBe(false);
  });

  it("rejects whitespace-only document_id", () => {
    expect(overrideParentItemOnPageTool.inputSchema.safeParse({ document_id: "   " }).success).toBe(false);
  });

  it("rejects missing page_id", () => {
    expect(
      overrideParentItemOnPageTool.inputSchema.safeParse({
        document_id: "doc-1",
        parent_item_id: "fi1",
      }).success,
    ).toBe(false);
  });

  it("rejects missing parent_item_id", () => {
    expect(
      overrideParentItemOnPageTool.inputSchema.safeParse({
        document_id: "doc-1",
        page_id: "pg1",
      }).success,
    ).toBe(false);
  });

  it("rejects empty parent_item_id", () => {
    expect(
      overrideParentItemOnPageTool.inputSchema.safeParse({
        document_id: "doc-1",
        page_id: "pg1",
        parent_item_id: "",
      }).success,
    ).toBe(false);
  });

  it("dispatches a script using findFrameById and override", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        page_id: "pg1",
        source_parent_item_id: "fi1",
        overridden_frame_id: "lf1",
        frame_type: "text",
      },
    });

    await overrideParentItemOnPageTool.handler({
      document_id: "doc-1",
      page_id: "pg1",
      parent_item_id: "fi1",
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("findFrameById");
    expect(arg.scriptTemplate).toContain("findPageById");
    expect(arg.scriptTemplate).toContain(".override(");
    expect(arg.scriptTemplate).toContain("fi1");
    expect(arg.scriptTemplate).toContain("pg1");
  });

  it("script validates the source item is on a master spread", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        page_id: "pg1",
        source_parent_item_id: "fi1",
        overridden_frame_id: "lf1",
        frame_type: "text",
      },
    });

    await overrideParentItemOnPageTool.handler({
      document_id: "doc-1",
      page_id: "pg1",
      parent_item_id: "fi1",
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("MasterSpread");
    expect(arg.scriptTemplate).toContain("invalid_args");
  });

  it("returns overridden_frame_id and a new_frames delta", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        page_id: "pg1",
        source_parent_item_id: "fi1",
        overridden_frame_id: "lf1",
        frame_type: "text",
      },
    });

    const env = await overrideParentItemOnPageTool.handler({
      document_id: "doc-1",
      page_id: "pg1",
      parent_item_id: "fi1",
    });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.result).toEqual({
      page_id: "pg1",
      source_parent_item_id: "fi1",
      overridden_frame_id: "lf1",
    });
    expect(env.document_state_delta).toEqual({
      new_frames: [{ id: "lf1", type: "text" }],
    });
  });

  it("propagates the discriminated frame_type — image when overridden Rectangle has graphics", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        page_id: "pg1",
        source_parent_item_id: "fi1",
        overridden_frame_id: "lf2",
        frame_type: "image",
      },
    });

    const env = await overrideParentItemOnPageTool.handler({
      document_id: "doc-1",
      page_id: "pg1",
      parent_item_id: "fi1",
    });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.document_state_delta?.new_frames).toEqual([
      { id: "lf2", type: "image" },
    ]);
  });

  it("propagates invalid_args when item is not on a master spread", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: false,
      error: {
        kind: "invalid_args",
        message: "parent_item_id fi2 is not on a master spread",
      },
    });

    const env = await overrideParentItemOnPageTool.handler({
      document_id: "doc-1",
      page_id: "pg1",
      parent_item_id: "fi2",
    });

    expectFailure(env);
    expect(env.error.kind).toBe("invalid_args");
  });

  it("propagates failure envelopes verbatim", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: false,
      error: { kind: "not_found", message: "frame fi99 not found", entity: "frame" },
    });

    const env = await overrideParentItemOnPageTool.handler({
      document_id: "doc-1",
      page_id: "pg1",
      parent_item_id: "fi99",
    });

    expectFailure(env);
    expect(env.error.kind).toBe("not_found");
  });
});
