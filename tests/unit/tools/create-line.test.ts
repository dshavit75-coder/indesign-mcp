import { describe, it, expect, vi, beforeEach } from "vitest";
import { createLineTool } from "../../../src/tools/create-line.js";
import { lastCall, expectFailure } from "../_helpers.js";

vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

import { runScriptWithResultFile } from "../../../src/transport/result-file.js";

describe("create_line tool", () => {
  beforeEach(() => {
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("has the expected metadata", () => {
    expect(createLineTool.name).toBe("create_line");
    expect(createLineTool.description.length).toBeGreaterThan(0);
  });

  it("accepts minimal valid input (page_id + start + end)", () => {
    expect(
      createLineTool.inputSchema.safeParse({
        document_id: "doc-1",
        page_id: "p1",
        start_mm: { x: 12, y: 12 },
        end_mm: { x: 198, y: 12 },
      }).success,
    ).toBe(true);
  });

  it("rejects missing document_id", () => {
    expect(createLineTool.inputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects empty document_id", () => {
    expect(createLineTool.inputSchema.safeParse({ document_id: "" }).success).toBe(false);
  });

  it("rejects whitespace-only document_id", () => {
    expect(createLineTool.inputSchema.safeParse({ document_id: "   " }).success).toBe(false);
  });

  it("rejects negative coordinates", () => {
    expect(
      createLineTool.inputSchema.safeParse({
        document_id: "doc-1",
        page_id: "p1",
        start_mm: { x: -1, y: 12 },
        end_mm: { x: 198, y: 12 },
      }).success,
    ).toBe(false);
  });

  it("rejects invalid stroke_hex", () => {
    expect(
      createLineTool.inputSchema.safeParse({
        document_id: "doc-1",
        page_id: "p1",
        start_mm: { x: 0, y: 0 },
        end_mm: { x: 100, y: 0 },
        stroke_hex: "black",
      }).success,
    ).toBe(false);
  });

  it("rejects stroke_weight_pt <= 0", () => {
    expect(
      createLineTool.inputSchema.safeParse({
        document_id: "doc-1",
        page_id: "p1",
        start_mm: { x: 0, y: 0 },
        end_mm: { x: 100, y: 0 },
        stroke_weight_pt: 0,
      }).success,
    ).toBe(false);
  });

  it("dispatches a script that uses resolveSwatch and graphicLines.add", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f1", page_id: "p1", stroke_swatch_id: "sw1" },
    });

    await createLineTool.handler({
      document_id: "doc-1",
      page_id: "p1",
      start_mm: { x: 12, y: 12 },
      end_mm: { x: 198, y: 12 },
      stroke_hex: "#333333",
      stroke_weight_pt: 0.5,
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("resolveSwatch");
    expect(arg.scriptTemplate).toContain("graphicLines.add");
    expect(arg.scriptTemplate).toContain("#333333");
  });

  it("returns frame, page, stroke_swatch_id and document_state_delta with type 'line'", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { frame_id: "f1", page_id: "p1", stroke_swatch_id: "sw1" },
    });

    const env = await createLineTool.handler({
      document_id: "doc-1",
      page_id: "p1",
      start_mm: { x: 0, y: 0 },
      end_mm: { x: 100, y: 0 },
    });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.result).toEqual({
      frame_id: "f1",
      page_id: "p1",
      stroke_swatch_id: "sw1",
    });
    expect(env.document_state_delta).toEqual({
      new_frames: [{ id: "f1", type: "line" }],
    });
  });

  it("propagates failure envelopes verbatim", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: false,
      error: { kind: "not_found", message: "page p99 not found" },
    });

    const env = await createLineTool.handler({
      document_id: "doc-1",
      page_id: "p99",
      start_mm: { x: 0, y: 0 },
      end_mm: { x: 100, y: 0 },
    });

    expectFailure(env);
    expect(env.error.kind).toBe("not_found");
  });
});
