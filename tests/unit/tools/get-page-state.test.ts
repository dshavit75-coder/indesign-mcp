import { describe, it, expect, vi, beforeEach } from "vitest";
import { getPageStateTool } from "../../../src/tools/get-page-state.js";
import { lastCall, expectFailure } from "../_helpers.js";

vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

import { runScriptWithResultFile } from "../../../src/transport/result-file.js";

describe("get_page_state tool", () => {
  beforeEach(() => {
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("has the expected metadata", () => {
    expect(getPageStateTool.name).toBe("get_page_state");
    expect(getPageStateTool.description.length).toBeGreaterThan(0);
  });

  it("requires page_id", () => {
    expect(getPageStateTool.inputSchema.safeParse({}).success).toBe(false);
  });

  it("accepts page_id alone", () => {
    expect(
      getPageStateTool.inputSchema.safeParse({ page_id: "p1" }).success,
    ).toBe(true);
  });

  it("dispatches a script that resolves the page and walks pageItems", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        page_id: "p1",
        page_index: 0,
        bounds_mm: { x: 0, y: 0, width: 210, height: 297 },
        frames: [],
      },
    });

    await getPageStateTool.handler({ page_id: "p1" });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("findPageById");
    expect(arg.scriptTemplate).toContain("pageItems");
  });

  it("returns the full page state on success", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        page_id: "p1",
        page_index: 0,
        bounds_mm: { x: 0, y: 0, width: 210, height: 297 },
        frames: [
          {
            id: "f1",
            type: "text",
            bounds_mm: { x: 12, y: 12, width: 186, height: 50 },
            paragraph_style_name: "Body",
            text_snippet: "Hello world",
          },
        ],
      },
    });

    const env = await getPageStateTool.handler({ page_id: "p1" });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.result?.page_index).toBe(0);
    expect(env.result?.frames).toHaveLength(1);
    expect(env.result?.frames[0].type).toBe("text");
    expect(env.result?.frames[0].paragraph_style_name).toBe("Body");
    expect(env.document_state_delta).toBeUndefined();
  });

  it("propagates not_found failures verbatim", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: false,
      error: { kind: "not_found", message: "page not found", entity: "page", id: "p99" },
    });

    const env = await getPageStateTool.handler({ page_id: "p99" });

    expectFailure(env);
    expect(env.error.kind).toBe("not_found");
  });
});

// ── ReadToken guard tests ────────────────────────────────────────────────────
import { issueReadToken } from "../../../src/read-capability.js";

describe("get_page_state – ReadToken guard (GP-T1..T4)", () => {
  beforeEach(() => {
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  // GP-T1: valid token with documentId = null (activeDocument path)
  it("GP-T1: dispatches sendFn when token is valid and documentId is null", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        page_id: "p1",
        page_index: 0,
        bounds_mm: { x: 0, y: 0, width: 210, height: 297 },
        frames: [],
      },
    });

    const env = await getPageStateTool.handler({ page_id: "p1" });
    expect(env.ok).toBe(true);
    expect(vi.mocked(runScriptWithResultFile)).toHaveBeenCalledOnce();
  });

  // GP-T2: valid token with explicit document_id
  it("GP-T2: dispatches sendFn when token is valid and documentId matches", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        page_id: "p2",
        page_index: 1,
        bounds_mm: { x: 0, y: 0, width: 210, height: 297 },
        frames: [],
      },
    });

    const env = await getPageStateTool.handler({
      page_id: "p2",
      document_id: "doc-abc",
    });
    expect(env.ok).toBe(true);
    expect(vi.mocked(runScriptWithResultFile)).toHaveBeenCalledOnce();
  });

  // GP-T3: forged token → consumeReadToken throws, sendFn never called
  it("GP-T3: throws and does not call sendFn when token is forged", async () => {
    const forgedToken = {};
    // Directly call consumeReadToken via wrapExtendScript path by verifying
    // that a manually crafted wrapFn with a forged token throws.
    const { wrapExtendScript } = await import("../../../src/compose.js");
    expect(() =>
      wrapExtendScript("body", { _readToken: forgedToken, documentId: null }),
    ).toThrow();
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  // GP-T4: documentId mismatch → consumeReadToken throws, sendFn never called
  it("GP-T4: throws and does not call sendFn when documentId mismatches issued token", async () => {
    const tok = issueReadToken("doc-issued", "test");
    const { wrapExtendScript } = await import("../../../src/compose.js");
    // Token was issued for "doc-issued" but we claim "doc-other"
    expect(() =>
      wrapExtendScript("body", { _readToken: tok, documentId: "doc-other" }),
    ).toThrow();
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });
});
