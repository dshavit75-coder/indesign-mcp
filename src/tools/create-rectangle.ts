import { z } from "zod";
import { defineTool } from "./registry.js";
import { runScriptWithResultFile } from "../transport/result-file.js";
import { wrapExtendScript, lit, prelude } from "../compose.js";
import { findDocumentById, findPageById, resolveSwatch } from "../script-helpers.js";
import { ok } from "../errors.js";

const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

const InputSchema = z
  .object({
    page_id: z.string(),
    bounds_mm: z.object({
      x: z.number().nonnegative(),
      y: z.number().nonnegative(),
      width: z.number().positive(),
      height: z.number().positive(),
    }),
    fill_hex: z.string().regex(HEX_COLOR_RE).optional(),
    stroke_hex: z.string().regex(HEX_COLOR_RE).optional(),
    stroke_weight_pt: z.number().nonnegative().optional(),
    corner_radius_mm: z.number().nonnegative().optional(),
    document_id: z.string().refine(s => s.trim().length > 0, { message: "document_id must contain at least one non-whitespace character" }),
  })
  .strict()
  .refine(
    (data) => !(data.stroke_weight_pt !== undefined && data.stroke_hex === undefined),
    { message: "`stroke_weight_pt` requires `stroke_hex`" },
  );

type Input = z.infer<typeof InputSchema>;

const ScriptResultSchema = z.object({
  frame_id: z.string(),
  page_id: z.string(),
  fill_swatch_id: z.string().optional(),
  stroke_swatch_id: z.string().optional(),
});

type ScriptResult = z.infer<typeof ScriptResultSchema>;

interface Result {
  frame_id: string;
  page_id: string;
  fill_swatch_id?: string;
  stroke_swatch_id?: string;
}

function buildScriptBody(input: Input): string {
  const docExpr =
    `findDocumentById(${lit(input.document_id)})`;

  const { x, y, width, height } = input.bounds_mm;
  const y2 = y + height;
  const x2 = x + width;

  const fillBlock =
    input.fill_hex !== undefined
      ? `
        var fillSwatch = resolveSwatch(doc, ${lit(input.fill_hex.toUpperCase())});
        rect.fillColor = fillSwatch;
        var fillSwatchId = String(fillSwatch.id);
      `
      : "var fillSwatchId;";

  const strokeBlock =
    input.stroke_hex !== undefined
      ? `
        var strokeSwatch = resolveSwatch(doc, ${lit(input.stroke_hex.toUpperCase())});
        rect.strokeColor = strokeSwatch;
        rect.strokeWeight = ${input.stroke_weight_pt ?? 0};
        var strokeSwatchId = String(strokeSwatch.id);
      `
      : `
        rect.strokeColor = doc.swatches.itemByName("None");
        rect.strokeWeight = 0;
        var strokeSwatchId;
      `;

  const cornerBlock =
    input.corner_radius_mm !== undefined && input.corner_radius_mm > 0
      ? `
        var cornerRadius = ${input.corner_radius_mm};
        rect.topLeftCornerOption = CornerOptions.ROUNDED_CORNER;
        rect.topRightCornerOption = CornerOptions.ROUNDED_CORNER;
        rect.bottomLeftCornerOption = CornerOptions.ROUNDED_CORNER;
        rect.bottomRightCornerOption = CornerOptions.ROUNDED_CORNER;
        rect.topLeftCornerRadius = cornerRadius;
        rect.topRightCornerRadius = cornerRadius;
        rect.bottomLeftCornerRadius = cornerRadius;
        rect.bottomRightCornerRadius = cornerRadius;
      `
      : "";

  return `
${prelude(findDocumentById, findPageById, resolveSwatch)}
var prevUnits = app.scriptPreferences.measurementUnit;
app.scriptPreferences.measurementUnit = MeasurementUnits.MILLIMETERS;
try {
  var doc = ${docExpr};
  var page = findPageById(doc, ${lit(input.page_id)});
  var rect = page.rectangles.add({
    geometricBounds: [${y}, ${x}, ${y2}, ${x2}]
  });
  ${fillBlock}
  ${strokeBlock}
  ${cornerBlock}
  var result = {
    frame_id: String(rect.id),
    page_id: ${lit(input.page_id)}
  };
  if (fillSwatchId !== undefined) result.fill_swatch_id = fillSwatchId;
  if (strokeSwatchId !== undefined) result.stroke_swatch_id = strokeSwatchId;
  return result;
} finally {
  app.scriptPreferences.measurementUnit = prevUnits;
}
`;
}

export const createRectangleTool = defineTool<Input, Result>({
  name: "create_rectangle",
  description:
    "Creates a rectangle with optional fill, stroke, and corner radius. For design elements like panels, pills, hero boxes, and dividers. Returns the frame, page, and swatch IDs.",
  inputSchema: InputSchema,
  async handler(input) {
    const env = await runScriptWithResultFile<ScriptResult>({
      language: "JavaScript",
      scriptTemplate: wrapExtendScript(buildScriptBody(input)),
      resultSchema: ScriptResultSchema,
    });
    if (!env.ok) return env;
    const r = env.result!;
    return ok(
      {
        frame_id: r.frame_id,
        page_id: r.page_id,
        ...(r.fill_swatch_id !== undefined ? { fill_swatch_id: r.fill_swatch_id } : {}),
        ...(r.stroke_swatch_id !== undefined ? { stroke_swatch_id: r.stroke_swatch_id } : {}),
      },
      {
        document_state_delta: {
          new_frames: [{ id: r.frame_id, type: "rectangle" }],
        },
      },
    );
  },
});
