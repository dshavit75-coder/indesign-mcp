import { describe, it, expect, vi, beforeEach } from "vitest";
import { getAppVersionTool } from "../../../src/tools/get-app-version.js";
import { RESULT_PATH_SENTINEL } from "../../../src/compose.js";
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

// We test by stubbing the transport. This validates schema, script body,
// and result parsing — without actually running osascript or InDesign.
vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

import { runScriptWithResultFile } from "../../../src/transport/result-file.js";

describe("get_app_version tool", () => {
  beforeEach(() => {
    vi.mocked(runScriptWithResultFile).mockReset();
    tamper.mode = "passthrough";
  });

  it("has the expected metadata", () => {
    expect(getAppVersionTool.name).toBe("get_app_version");
    expect(getAppVersionTool.description).toMatch(/version/i);
  });

  it("rejects extra input properties", () => {
    const parsed = getAppVersionTool.inputSchema.safeParse({ junk: 1 });
    expect(parsed.success).toBe(false);
  });

  it("dispatches an ExtendScript that reads app.version and returns the result", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { version: "21.0" },
    });
    const env = await getAppVersionTool.handler({});
    expect(env).toEqual({ ok: true, result: { version: "21.0" } });

    expect(runScriptWithResultFile).toHaveBeenCalledOnce();
    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.language).toBe("JavaScript");
    expect(arg.scriptTemplate).toContain("app.version");
    expect(arg.scriptTemplate).toContain(RESULT_PATH_SENTINEL);
  });

  it("propagates failure envelopes verbatim", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: false,
      error: { kind: "app_not_available", message: "no app" },
    });
    const env = await getAppVersionTool.handler({});
    expectFailure(env);
    expect(env.error.kind).toBe("app_not_available");
  });

  it("GAV-T1: forged token — real wrapExtendScript rejects, sendFn is NOT called", async () => {
    tamper.mode = "forged";
    await expect(getAppVersionTool.handler({})).rejects.toThrow(
      "read_not_authorized: token not issued by this guard",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("GAV-T2: documentId mismatch — real wrapExtendScript rejects, sendFn is NOT called", async () => {
    tamper.mode = "wrong_doc";
    await expect(getAppVersionTool.handler({})).rejects.toThrow(
      "read_not_authorized: documentId mismatch",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("GAV-T3: token replay — second use of the consumed token is rejected, sendFn is NOT called", async () => {
    tamper.mode = "replay";
    await expect(getAppVersionTool.handler({})).rejects.toThrow(
      "read_not_authorized: token not issued by this guard",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });
});
