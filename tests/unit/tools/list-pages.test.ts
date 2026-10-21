import { describe, it, expect, vi, beforeEach } from "vitest";
import { listPagesTool } from "../../../src/tools/list-pages.js";
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

describe("list_pages tool", () => {
  beforeEach(() => {
    vi.mocked(runScriptWithResultFile).mockReset();
    tamper.mode = "passthrough";
  });

  it("has the expected metadata", () => {
    expect(listPagesTool.name).toBe("list_pages");
    expect(listPagesTool.description.length).toBeGreaterThan(0);
  });

  // --- Schema validation ---

  it("rejects missing document_id", () => {
    expect(listPagesTool.inputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects empty document_id", () => {
    expect(listPagesTool.inputSchema.safeParse({ document_id: "" }).success).toBe(false);
  });

  it("rejects whitespace-only document_id", () => {
    expect(listPagesTool.inputSchema.safeParse({ document_id: "   " }).success).toBe(false);
  });

  it("accepts valid document_id", () => {
    expect(
      listPagesTool.inputSchema.safeParse({ document_id: "doc1" }).success,
    ).toBe(true);
  });

  it("rejects extra keys (strict schema)", () => {
    expect(
      listPagesTool.inputSchema.safeParse({ extra: true }).success,
    ).toBe(false);
  });

  // --- Script dispatch ---

  it("dispatches a script referencing doc.pages", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { pages: [] },
    });

    await listPagesTool.handler({ document_id: "doc-xyz" });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("doc.pages");
    expect(arg.scriptTemplate).toContain("appliedMaster");
    expect(arg.scriptTemplate).toContain("side");
  });

  it("uses null check for appliedMaster", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { pages: [] },
    });

    await listPagesTool.handler({ document_id: "doc-xyz" });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    // Must use === null comparison, not .isValid
    expect(arg.scriptTemplate).toContain("=== null");
    expect(arg.scriptTemplate).toContain("[None]");
  });

  // --- Result shape ---

  it("returns pages array with expected fields", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        pages: [
          {
            id: "pg1",
            index: 0,
            side: "RIGHT_HAND",
            applied_parent_name: "[None]",
            name: "1",
          },
        ],
      },
    });

    const env = await listPagesTool.handler({ document_id: "doc-xyz" });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.result?.pages).toHaveLength(1);
    expect(env.result?.pages[0].id).toBe("pg1");
    expect(env.result?.pages[0].index).toBe(0);
    expect(env.result?.pages[0].side).toBe("RIGHT_HAND");
    expect(env.result?.pages[0].applied_parent_name).toBe("[None]");
    expect(env.result?.pages[0].name).toBe("1");
  });

  it("does not emit a document_state_delta (read-only)", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { pages: [] },
    });

    const env = await listPagesTool.handler({ document_id: "doc-xyz" });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.document_state_delta).toBeUndefined();
  });

  // --- ReadToken enforcement (Stage 7B) ---

  it("LP-T1: valid token (null documentId) — sendFn is called", async () => {
    // When no document_id is supplied, documentId=null; the token is bound to null.
    // consumeReadToken should succeed, and sendFn (runScriptWithResultFile) must be called.
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { pages: [] },
    });

    await listPagesTool.handler({ document_id: "doc-xyz" });

    expect(vi.mocked(runScriptWithResultFile)).toHaveBeenCalledTimes(1);
  });

  it("LP-T2: valid token (string documentId) — sendFn is called", async () => {
    // When document_id is supplied, documentId matches the token; sendFn must be called.
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { pages: [] },
    });

    await listPagesTool.handler({ document_id: "doc-xyz" });

    expect(vi.mocked(runScriptWithResultFile)).toHaveBeenCalledTimes(1);
    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    // Script body must reference the supplied document ID
    expect(arg.scriptTemplate).toContain("doc-xyz");
  });

  it("LP-T3: forged token — real wrapExtendScript rejects, sendFn is NOT called", async () => {
    tamper.mode = "forged";
    await expect(listPagesTool.handler({ document_id: "doc-xyz" })).rejects.toThrow(
      "read_not_authorized: token not issued by this guard",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("LP-T4: documentId mismatch — real wrapExtendScript rejects, sendFn is NOT called", async () => {
    tamper.mode = "wrong_doc";
    await expect(listPagesTool.handler({ document_id: "doc-A" })).rejects.toThrow(
      "read_not_authorized: documentId mismatch",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("LP-T5: token replay — second use of the consumed token is rejected, sendFn is NOT called", async () => {
    tamper.mode = "replay";
    await expect(listPagesTool.handler({ document_id: "doc-xyz" })).rejects.toThrow(
      "read_not_authorized: token not issued by this guard",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });
});
