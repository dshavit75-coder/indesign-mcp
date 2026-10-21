import { describe, it, expect, vi, beforeEach } from "vitest";
import { getPageStateTool } from "../../../src/tools/get-page-state.js";
import { lastCall, expectFailure } from "../_helpers.js";

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

vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

import { runScriptWithResultFile } from "../../../src/transport/result-file.js";

describe("get_page_state tool", () => {
  beforeEach(() => {
    vi.mocked(runScriptWithResultFile).mockReset();
    tamper.mode = "passthrough";
  });

  it("has the expected metadata", () => {
    expect(getPageStateTool.name).toBe("get_page_state");
    expect(getPageStateTool.description.length).toBeGreaterThan(0);
  });

  it("rejects missing document_id", () => {
    expect(getPageStateTool.inputSchema.safeParse({ page_id: "p1" }).success).toBe(false);
  });

  it("rejects empty document_id", () => {
    expect(getPageStateTool.inputSchema.safeParse({ document_id: "", page_id: "p1" }).success).toBe(false);
  });

  it("rejects whitespace-only document_id", () => {
    expect(getPageStateTool.inputSchema.safeParse({ document_id: "   ", page_id: "p1" }).success).toBe(false);
  });

  it("requires page_id", () => {
    expect(getPageStateTool.inputSchema.safeParse({}).success).toBe(false);
  });

  it("accepts page_id with document_id", () => {
    expect(
      getPageStateTool.inputSchema.safeParse({ document_id: "doc-1", page_id: "p1" }).success,
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

    await getPageStateTool.handler({ document_id: "doc-1", page_id: "p1" });

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

    const env = await getPageStateTool.handler({ document_id: "doc-1", page_id: "p1" });

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

    const env = await getPageStateTool.handler({ document_id: "doc-1", page_id: "p99" });

    expectFailure(env);
    expect(env.error.kind).toBe("not_found");
  });
});

// ── ReadToken guard tests ────────────────────────────────────────────────────
describe("get_page_state – ReadToken guard (GP-T1..T4)", () => {
  beforeEach(() => {
    vi.mocked(runScriptWithResultFile).mockReset();
    tamper.mode = "passthrough";
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

    const env = await getPageStateTool.handler({ document_id: "doc-1", page_id: "p1" });
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

  // GP-T3: forged token → the real consumeReadToken rejects inside the real wrapExtendScript, sendFn never called
  it("GP-T3: throws and does not call sendFn when token is forged", async () => {
    tamper.mode = "forged";
    await expect(getPageStateTool.handler({ document_id: "doc-1", page_id: "p1" })).rejects.toThrow(
      "read_not_authorized: token not issued by this guard",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  // GP-T4: documentId mismatch → the real consumeReadToken rejects, sendFn never called
  it("GP-T4: throws and does not call sendFn when documentId mismatches issued token", async () => {
    tamper.mode = "wrong_doc";
    await expect(
      getPageStateTool.handler({ document_id: "doc-A", page_id: "p1" }),
    ).rejects.toThrow("read_not_authorized: documentId mismatch");
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });
});
