import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { placeImageTool } from "../../../src/tools/place-image.js";
import { lastCall, expectFailure } from "../_helpers.js";

vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

import { runScriptWithResultFile } from "../../../src/transport/result-file.js";

describe("place_image tool", () => {
  beforeEach(() => {
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("has the expected metadata", () => {
    expect(placeImageTool.name).toBe("place_image");
    expect(placeImageTool.description.length).toBeGreaterThan(0);
  });

  it("rejects missing document_id", () => {
    expect(placeImageTool.inputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects empty document_id", () => {
    expect(placeImageTool.inputSchema.safeParse({ document_id: "" }).success).toBe(false);
  });

  it("rejects whitespace-only document_id", () => {
    expect(placeImageTool.inputSchema.safeParse({ document_id: "   " }).success).toBe(false);
  });

  it("requires frame_id and image_path", () => {
    expect(
      placeImageTool.inputSchema.safeParse({ document_id: "doc-1", image_path: "/x" }).success,
    ).toBe(false);
    expect(
      placeImageTool.inputSchema.safeParse({ document_id: "doc-1", frame_id: "f1" }).success,
    ).toBe(false);
  });

  it("accepts each fit value", () => {
    for (const fit of [
      "fill_proportionally",
      "fit_proportionally",
      "fit_content_to_frame",
      "center_content",
    ] as const) {
      expect(
        placeImageTool.inputSchema.safeParse({
          document_id: "doc-1",
          frame_id: "f1",
          image_path: "/img.png",
          fit,
        }).success,
      ).toBe(true);
    }
  });

  it("rejects an invalid fit value", () => {
    expect(
      placeImageTool.inputSchema.safeParse({
        document_id: "doc-1",
        frame_id: "f1",
        image_path: "/img.png",
        fit: "stretch",
      }).success,
    ).toBe(false);
  });

  it("returns io_error before dispatching when image file does not exist", async () => {
    const env = await placeImageTool.handler({
      document_id: "doc-1",
      frame_id: "f1",
      image_path: "/nonexistent/path/image.png",
    });

    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.kind).toBe("io_error");
    expect(env.error.message).toMatch(/not found|does not exist/i);
    expect(runScriptWithResultFile).not.toHaveBeenCalled();
  });

  it("dispatches a script with the resolved absolute path and fit value", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "place-image-test-"));
    const imagePath = join(tmpDir, "test.png");
    writeFileSync(imagePath, "fake png content");

    try {
      vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
        ok: true,
        result: { frame_id: "f1", image_path: imagePath, link_status: "NORMAL" },
      });

      await placeImageTool.handler({
        document_id: "doc-1",
        frame_id: "f1",
        image_path: imagePath,
        fit: "fit_proportionally",
      });

      const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
      expect(arg.scriptTemplate).toContain(imagePath);
      expect(arg.scriptTemplate).toContain("FitOptions.PROPORTIONALLY");
      expect(arg.scriptTemplate).toContain("frame.place");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns frame, image_path, link_status, and changed_frames delta", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "place-image-test-"));
    const imagePath = join(tmpDir, "test.png");
    writeFileSync(imagePath, "fake png content");

    try {
      vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
        ok: true,
        result: { frame_id: "f1", image_path: imagePath, link_status: "NORMAL" },
      });

      const env = await placeImageTool.handler({
        document_id: "doc-1",
        frame_id: "f1",
        image_path: imagePath,
      });

      expect(env.ok).toBe(true);
      if (!env.ok) return;
      expect(env.result?.link_status).toBe("NORMAL");
      expect(env.document_state_delta).toEqual({
        changed_frames: [{ id: "f1", applied_image_path: imagePath }],
      });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Stage B9-S5 tamper tests: PI-T1 – PI-T5
// ---------------------------------------------------------------------------
const tamperPI = vi.hoisted(() => ({
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
        if (tamperPI.mode === "forged")
          return actual.wrapExtendScript(body, { _mutateToken: {}, documentId: opts.documentId });
        if (tamperPI.mode === "replay") {
          actual.wrapExtendScript(body, opts);
          tamperPI.firstConsumeOk++;
          return actual.wrapExtendScript(body, opts);
        }
        if (tamperPI.mode === "wrong_doc")
          return actual.wrapExtendScript(body, { _mutateToken: opts._mutateToken, documentId: "doc-EVIL" });
        if (tamperPI.mode === "body_swap")
          return actual.wrapExtendScript("var evil = 1; return {};", { _mutateToken: opts._mutateToken, documentId: opts.documentId });
      }
      return actual.wrapExtendScript(...args);
    },
  };
});

describe("place_image — Stage B9-S5 tamper tests", () => {
  let tmpDir: string;
  let imagePath: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "place-image-tamper-"));
    imagePath = join(tmpDir, "tamper.png");
    writeFileSync(imagePath, "fake png content for tamper tests");
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const makeInput = () => ({
    document_id: "doc-1",
    frame_id: "f1",
    image_path: imagePath,
  });

  beforeEach(() => {
    tamperPI.mode = "passthrough";
    tamperPI.firstConsumeOk = 0;
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("PI-T2: forged token → throws; sendFn not called", async () => {
    tamperPI.mode = "forged";
    await expect(placeImageTool.handler(makeInput())).rejects.toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("PI-T3: replay → first consume succeeds, second rejected; sendFn not called", async () => {
    tamperPI.mode = "replay";
    await expect(placeImageTool.handler(makeInput())).rejects.toThrow(
      "mutate_not_authorized: token not issued by this guard",
    );
    expect(tamperPI.firstConsumeOk).toBe(1);
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("PI-T4: wrong_doc → documentId mismatch → throws; sendFn not called", async () => {
    tamperPI.mode = "wrong_doc";
    await expect(placeImageTool.handler(makeInput())).rejects.toThrow(
      "mutate_not_authorized: documentId mismatch",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("PI-T5: body_swap → body mismatch → throws; sendFn not called", async () => {
    tamperPI.mode = "body_swap";
    await expect(placeImageTool.handler(makeInput())).rejects.toThrow(
      "mutate_not_authorized: body mismatch",
    );
    expect(vi.mocked(runScriptWithResultFile)).not.toHaveBeenCalled();
  });

  it("PI-T1: happy path — sendFn called exactly once when no tamper", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f1", image_path: imagePath, link_status: "NORMAL" },
    });
    await placeImageTool.handler(makeInput());
    expect(vi.mocked(runScriptWithResultFile)).toHaveBeenCalledOnce();
  });
});
