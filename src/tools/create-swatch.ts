import { z } from "zod";
import { defineTool } from "./registry.js";
import { runScriptWithResultFile } from "../transport/result-file.js";
import { wrapExtendScript, lit, prelude } from "../compose.js";
import { findDocumentById } from "../script-helpers.js";
import { ok } from "../errors.js";
import { sendMutateScript } from "../mutate-guard.js";

const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

const InputSchema = z
  .object({
    name: z.string().min(1).max(60),
    hex: z.string().regex(HEX_COLOR_RE),
    on_collision: z.enum(["error", "update", "version"]).optional(),
    document_id: z.string().refine(s => s.trim().length > 0, { message: "document_id must contain at least one non-whitespace character" }),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

const ScriptResultSchema = z.object({
  swatch_name: z.string(),
  swatch_id: z.string(),
  on_collision_outcome: z.enum(["created", "updated", "versioned"]),
});

type ScriptResult = z.infer<typeof ScriptResultSchema>;

interface Result {
  swatch_name: string;
  swatch_id: string;
  on_collision_outcome: "created" | "updated" | "versioned";
}

function buildScriptBody(input: Input): string {
  const docExpr =
    `findDocumentById(${lit(input.document_id)})`;

  const onCollision = input.on_collision ?? "error";
  const upperHex = input.hex.toUpperCase();
  const r = parseInt(upperHex.substr(1, 2), 16);
  const g = parseInt(upperHex.substr(3, 2), 16);
  const b = parseInt(upperHex.substr(5, 2), 16);

  const collisionBlock =
    onCollision === "error"
      ? `
        var existing = doc.colors.itemByName(name);
        if (existing.isValid) {
          throw { name: "name_collision", message: "swatch \\"" + name + "\\" already exists", entity: "swatch", id: name };
        }
        var swatch = doc.colors.add({ name: name, model: ColorModel.PROCESS, space: ColorSpace.RGB, colorValue: [${r}, ${g}, ${b}] });
        var outcome = "created";
      `
      : onCollision === "update"
        ? `
        var existing = doc.colors.itemByName(name);
        var swatch;
        var outcome;
        if (existing.isValid) {
          existing.colorValue = [${r}, ${g}, ${b}];
          swatch = existing;
          outcome = "updated";
        } else {
          swatch = doc.colors.add({ name: name, model: ColorModel.PROCESS, space: ColorSpace.RGB, colorValue: [${r}, ${g}, ${b}] });
          outcome = "created";
        }
      `
        : `
        var baseName = name;
        var i = 2;
        while (doc.colors.itemByName(name).isValid) {
          name = baseName + " " + i;
          i++;
        }
        var swatch = doc.colors.add({ name: name, model: ColorModel.PROCESS, space: ColorSpace.RGB, colorValue: [${r}, ${g}, ${b}] });
        var outcome = "versioned";
      `;

  return `
${prelude(findDocumentById)}
var doc = ${docExpr};
var name = ${lit(input.name)};
${collisionBlock}
return {
  swatch_name: name,
  swatch_id: String(swatch.id),
  on_collision_outcome: outcome
};
`;
}

export const createSwatchTool = defineTool<Input, Result>({
  name: "create_swatch",
  description:
    "Creates a named RGB swatch from a hex colour value. Unlike auto-swatches created by define_paragraph_style and define_character_style, this swatch uses the exact user-chosen name. Returns the final swatch name (may differ from input when on_collision is 'version'), swatch ID, and collision outcome.",
  inputSchema: InputSchema,
  async handler(input) {
    const env = await sendMutateScript<Awaited<ReturnType<typeof runScriptWithResultFile<ScriptResult>>>>(
      input.document_id,
      () => buildScriptBody(input),
      (body, tok, docId) => wrapExtendScript(body, { _mutateToken: tok, documentId: docId }),
      (scriptTemplate) =>
        runScriptWithResultFile<ScriptResult>({
          language: "JavaScript",
          scriptTemplate,
          resultSchema: ScriptResultSchema,
        }),
      "create_swatch",
    );
    if (!env.ok) return env;
    const r = env.result!;
    if (r.on_collision_outcome === "updated") {
      return env;
    }
    return ok(r, {
      document_state_delta: {
        new_swatches: [{ name: r.swatch_name }],
      },
    });
  },
});
