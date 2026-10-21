import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSwatchTool } from "../../../src/tools/create-swatch.js";
import { lastCall, expectFailure } from "../_helpers.js";

vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

import { runScriptWithResultFile } from "../../../src/transport/result-file.js";

describe("create_swatch tool", () => {
  beforeEach(() => {
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("has the expected metadata", () => {
    expect(createSwatchTool.name).toBe("create_swatch");
    expect(createSwatchTool.description.length).toBeGreaterThan(0);
  });

  // --- Schema validation ---

  it("rejects missing document_id", () => {
    expect(createSwatchTool.inputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects empty document_id", () => {
    expect(createSwatchTool.inputSchema.safeParse({ document_id: "" }).success).toBe(false);
  });

  it("rejects whitespace-only document_id", () => {
    expect(createSwatchTool.inputSchema.safeParse({ document_id: "   " }).success).toBe(false);
  });

  it("requires name and hex", () => {
    expect(createSwatchTool.inputSchema.safeParse({ document_id: "doc-1", name: "Brand Orange" }).success).toBe(false);
    expect(createSwatchTool.inputSchema.safeParse({ document_id: "doc-1", hex: "#FF6600" }).success).toBe(false);
  });

  it("accepts name + hex", () => {
    expect(
      createSwatchTool.inputSchema.safeParse({ document_id: "doc-1", name: "Brand Orange", hex: "#FF6600" }).success,
    ).toBe(true);
  });

  it("rejects empty name", () => {
    expect(
      createSwatchTool.inputSchema.safeParse({ document_id: "doc-1", name: "", hex: "#FF6600" }).success,
    ).toBe(false);
  });

  it("rejects name longer than 60 chars", () => {
    expect(
      createSwatchTool.inputSchema.safeParse({ document_id: "doc-1", name: "A".repeat(61), hex: "#FF6600" }).success,
    ).toBe(false);
  });

  it("rejects invalid hex formats", () => {
    expect(
      createSwatchTool.inputSchema.safeParse({ document_id: "doc-1", name: "X", hex: "red" }).success,
    ).toBe(false);
    expect(
      createSwatchTool.inputSchema.safeParse({ document_id: "doc-1", name: "X", hex: "#XYZ000" }).success,
    ).toBe(false);
    expect(
      createSwatchTool.inputSchema.safeParse({ document_id: "doc-1", name: "X", hex: "#FF" }).success,
    ).toBe(false);
    expect(
      createSwatchTool.inputSchema.safeParse({ document_id: "doc-1", name: "X", hex: "FF6600" }).success,
    ).toBe(false);
  });

  it("accepts valid hex — both cases", () => {
    expect(
      createSwatchTool.inputSchema.safeParse({ document_id: "doc-1", name: "X", hex: "#FF6600" }).success,
    ).toBe(true);
    expect(
      createSwatchTool.inputSchema.safeParse({ document_id: "doc-1", name: "X", hex: "#ff6600" }).success,
    ).toBe(true);
  });

  it("accepts on_collision values: error / update / version", () => {
    for (const c of ["error", "update", "version"] as const) {
      expect(
        createSwatchTool.inputSchema.safeParse({ document_id: "doc-1", name: "X", hex: "#FF6600", on_collision: c }).success,
      ).toBe(true);
    }
  });

  it("accepts valid document_id", () => {
    expect(
      createSwatchTool.inputSchema.safeParse({
        name: "X",
        hex: "#FF6600",
        document_id: "doc1",
      }).success,
    ).toBe(true);
  });

  it("rejects extra keys (strict schema)", () => {
    expect(
      createSwatchTool.inputSchema.safeParse({ document_id: "doc-1", name: "X", hex: "#FF6600", extra: true }).success,
    ).toBe(false);
  });

  // --- Script dispatch ---

  it("dispatches a script referencing doc.colors and ColorSpace.RGB", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { swatch_name: "Brand Orange", swatch_id: "sw1", on_collision_outcome: "created" },
    });

    await createSwatchTool.handler({ document_id: "doc-1", name: "Brand Orange", hex: "#FF6600" });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("doc.colors");
    expect(arg.scriptTemplate).toContain("ColorSpace");
    expect(arg.scriptTemplate).toContain("ColorModel");
    expect(arg.scriptTemplate).toContain("Brand Orange");
  });

  it("embeds parsed RGB triple in the script", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { swatch_name: "X", swatch_id: "sw1", on_collision_outcome: "created" },
    });

    await createSwatchTool.handler({ document_id: "doc-1", name: "X", hex: "#FF6600" });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    // #FF6600 → r=255, g=102, b=0 (parsed server-side, embedded as decimals).
    expect(arg.scriptTemplate).toContain("[255, 102, 0]");
  });

  it("dispatches name_collision throw when on_collision is error", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { swatch_name: "X", swatch_id: "sw1", on_collision_outcome: "created" },
    });

    await createSwatchTool.handler({ document_id: "doc-1", name: "X", hex: "#FF6600", on_collision: "error" });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("name_collision");
  });

  it("dispatches version loop when on_collision is version", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { swatch_name: "X 2", swatch_id: "sw1", on_collision_outcome: "versioned" },
    });

    await createSwatchTool.handler({ document_id: "doc-1", name: "X", hex: "#FF6600", on_collision: "version" });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("baseName");
  });

  // --- Result shape ---

  it("returns swatch_name, swatch_id, on_collision_outcome", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { swatch_name: "Brand Orange", swatch_id: "sw42", on_collision_outcome: "created" },
    });

    const env = await createSwatchTool.handler({ document_id: "doc-1", name: "Brand Orange", hex: "#FF6600" });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.result?.swatch_name).toBe("Brand Orange");
    expect(env.result?.swatch_id).toBe("sw42");
    expect(env.result?.on_collision_outcome).toBe("created");
  });

  it("emits new_swatches delta on created outcome", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { swatch_name: "Brand Orange", swatch_id: "sw1", on_collision_outcome: "created" },
    });

    const env = await createSwatchTool.handler({ document_id: "doc-1", name: "Brand Orange", hex: "#FF6600" });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.document_state_delta?.new_swatches).toEqual([{ name: "Brand Orange" }]);
  });

  it("emits new_swatches delta on versioned outcome with the final name", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { swatch_name: "Brand Orange 2", swatch_id: "sw2", on_collision_outcome: "versioned" },
    });

    const env = await createSwatchTool.handler({
      document_id: "doc-1",
      name: "Brand Orange",
      hex: "#FF6600",
      on_collision: "version",
    });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.document_state_delta?.new_swatches).toEqual([{ name: "Brand Orange 2" }]);
  });

  it("does not emit a delta when outcome is updated", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { swatch_name: "Brand Orange", swatch_id: "sw1", on_collision_outcome: "updated" },
    });

    const env = await createSwatchTool.handler({
      document_id: "doc-1",
      name: "Brand Orange",
      hex: "#FF6600",
      on_collision: "update",
    });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.document_state_delta).toBeUndefined();
  });

  it("propagates name_collision failures verbatim", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: false,
      error: { kind: "name_collision", message: "swatch Brand Orange already exists" },
    });

    const env = await createSwatchTool.handler({ document_id: "doc-1", name: "Brand Orange", hex: "#FF6600" });

    expectFailure(env);
    expect(env.error.kind).toBe("name_collision");
  });
});
