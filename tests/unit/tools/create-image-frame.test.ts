import { describe, it, expect, vi, beforeEach } from "vitest";
import { createImageFrameTool } from "../../../src/tools/create-image-frame.js";
import { lastCall, expectFailure } from "../_helpers.js";

vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

import { runScriptWithResultFile } from "../../../src/transport/result-file.js";

describe("create_image_frame tool", () => {
  beforeEach(() => {
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("has the expected metadata", () => {
    expect(createImageFrameTool.name).toBe("create_image_frame");
    expect(createImageFrameTool.description.length).toBeGreaterThan(0);
  });

  it("accepts minimal valid input", () => {
    expect(
      createImageFrameTool.inputSchema.safeParse({
        document_id: "doc-1",
        page_id: "p1",
        bounds_mm: { x: 10, y: 10, width: 100, height: 50 },
      }).success,
    ).toBe(true);
  });

  it("rejects missing document_id", () => {
    expect(createImageFrameTool.inputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects empty document_id", () => {
    expect(createImageFrameTool.inputSchema.safeParse({ document_id: "" }).success).toBe(false);
  });

  it("rejects whitespace-only document_id", () => {
    expect(createImageFrameTool.inputSchema.safeParse({ document_id: "   " }).success).toBe(false);
  });

  it("rejects zero or negative width/height", () => {
    expect(
      createImageFrameTool.inputSchema.safeParse({
        document_id: "doc-1",
        page_id: "p1",
        bounds_mm: { x: 10, y: 10, width: 0, height: 50 },
      }).success,
    ).toBe(false);
  });

  it("dispatches a script that creates a rectangle and sets fittingOnEmptyFrame", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f1", page_id: "p1" },
    });

    await createImageFrameTool.handler({
      document_id: "doc-1",
      page_id: "p1",
      bounds_mm: { x: 10, y: 20, width: 100, height: 50 },
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("rectangles.add");
    expect(arg.scriptTemplate).toContain("fittingOnEmptyFrame");
    expect(arg.scriptTemplate).toContain("FILL_PROPORTIONALLY");
    // Geometric bounds [y1, x1, y2, x2]: [20, 10, 70, 110]
    expect(arg.scriptTemplate).toContain("[20, 10, 70, 110]");
  });

  it("returns frame and document_state_delta", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f5", page_id: "p1" },
    });

    const env = await createImageFrameTool.handler({
      document_id: "doc-1",
      page_id: "p1",
      bounds_mm: { x: 10, y: 10, width: 100, height: 50 },
    });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.result).toEqual({ frame_id: "f5", page_id: "p1" });
    expect(env.document_state_delta).toEqual({
      new_frames: [{ id: "f5", type: "rectangle" }],
    });
  });

  it("propagates failure envelopes verbatim", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: false,
      error: { kind: "not_found", message: "page p99 not found", entity: "page", id: "p99" },
    });

    const env = await createImageFrameTool.handler({
      document_id: "doc-1",
      page_id: "p99",
      bounds_mm: { x: 10, y: 10, width: 100, height: 50 },
    });

    expectFailure(env);
    expect(env.error.kind).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// Stage 7C tamper tests: CIF-T1 – CIF-T5
// ---------------------------------------------------------------------------
const tamperCIF = vi.hoisted(() => ({
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
        if (tamperCIF.mode === "forged")
          return actual.wrapExtendScript(body, { _mutateToken: {}, documentId: opts.documentId });
        if (tamperCIF.mode === "replay") {
          actual.wrapExtendScript(body, opts);
          tamperCIF.firstConsumeOk++;
          return actual.wrapExtendScript(body, opts);
        }
        if (tamperCIF.mode === "wrong_doc")
          return actual.wrapExtendScript(body, { _mutateToken: opts._mutateToken, documentId: "doc-EVIL" });
        if (tamperCIF.mode === "body_swap")
          return actual.wrapExtendScript("var evil = 1; return {};", { _mutateToken: opts._mutateToken, documentId: opts.documentId });
      }
      return actual.wrapExtendScript(...args);
    },
  };
});

describe("create_image_frame — Stage 7C tamper tests", () => {
  const validInput = {
    document_id: "doc-1",
    page_id: "p1",
    bounds_mm: { x: 10, y: 10, width: 100, height: 50 },
  };

  beforeEach(() => {
    tamperCIF.mode = "passthrough";
    tamperCIF.firstConsumeOk = 0;
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("CIF-T1: happy path — sendFn called exactly once when no tamper", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f1", page_id: "p1" },
    });
    await createImageFrameTool.handler(validInput);
    expect(vi.mocked(runScriptWithResultFile)).toHaveBeenCalledOnce();
  });

  it("CIF-T2: forged token → throws; sendFn not called", async () => {
    tamperCIF.mode = "forged";
    await expect(createImageFrameTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("CIF-T3: replay → first consume succeeds, second rejected; sendFn not called", async () => {
    tamperCIF.mode = "replay";
    await expect(createImageFrameTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
    expect(tamperCIF.firstConsumeOk).toBe(1);
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("CIF-T4: wrong_doc → documentId mismatch → throws; sendFn not called", async () => {
    tamperCIF.mode = "wrong_doc";
    await expect(createImageFrameTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: documentId mismatch",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("CIF-T5: body_swap → body mismatch → throws; sendFn not called", async () => {
    tamperCIF.mode = "body_swap";
    await expect(createImageFrameTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: body mismatch",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });
});
