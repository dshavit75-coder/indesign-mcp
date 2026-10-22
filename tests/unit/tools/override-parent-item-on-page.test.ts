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

// ---------------------------------------------------------------------------
// Stage B9-S4 tamper tests: OPIOP-T1 – OPIOP-T5
// ---------------------------------------------------------------------------
const tamperOPIOP = vi.hoisted(() => ({
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
        if (tamperOPIOP.mode === "forged")
          return actual.wrapExtendScript(body, { _mutateToken: {}, documentId: opts.documentId });
        if (tamperOPIOP.mode === "replay") {
          actual.wrapExtendScript(body, opts);
          tamperOPIOP.firstConsumeOk++;
          return actual.wrapExtendScript(body, opts);
        }
        if (tamperOPIOP.mode === "wrong_doc")
          return actual.wrapExtendScript(body, { _mutateToken: opts._mutateToken, documentId: "doc-EVIL" });
        if (tamperOPIOP.mode === "body_swap")
          return actual.wrapExtendScript("var evil = 1; return {};", { _mutateToken: opts._mutateToken, documentId: opts.documentId });
      }
      return actual.wrapExtendScript(...args);
    },
  };
});

describe("override_parent_item_on_page — Stage B9-S4 tamper tests", () => {
  const validInput = {
    document_id: "doc-1",
    page_id: "pg1",
    parent_item_id: "fi1",
  };

  beforeEach(() => {
    tamperOPIOP.mode = "passthrough";
    tamperOPIOP.firstConsumeOk = 0;
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("OPIOP-T2: forged token → throws; sendFn not called", async () => {
    tamperOPIOP.mode = "forged";
    await expect(overrideParentItemOnPageTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("OPIOP-T3: replay → first consume succeeds, second rejected; sendFn not called", async () => {
    tamperOPIOP.mode = "replay";
    await expect(overrideParentItemOnPageTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
    expect(tamperOPIOP.firstConsumeOk).toBe(1);
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("OPIOP-T4: wrong_doc → documentId mismatch → throws; sendFn not called", async () => {
    tamperOPIOP.mode = "wrong_doc";
    await expect(overrideParentItemOnPageTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: documentId mismatch",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("OPIOP-T5: body_swap → body mismatch → throws; sendFn not called", async () => {
    tamperOPIOP.mode = "body_swap";
    await expect(overrideParentItemOnPageTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: body mismatch",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("OPIOP-T1: happy path — sendFn called exactly once when no tamper", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        page_id: "pg1",
        source_parent_item_id: "fi1",
        overridden_frame_id: "f99",
        frame_type: "text",
      },
    });
    await overrideParentItemOnPageTool.handler(validInput);
    expect(vi.mocked(runScriptWithResultFile)).toHaveBeenCalledOnce();
  });
});
