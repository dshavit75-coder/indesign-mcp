import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTextFrameTool } from "../../../src/tools/create-text-frame.js";
import { lastCall, expectFailure } from "../_helpers.js";

vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

import { runScriptWithResultFile } from "../../../src/transport/result-file.js";

describe("create_text_frame tool", () => {
  beforeEach(() => {
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("has the expected metadata", () => {
    expect(createTextFrameTool.name).toBe("create_text_frame");
    expect(createTextFrameTool.description.length).toBeGreaterThan(0);
  });

  it("accepts a minimal valid input", () => {
    const result = createTextFrameTool.inputSchema.safeParse({
      document_id: "doc-1",
      page_id: "p1",
      bounds_mm: { x: 10, y: 10, width: 100, height: 50 },
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing document_id", () => {
    expect(createTextFrameTool.inputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects empty document_id", () => {
    expect(createTextFrameTool.inputSchema.safeParse({ document_id: "" }).success).toBe(false);
  });

  it("rejects whitespace-only document_id", () => {
    expect(createTextFrameTool.inputSchema.safeParse({ document_id: "   " }).success).toBe(false);
  });

  it("rejects zero or negative width/height", () => {
    expect(
      createTextFrameTool.inputSchema.safeParse({
        document_id: "doc-1",
        page_id: "p1",
        bounds_mm: { x: 10, y: 10, width: 0, height: 50 },
      }).success,
    ).toBe(false);
    expect(
      createTextFrameTool.inputSchema.safeParse({
        document_id: "doc-1",
        page_id: "p1",
        bounds_mm: { x: 10, y: 10, width: 100, height: -1 },
      }).success,
    ).toBe(false);
  });

  it("rejects negative x/y", () => {
    expect(
      createTextFrameTool.inputSchema.safeParse({
        document_id: "doc-1",
        page_id: "p1",
        bounds_mm: { x: -1, y: 10, width: 100, height: 50 },
      }).success,
    ).toBe(false);
  });

  it("accepts initial_text", () => {
    expect(
      createTextFrameTool.inputSchema.safeParse({
        document_id: "doc-1",
        page_id: "p1",
        bounds_mm: { x: 10, y: 10, width: 100, height: 50 },
        initial_text: "Hello, world",
      }).success,
    ).toBe(true);
  });

  it("dispatches a script that converts {x,y,w,h} to InDesign's [y1,x1,y2,x2] geometricBounds", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f1", page_id: "p1" },
    });

    await createTextFrameTool.handler({
      document_id: "doc-1",
      page_id: "p1",
      bounds_mm: { x: 10, y: 20, width: 100, height: 50 },
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.language).toBe("JavaScript");
    expect(arg.scriptTemplate).toContain("[20, 10, 70, 110]");
  });

  it("dispatches a script that sets initial_text when provided", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f1", page_id: "p1" },
    });

    await createTextFrameTool.handler({
      document_id: "doc-1",
      page_id: "p1",
      bounds_mm: { x: 10, y: 20, width: 100, height: 50 },
      initial_text: "Headline goes here",
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("Headline goes here");
    expect(arg.scriptTemplate).toContain("frame.contents");
  });

  it("returns the frame and document_state_delta", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f7", page_id: "p1" },
    });

    const env = await createTextFrameTool.handler({
      document_id: "doc-1",
      page_id: "p1",
      bounds_mm: { x: 10, y: 10, width: 100, height: 50 },
    });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.result).toEqual({ frame_id: "f7", page_id: "p1" });
    expect(env.document_state_delta).toEqual({
      new_frames: [{ id: "f7", type: "text" }],
    });
  });

  it("propagates failure envelopes verbatim", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: false,
      error: { kind: "not_found", message: "page p99 not found", entity: "page", id: "p99" },
    });

    const env = await createTextFrameTool.handler({
      document_id: "doc-1",
      page_id: "p99",
      bounds_mm: { x: 10, y: 10, width: 100, height: 50 },
    });

    expectFailure(env);
    expect(env.error.kind).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// Stage 7C tamper tests: CTF-T1 – CTF-T5
// ---------------------------------------------------------------------------
const tamperCTF = vi.hoisted(() => ({
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
        if (tamperCTF.mode === "forged")
          return actual.wrapExtendScript(body, { _mutateToken: {}, documentId: opts.documentId });
        if (tamperCTF.mode === "replay") {
          actual.wrapExtendScript(body, opts);
          tamperCTF.firstConsumeOk++;
          return actual.wrapExtendScript(body, opts);
        }
        if (tamperCTF.mode === "wrong_doc")
          return actual.wrapExtendScript(body, { _mutateToken: opts._mutateToken, documentId: "doc-EVIL" });
        if (tamperCTF.mode === "body_swap")
          return actual.wrapExtendScript("var evil = 1; return {};", { _mutateToken: opts._mutateToken, documentId: opts.documentId });
      }
      return actual.wrapExtendScript(...args);
    },
  };
});

describe("create_text_frame — Stage 7C tamper tests", () => {
  const validInput = {
    document_id: "doc-1",
    page_id: "p1",
    bounds_mm: { x: 10, y: 10, width: 100, height: 50 },
  };

  beforeEach(() => {
    tamperCTF.mode = "passthrough";
    tamperCTF.firstConsumeOk = 0;
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("CTF-T1: happy path — sendFn called exactly once when no tamper", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f1", page_id: "p1" },
    });
    await createTextFrameTool.handler(validInput);
    expect(vi.mocked(runScriptWithResultFile)).toHaveBeenCalledOnce();
  });

  it("CTF-T2: forged token → throws; sendFn not called", async () => {
    tamperCTF.mode = "forged";
    await expect(createTextFrameTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("CTF-T3: replay → first consume succeeds, second rejected; sendFn not called", async () => {
    tamperCTF.mode = "replay";
    await expect(createTextFrameTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
    expect(tamperCTF.firstConsumeOk).toBe(1);
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("CTF-T4: wrong_doc → documentId mismatch → throws; sendFn not called", async () => {
    tamperCTF.mode = "wrong_doc";
    await expect(createTextFrameTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: documentId mismatch",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("CTF-T5: body_swap → body mismatch → throws; sendFn not called", async () => {
    tamperCTF.mode = "body_swap";
    await expect(createTextFrameTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: body mismatch",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });
});
