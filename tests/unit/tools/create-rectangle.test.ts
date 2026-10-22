import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRectangleTool } from "../../../src/tools/create-rectangle.js";
import { lastCall, expectFailure } from "../_helpers.js";

vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

import { runScriptWithResultFile } from "../../../src/transport/result-file.js";

describe("create_rectangle tool", () => {
  beforeEach(() => {
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("has the expected metadata", () => {
    expect(createRectangleTool.name).toBe("create_rectangle");
    expect(createRectangleTool.description.length).toBeGreaterThan(0);
  });

  it("accepts minimal valid input", () => {
    expect(
      createRectangleTool.inputSchema.safeParse({
        document_id: "doc-1",
        page_id: "p1",
        bounds_mm: { x: 10, y: 10, width: 100, height: 50 },
      }).success,
    ).toBe(true);
  });

  it("accepts fill_hex and corner_radius_mm", () => {
    expect(
      createRectangleTool.inputSchema.safeParse({
        document_id: "doc-1",
        page_id: "p1",
        bounds_mm: { x: 10, y: 10, width: 100, height: 50 },
        fill_hex: "#FF6600",
        corner_radius_mm: 4,
      }).success,
    ).toBe(true);
  });

  it("rejects missing document_id", () => {
    expect(createRectangleTool.inputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects empty document_id", () => {
    expect(createRectangleTool.inputSchema.safeParse({ document_id: "" }).success).toBe(false);
  });

  it("rejects whitespace-only document_id", () => {
    expect(createRectangleTool.inputSchema.safeParse({ document_id: "   " }).success).toBe(false);
  });

  it("rejects invalid fill_hex", () => {
    expect(
      createRectangleTool.inputSchema.safeParse({
        document_id: "doc-1",
        page_id: "p1",
        bounds_mm: { x: 10, y: 10, width: 100, height: 50 },
        fill_hex: "red",
      }).success,
    ).toBe(false);
  });

  it("rejects stroke_weight_pt without stroke_hex", () => {
    expect(
      createRectangleTool.inputSchema.safeParse({
        document_id: "doc-1",
        page_id: "p1",
        bounds_mm: { x: 10, y: 10, width: 100, height: 50 },
        stroke_weight_pt: 1,
      }).success,
    ).toBe(false);
  });

  it("accepts stroke_weight_pt with stroke_hex", () => {
    expect(
      createRectangleTool.inputSchema.safeParse({
        document_id: "doc-1",
        page_id: "p1",
        bounds_mm: { x: 10, y: 10, width: 100, height: 50 },
        stroke_hex: "#000000",
        stroke_weight_pt: 0.5,
      }).success,
    ).toBe(true);
  });

  it("dispatches a script that uses resolveSwatch when fill_hex is provided", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f1", page_id: "p1", fill_swatch_id: "sw1" },
    });

    await createRectangleTool.handler({
      document_id: "doc-1",
      page_id: "p1",
      bounds_mm: { x: 10, y: 10, width: 100, height: 50 },
      fill_hex: "#abcdef",
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("resolveSwatch");
    // hex uppercased before passing
    expect(arg.scriptTemplate).toContain("#ABCDEF");
    expect(arg.scriptTemplate).toContain("rectangles.add");
  });

  it("dispatches a script that sets corner radius when corner_radius_mm provided", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f1", page_id: "p1" },
    });

    await createRectangleTool.handler({
      document_id: "doc-1",
      page_id: "p1",
      bounds_mm: { x: 10, y: 10, width: 100, height: 50 },
      corner_radius_mm: 4,
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("ROUNDED_CORNER");
    expect(arg.scriptTemplate).toContain("cornerRadius = 4");
  });

  it("returns frame, page, and swatch ids when colors provided", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        frame_id: "f1",
        page_id: "p1",
        fill_swatch_id: "sw1",
        stroke_swatch_id: "sw2",
      },
    });

    const env = await createRectangleTool.handler({
      document_id: "doc-1",
      page_id: "p1",
      bounds_mm: { x: 10, y: 10, width: 100, height: 50 },
      fill_hex: "#FF6600",
      stroke_hex: "#000000",
      stroke_weight_pt: 1,
    });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.result).toEqual({
      frame_id: "f1",
      page_id: "p1",
      fill_swatch_id: "sw1",
      stroke_swatch_id: "sw2",
    });
    expect(env.document_state_delta).toEqual({
      new_frames: [{ id: "f1", type: "rectangle" }],
    });
  });

  it("propagates failure envelopes verbatim", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: false,
      error: { kind: "not_found", message: "page p99 not found" },
    });

    const env = await createRectangleTool.handler({
      document_id: "doc-1",
      page_id: "p99",
      bounds_mm: { x: 10, y: 10, width: 100, height: 50 },
    });

    expectFailure(env);
    expect(env.error.kind).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// Stage 7C tamper tests: CR-T1 – CR-T5
// ---------------------------------------------------------------------------
const tamperCR = vi.hoisted(() => ({
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
        if (tamperCR.mode === "forged")
          return actual.wrapExtendScript(body, { _mutateToken: {}, documentId: opts.documentId });
        if (tamperCR.mode === "replay") {
          actual.wrapExtendScript(body, opts);
          tamperCR.firstConsumeOk++;
          return actual.wrapExtendScript(body, opts);
        }
        if (tamperCR.mode === "wrong_doc")
          return actual.wrapExtendScript(body, { _mutateToken: opts._mutateToken, documentId: "doc-EVIL" });
        if (tamperCR.mode === "body_swap")
          return actual.wrapExtendScript("var evil = 1; return {};", { _mutateToken: opts._mutateToken, documentId: opts.documentId });
      }
      return actual.wrapExtendScript(...args);
    },
  };
});

describe("create_rectangle — Stage 7C tamper tests", () => {
  const validInput = {
    document_id: "doc-1",
    page_id: "p1",
    bounds_mm: { x: 10, y: 10, width: 100, height: 50 },
  };

  beforeEach(() => {
    tamperCR.mode = "passthrough";
    tamperCR.firstConsumeOk = 0;
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("CR-T1: happy path — sendFn called exactly once when no tamper", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f1", page_id: "p1" },
    });
    await createRectangleTool.handler(validInput);
    expect(vi.mocked(runScriptWithResultFile)).toHaveBeenCalledOnce();
  });

  it("CR-T2: forged token → throws; sendFn not called", async () => {
    tamperCR.mode = "forged";
    await expect(createRectangleTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("CR-T3: replay → first consume succeeds, second rejected; sendFn not called", async () => {
    tamperCR.mode = "replay";
    await expect(createRectangleTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
    expect(tamperCR.firstConsumeOk).toBe(1);
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("CR-T4: wrong_doc → documentId mismatch → throws; sendFn not called", async () => {
    tamperCR.mode = "wrong_doc";
    await expect(createRectangleTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: documentId mismatch",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("CR-T5: body_swap → body mismatch → throws; sendFn not called", async () => {
    tamperCR.mode = "body_swap";
    await expect(createRectangleTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: body mismatch",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });
});
