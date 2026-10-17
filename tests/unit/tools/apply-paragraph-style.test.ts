import { describe, it, expect, vi, beforeEach } from "vitest";
import { applyParagraphStyleTool } from "../../../src/tools/apply-paragraph-style.js";
import { lastCall, expectFailure } from "../_helpers.js";

vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

import { runScriptWithResultFile } from "../../../src/transport/result-file.js";

describe("apply_paragraph_style tool", () => {
  beforeEach(() => {
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("has the expected metadata", () => {
    expect(applyParagraphStyleTool.name).toBe("apply_paragraph_style");
    expect(applyParagraphStyleTool.description.length).toBeGreaterThan(0);
  });

  it("requires frame_id and style_name", () => {
    expect(
      applyParagraphStyleTool.inputSchema.safeParse({ frame_id: "f1" }).success,
    ).toBe(false);
    expect(
      applyParagraphStyleTool.inputSchema.safeParse({ style_name: "Body" }).success,
    ).toBe(false);
  });

  it("accepts minimal valid input", () => {
    expect(
      applyParagraphStyleTool.inputSchema.safeParse({
        frame_id: "f1",
        style_name: "Body",
      }).success,
    ).toBe(true);
  });

  it("dispatches a script that resolves both frame and style", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f1", style_name: "Body", affected_paragraphs: 3 },
    });

    await applyParagraphStyleTool.handler({ frame_id: "f1", style_name: "Body" });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("findFrameById");
    expect(arg.scriptTemplate).toContain("findStyleByName");
    expect(arg.scriptTemplate).toContain("applyParagraphStyle");
  });

  it("returns frame_id, style_name, affected_paragraphs, and changed_frames delta", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f1", style_name: "Body", affected_paragraphs: 5 },
    });

    const env = await applyParagraphStyleTool.handler({
      frame_id: "f1",
      style_name: "Body",
    });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.result).toEqual({
      frame_id: "f1",
      style_name: "Body",
      affected_paragraphs: 5,
    });
    expect(env.document_state_delta).toEqual({
      changed_frames: [{ id: "f1", applied_paragraph_style: "Body" }],
    });
  });

  it("propagates not_found failures verbatim", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: false,
      error: {
        kind: "not_found",
        message: "paragraph style not found",
        entity: "paragraph_style",
        id: "Missing",
      },
    });

    const env = await applyParagraphStyleTool.handler({
      frame_id: "f1",
      style_name: "Missing",
    });

    expectFailure(env);
    expect(env.error.kind).toBe("not_found");
    expect(env.error.entity).toBe("paragraph_style");
  });
});

// ---------------------------------------------------------------------------
// Stage 7C tamper tests: AP-T1 – AP-T5
//
// The mock intercepts wrapExtendScript on the _mutateToken track only.
// Every tamper mode forwards to the REAL wrapExtendScript so real
// consumeMutateToken enforcement runs. sendFn not being called proves
// the enforcement blocked dispatch.
// ---------------------------------------------------------------------------
const tamperAP = vi.hoisted(() => ({
  mode: "passthrough" as
    | "passthrough"
    | "forged"
    | "replay"
    | "wrong_doc"
    | "body_swap",
  /** Counts first consumptions that succeeded in "replay" mode (proof that the replay really is a second use). */
  firstConsumeOk: 0,
}));

vi.mock("../../../src/compose.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/compose.js")>();
  return {
    ...actual,
    wrapExtendScript: (...args: Parameters<typeof actual.wrapExtendScript>) => {
      const [body, opts] = args;
      if (opts !== undefined && "_mutateToken" in opts) {
        if (tamperAP.mode === "forged")
          return actual.wrapExtendScript(body, {
            _mutateToken: {},
            documentId: opts.documentId,
          });
        if (tamperAP.mode === "replay") {
          actual.wrapExtendScript(body, opts); // consume once
          tamperAP.firstConsumeOk++; // the first consume did not throw
          return actual.wrapExtendScript(body, opts); // replay — should throw
        }
        if (tamperAP.mode === "wrong_doc")
          return actual.wrapExtendScript(body, {
            _mutateToken: opts._mutateToken,
            documentId: "doc-EVIL",
          });
        if (tamperAP.mode === "body_swap")
          return actual.wrapExtendScript("var evil = 1; return {};", {
            _mutateToken: opts._mutateToken,
            documentId: opts.documentId,
          });
      }
      return actual.wrapExtendScript(...args);
    },
  };
});

describe("apply_paragraph_style — Stage 7C tamper tests", () => {
  const validInput = { frame_id: "f1", style_name: "Body" };

  beforeEach(() => {
    tamperAP.mode = "passthrough";
    tamperAP.firstConsumeOk = 0;
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("AP-T1: happy path — sendFn called exactly once when no tamper", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        frame_id: "f1",
        style_name: "Body",
        affected_paragraphs: 1,
      },
    });
    await applyParagraphStyleTool.handler(validInput);
    expect(vi.mocked(runScriptWithResultFile)).toHaveBeenCalledOnce();
  });

  it("AP-T2: forged token → real wrapExtendScript → throws; sendFn not called", async () => {
    tamperAP.mode = "forged";
    await expect(applyParagraphStyleTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("AP-T3: replay → the first consume succeeds, the second is rejected as already used; sendFn not called", async () => {
    tamperAP.mode = "replay";
    await expect(applyParagraphStyleTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
    // Precondition: the token WAS valid and consumed once, so the rejection is the single-use check and not a
    // token that was unusable from the start. The second call inside the tamper mock throws before any script
    // is returned, so the transport is never reached.
    expect(tamperAP.firstConsumeOk).toBe(1);
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("AP-T4: wrong_doc → documentId mismatch → throws; sendFn not called", async () => {
    tamperAP.mode = "wrong_doc";
    await expect(applyParagraphStyleTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: documentId mismatch",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("AP-T5: body_swap → body mismatch → throws; sendFn not called", async () => {
    tamperAP.mode = "body_swap";
    await expect(applyParagraphStyleTool.handler(validInput)).rejects.toThrow(
      "mutate_not_authorized: body mismatch",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });
});
