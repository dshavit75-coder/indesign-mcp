import { z } from "zod";
import { defineTool } from "./registry.js";
import { runScriptWithResultFile } from "../transport/result-file.js";
import { wrapExtendScript, lit, prelude } from "../compose.js";
import { findDocumentById, resolveSwatch } from "../script-helpers.js";
import { ok } from "../errors.js";

const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

const InputSchema = z
  .object({
    name: z.string().min(1).max(60),
    font_family: z.string().optional(),
    font_style: z.string().optional(),
    point_size: z.number().positive().optional(),
    fill_hex: z.string().regex(HEX_COLOR_RE).optional(),
    tracking: z.number().int().min(-1000).max(10000).optional(),
    on_collision: z.enum(["error", "update", "version"]).optional(),
    document_id: z.string().refine(s => s.trim().length > 0, { message: "document_id must contain at least one non-whitespace character" }),
  })
  .strict()
  .refine(
    (data) =>
      data.font_family !== undefined ||
      data.font_style !== undefined ||
      data.point_size !== undefined ||
      data.fill_hex !== undefined ||
      data.tracking !== undefined,
    {
      message:
        "at least one attribute (font_family, font_style, point_size, fill_hex, or tracking) is required",
    },
  );

type Input = z.infer<typeof InputSchema>;

const ScriptResultSchema = z.object({
  character_style_name: z.string(),
  on_collision_outcome: z.enum(["created", "updated", "versioned"]),
  fill_swatch_id: z.string().optional(),
});

type ScriptResult = z.infer<typeof ScriptResultSchema>;

interface Result {
  character_style_name: string;
  on_collision_outcome: "created" | "updated" | "versioned";
  fill_swatch_id?: string;
}

function buildScriptBody(input: Input): string {
  const docExpr =
    `findDocumentById(${lit(input.document_id)})`;

  const onCollision = input.on_collision ?? "error";

  // Color setup. When unset, swatchId remains undefined and is omitted from
  // the returned object so the Zod schema's optional fill_swatch_id sees an
  // absent key rather than null.
  let colorSetup = "var swatchId;";
  if (input.fill_hex !== undefined) {
    const upperHex = input.fill_hex.toUpperCase();
    colorSetup = `
      var swatch = resolveSwatch(doc, ${lit(upperHex)});
      var swatchId = String(swatch.id);
    `;
  }

  // Font setup — appliedFont uses tab-separated "family\tstyle" convention
  let fontSetup = "";
  if (input.font_family !== undefined) {
    const fontName =
      input.font_style !== undefined
        ? `${input.font_family}\t${input.font_style}`
        : input.font_family;
    fontSetup = `style.appliedFont = ${lit(fontName)};`;
  }

  // Attribute assignments
  const attrs: string[] = [];
  if (input.point_size !== undefined) attrs.push(`style.pointSize = ${input.point_size};`);
  if (input.tracking !== undefined) attrs.push(`style.tracking = ${input.tracking};`);
  if (input.fill_hex !== undefined) attrs.push(`style.fillColor = swatch;`);

  // Collision handling — mirrors define-paragraph-style.ts, using "update" semantics
  const collisionBlock =
    onCollision === "error"
      ? `
        var existing = doc.characterStyles.itemByName(name);
        if (existing.isValid) {
          throw { name: "name_collision", message: "character style \\"" + name + "\\" already exists", entity: "character_style", id: name };
        }
        var style = doc.characterStyles.add({ name: name });
        var outcome = "created";
      `
      : onCollision === "update"
        ? `
        var existing = doc.characterStyles.itemByName(name);
        var style;
        var outcome;
        if (existing.isValid) {
          style = existing;
          outcome = "updated";
        } else {
          style = doc.characterStyles.add({ name: name });
          outcome = "created";
        }
      `
        : `
        var baseName = name;
        var i = 2;
        while (doc.characterStyles.itemByName(name).isValid) {
          name = baseName + " " + i;
          i++;
        }
        var style = doc.characterStyles.add({ name: name });
        var outcome = "versioned";
      `;

  return `
${prelude(findDocumentById, resolveSwatch)}
var doc = ${docExpr};
var name = ${lit(input.name)};
${collisionBlock}
${colorSetup}
${fontSetup}
${attrs.join("\n")}
var result = {
  character_style_name: name,
  on_collision_outcome: outcome
};
if (swatchId !== undefined) result.fill_swatch_id = swatchId;
return result;
`;
}

export const defineCharacterStyleTool = defineTool<Input, Result>({
  name: "define_character_style",
  description:
    "Creates or updates a character style with optional font, weight, size, fill colour, and tracking. At least one attribute must be provided. Auto-creates an RGB swatch when fill_hex is given. Returns the final style name (may differ from input when on_collision is 'version').",
  inputSchema: InputSchema,
  async handler(input) {
    const env = await runScriptWithResultFile<ScriptResult>({
      language: "JavaScript",
      scriptTemplate: wrapExtendScript(buildScriptBody(input)),
      resultSchema: ScriptResultSchema,
    });
    if (!env.ok) return env;
    const r = env.result!;
    if (r.on_collision_outcome === "updated") {
      return env;
    }
    return ok(r, {
      document_state_delta: {
        new_character_styles: [{ name: r.character_style_name }],
      },
    });
  },
});
