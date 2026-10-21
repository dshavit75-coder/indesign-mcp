import { z } from "zod";
import { defineTool } from "./registry.js";
import { runScriptWithResultFile } from "../transport/result-file.js";
import { wrapExtendScript, lit, prelude } from "../compose.js";
import { findDocumentById, resolveSwatch } from "../script-helpers.js";
import { ok } from "../errors.js";

const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

const InputSchema = z
  .object({
    name: z.string().min(1),
    font_family: z.string().optional(),
    font_style: z.string().optional(),
    size_pt: z.number().positive().optional(),
    leading_pt: z.union([z.number().nonnegative(), z.literal("auto")]).optional(),
    alignment: z.enum(["left", "center", "right", "justify"]).optional(),
    color_hex: z.string().regex(HEX_COLOR_RE).optional(),
    space_before_pt: z.number().nonnegative().optional(),
    space_after_pt: z.number().nonnegative().optional(),
    on_collision: z.enum(["error", "update", "version"]).optional(),
    document_id: z.string().refine(s => s.trim().length > 0, { message: "document_id must contain at least one non-whitespace character" }),
  })
  .strict()
  .refine(
    (data) => !(data.font_style !== undefined && data.font_family === undefined),
    { message: "`font_style` requires `font_family`" },
  );

type Input = z.infer<typeof InputSchema>;

const ScriptResultSchema = z.object({
  style_id: z.string(),
  name: z.string(),
  on_collision_outcome: z.enum(["created", "updated", "versioned"]),
  swatch_id: z.string().optional(),
});

type ScriptResult = z.infer<typeof ScriptResultSchema>;

interface Result {
  style_id: string;
  name: string;
  on_collision_outcome: "created" | "updated" | "versioned";
  swatch_id?: string;
}


function buildScriptBody(input: Input): string {
  const docExpr =
    `findDocumentById(${lit(input.document_id)})`;

  const onCollision = input.on_collision ?? "error";

  // Color setup. When unset, swatchId remains undefined and is omitted from
  // the returned object so the Zod schema's optional swatch_id sees an absent
  // key rather than null.
  let colorSetup = "var swatchId;";
  if (input.color_hex !== undefined) {
    const upperHex = input.color_hex.toUpperCase();
    colorSetup = `
      var swatch = resolveSwatch(doc, ${lit(upperHex)});
      var swatchId = String(swatch.id);
    `;
  }

  // Font setup
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
  if (input.size_pt !== undefined) attrs.push(`style.pointSize = ${input.size_pt};`);
  if (input.leading_pt !== undefined) {
    if (input.leading_pt === "auto") {
      attrs.push(`style.leading = Leading.AUTO;`);
    } else {
      attrs.push(`style.leading = ${input.leading_pt};`);
    }
  }
  if (input.alignment !== undefined) {
    const enumName = {
      left: "LEFT_ALIGN",
      center: "CENTER_ALIGN",
      right: "RIGHT_ALIGN",
      justify: "LEFT_JUSTIFIED",
    }[input.alignment];
    attrs.push(`style.justification = Justification.${enumName};`);
  }
  if (input.color_hex !== undefined) {
    attrs.push(`style.fillColor = swatch;`);
  }
  if (input.space_before_pt !== undefined)
    attrs.push(`style.spaceBefore = ${input.space_before_pt};`);
  if (input.space_after_pt !== undefined)
    attrs.push(`style.spaceAfter = ${input.space_after_pt};`);

  // Collision handling
  const collisionBlock =
    onCollision === "error"
      ? `
        var existing = doc.paragraphStyles.itemByName(name);
        if (existing.isValid) {
          throw { name: "name_collision", message: "paragraph style \\"" + name + "\\" already exists", entity: "paragraph_style", id: name };
        }
        var style = doc.paragraphStyles.add({ name: name });
        var outcome = "created";
      `
      : onCollision === "update"
        ? `
        var existing = doc.paragraphStyles.itemByName(name);
        var style;
        var outcome;
        if (existing.isValid) {
          style = existing;
          outcome = "updated";
        } else {
          style = doc.paragraphStyles.add({ name: name });
          outcome = "created";
        }
      `
        : `
        var baseName = name;
        var i = 2;
        while (doc.paragraphStyles.itemByName(name).isValid) {
          name = baseName + " " + i;
          i++;
        }
        var style = doc.paragraphStyles.add({ name: name });
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
  style_id: String(style.id),
  name: name,
  on_collision_outcome: outcome
};
if (swatchId !== undefined) result.swatch_id = swatchId;
return result;
`;
}

export const defineParagraphStyleTool = defineTool<Input, Result>({
  name: "define_paragraph_style",
  description:
    "Creates a paragraph style with the given attributes. Auto-creates an RGB swatch when color_hex is provided. Returns the style ID and final name (which may differ from the input if on_collision is 'version').",
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
        new_paragraph_styles: [{ name: r.name }],
      },
    });
  },
});
