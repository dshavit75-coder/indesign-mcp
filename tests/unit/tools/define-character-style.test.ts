import { describe, it, expect, vi, beforeEach } from "vitest";
import { defineCharacterStyleTool } from "../../../src/tools/define-character-style.js";
import { lastCall, expectFailure } from "../_helpers.js";

vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

import { runScriptWithResultFile } from "../../../src/transport/result-file.js";

describe("define_character_style tool", () => {
  beforeEach(() => {
    vi.mocked(runScriptWithResultFile).mockReset();
  });

  it("has the expected metadata", () => {
    expect(defineCharacterStyleTool.name).toBe("define_character_style");
    expect(defineCharacterStyleTool.description.length).toBeGreaterThan(0);
  });

  // --- Schema validation ---

  it("rejects missing document_id", () => {
    expect(defineCharacterStyleTool.inputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects empty document_id", () => {
    expect(defineCharacterStyleTool.inputSchema.safeParse({ document_id: "" }).success).toBe(false);
  });

  it("rejects whitespace-only document_id", () => {
    expect(defineCharacterStyleTool.inputSchema.safeParse({ document_id: "   " }).success).toBe(false);
  });

  it("rejects input with no attributes (name only, nothing else)", () => {
    // At least one of font_family/font_style/point_size/fill_hex/tracking required
    expect(
      defineCharacterStyleTool.inputSchema.safeParse({ document_id: "doc-1", name: "Accent" }).success,
    ).toBe(false);
  });

  it("accepts name + font_family alone", () => {
    expect(
      defineCharacterStyleTool.inputSchema.safeParse({
        document_id: "doc-1",
        name: "Accent",
        font_family: "Helvetica Neue",
      }).success,
    ).toBe(true);
  });

  it("accepts name + point_size alone", () => {
    expect(
      defineCharacterStyleTool.inputSchema.safeParse({
        document_id: "doc-1",
        name: "Accent",
        point_size: 14,
      }).success,
    ).toBe(true);
  });

  it("accepts name + tracking alone", () => {
    expect(
      defineCharacterStyleTool.inputSchema.safeParse({
        document_id: "doc-1",
        name: "Accent",
        tracking: 50,
      }).success,
    ).toBe(true);
  });

  it("accepts name + fill_hex alone", () => {
    expect(
      defineCharacterStyleTool.inputSchema.safeParse({
        document_id: "doc-1",
        name: "Accent",
        fill_hex: "#FF6600",
      }).success,
    ).toBe(true);
  });

  it("rejects empty name", () => {
    expect(
      defineCharacterStyleTool.inputSchema.safeParse({
        document_id: "doc-1",
        name: "",
        font_family: "Helvetica",
      }).success,
    ).toBe(false);
  });

  it("rejects name longer than 60 chars", () => {
    expect(
      defineCharacterStyleTool.inputSchema.safeParse({
        document_id: "doc-1",
        name: "A".repeat(61),
        font_family: "Helvetica",
      }).success,
    ).toBe(false);
  });

  it("rejects invalid fill_hex format", () => {
    expect(
      defineCharacterStyleTool.inputSchema.safeParse({
        document_id: "doc-1",
        name: "Accent",
        fill_hex: "red",
      }).success,
    ).toBe(false);
    expect(
      defineCharacterStyleTool.inputSchema.safeParse({
        document_id: "doc-1",
        name: "Accent",
        fill_hex: "#XYZ000",
      }).success,
    ).toBe(false);
    expect(
      defineCharacterStyleTool.inputSchema.safeParse({
        document_id: "doc-1",
        name: "Accent",
        fill_hex: "#FF",
      }).success,
    ).toBe(false);
  });

  it("accepts valid fill_hex — both cases", () => {
    expect(
      defineCharacterStyleTool.inputSchema.safeParse({
        document_id: "doc-1",
        name: "Accent",
        fill_hex: "#FF6600",
      }).success,
    ).toBe(true);
    expect(
      defineCharacterStyleTool.inputSchema.safeParse({
        document_id: "doc-1",
        name: "Accent",
        fill_hex: "#ff6600",
      }).success,
    ).toBe(true);
  });

  it("rejects point_size <= 0", () => {
    expect(
      defineCharacterStyleTool.inputSchema.safeParse({
        document_id: "doc-1",
        name: "Accent",
        point_size: 0,
      }).success,
    ).toBe(false);
    expect(
      defineCharacterStyleTool.inputSchema.safeParse({
        document_id: "doc-1",
        name: "Accent",
        point_size: -1,
      }).success,
    ).toBe(false);
  });

  it("rejects tracking outside [-1000, 10000]", () => {
    expect(
      defineCharacterStyleTool.inputSchema.safeParse({
        document_id: "doc-1",
        name: "Accent",
        tracking: -1001,
      }).success,
    ).toBe(false);
    expect(
      defineCharacterStyleTool.inputSchema.safeParse({
        document_id: "doc-1",
        name: "Accent",
        tracking: 10001,
      }).success,
    ).toBe(false);
  });

  it("accepts on_collision values error / update / version", () => {
    for (const c of ["error", "update", "version"] as const) {
      expect(
        defineCharacterStyleTool.inputSchema.safeParse({
          document_id: "doc-1",
          name: "Accent",
          font_family: "Helvetica",
          on_collision: c,
        }).success,
      ).toBe(true);
    }
  });

  // --- Script dispatch ---

  it("dispatches a script that references characterStyles", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        character_style_name: "Accent",
        on_collision_outcome: "created",
      },
    });

    await defineCharacterStyleTool.handler({
      document_id: "doc-1",
      name: "Accent",
      font_family: "Helvetica Neue",
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("characterStyles");
    expect(arg.scriptTemplate).toContain("Accent");
  });

  it("dispatches a script that calls resolveSwatch when fill_hex provided", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        character_style_name: "Accent",
        on_collision_outcome: "created",
        fill_swatch_id: "sw1",
      },
    });

    await defineCharacterStyleTool.handler({
      document_id: "doc-1",
      name: "Accent",
      fill_hex: "#FF6600",
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("resolveSwatch");
    expect(arg.scriptTemplate).toContain("#FF6600");
  });

  it("uppercases fill_hex in the script", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        character_style_name: "Accent",
        on_collision_outcome: "created",
        fill_swatch_id: "sw2",
      },
    });

    await defineCharacterStyleTool.handler({
      document_id: "doc-1",
      name: "Accent",
      fill_hex: "#abcdef",
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("#ABCDEF");
  });

  it("dispatches a script with name_collision throw when on_collision is error", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        character_style_name: "Accent",
        on_collision_outcome: "created",
      },
    });

    await defineCharacterStyleTool.handler({
      document_id: "doc-1",
      name: "Accent",
      font_family: "Helvetica",
      on_collision: "error",
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    expect(arg.scriptTemplate).toContain("name_collision");
  });

  it("dispatches a script with version loop when on_collision is version", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        character_style_name: "Accent",
        on_collision_outcome: "created",
      },
    });

    await defineCharacterStyleTool.handler({
      document_id: "doc-1",
      name: "Accent",
      font_family: "Helvetica",
      on_collision: "version",
    });

    const [arg] = lastCall(vi.mocked(runScriptWithResultFile));
    // version loop increments a counter — look for the loop structure
    expect(arg.scriptTemplate).toContain("baseName");
  });

  // --- Result shape ---

  it("returns character_style_name and on_collision_outcome", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        character_style_name: "Accent",
        on_collision_outcome: "created",
      },
    });

    const env = await defineCharacterStyleTool.handler({
      document_id: "doc-1",
      name: "Accent",
      font_family: "Helvetica",
    });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.result?.character_style_name).toBe("Accent");
    expect(env.result?.on_collision_outcome).toBe("created");
  });

  it("returns fill_swatch_id when fill_hex provided", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: {
        character_style_name: "Accent",
        on_collision_outcome: "created",
        fill_swatch_id: "sw3",
      },
    });

    const env = await defineCharacterStyleTool.handler({
      document_id: "doc-1",
      name: "Accent",
      fill_hex: "#FF0000",
    });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.result?.fill_swatch_id).toBe("sw3");
  });

  it("propagates name_collision failures verbatim", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: false,
      error: { kind: "name_collision", message: "character style Accent already exists" },
    });

    const env = await defineCharacterStyleTool.handler({
      document_id: "doc-1",
      name: "Accent",
      font_family: "Helvetica",
    });

    expectFailure(env);
    expect(env.error.kind).toBe("name_collision");
  });

  it("emits new_character_styles delta on created outcome", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { character_style_name: "Accent", on_collision_outcome: "created" },
    });

    const env = await defineCharacterStyleTool.handler({
      document_id: "doc-1",
      name: "Accent",
      font_family: "Helvetica",
    });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.document_state_delta?.new_character_styles).toEqual([{ name: "Accent" }]);
  });

  it("emits new_character_styles delta on versioned outcome with the final name", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { character_style_name: "Accent 2", on_collision_outcome: "versioned" },
    });

    const env = await defineCharacterStyleTool.handler({
      document_id: "doc-1",
      name: "Accent",
      font_family: "Helvetica",
      on_collision: "version",
    });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.document_state_delta?.new_character_styles).toEqual([{ name: "Accent 2" }]);
  });

  it("does not emit a delta when outcome is updated", async () => {
    vi.mocked(runScriptWithResultFile).mockResolvedValueOnce({
      ok: true,
      result: { character_style_name: "Accent", on_collision_outcome: "updated" },
    });

    const env = await defineCharacterStyleTool.handler({
      document_id: "doc-1",
      name: "Accent",
      font_family: "Helvetica",
      on_collision: "update",
    });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.document_state_delta).toBeUndefined();
  });
});
