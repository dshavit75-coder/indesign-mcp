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
    start_mm: z.object({
      x: z.number().nonnegative(),
      y: z.number().nonnegative(),
    }),
    end_mm: z.object({
      x: z.number().nonnegative(),
      y: z.number().nonnegative(),
    }),
    stroke_hex: z.string().regex(HEX_COLOR_RE).optional(),
    stroke_weight_pt: z.number().positive().optional(),
    document_id: z.string().refine(s => s.trim().length > 0, { message: "document_id must contain at least one non-whitespace character" }),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

const ScriptResultSchema = z.object({
  frame_id: z.string(),
  page_id: z.string(),
  stroke_swatch_id: z.string(),
});

type ScriptResult = z.infer<typeof ScriptResultSchema>;

interface Result {
  frame_id: string;
  page_id: string;
  stroke_swatch_id: string;
}

function buildScriptBody(input: Input): string {
  const docExpr =
    `findDocumentById(${lit(input.document_id)})`;

  const strokeHex = (input.stroke_hex ?? "#000000").toUpperCase();
  const weight = input.stroke_weight_pt ?? 0.5;

  return `
${prelude(findDocumentById, findPageById, resolveSwatch)}
var prevUnits = app.scriptPreferences.measurementUnit;
app.scriptPreferences.measurementUnit = MeasurementUnits.MILLIMETERS;
try {
  var doc = ${docExpr};
  var page = findPageById(doc, ${lit(input.page_id)});
  var line = page.graphicLines.add();
  // Set the path to the two endpoints. entirePath is [[x1, y1], [x2, y2]] in current units.
  line.paths[0].entirePath = [
    [${input.start_mm.x}, ${input.start_mm.y}],
    [${input.end_mm.x}, ${input.end_mm.y}]
  ];
  var strokeSwatch = resolveSwatch(doc, ${lit(strokeHex)});
  line.strokeColor = strokeSwatch;
  line.strokeWeight = ${weight};
  return {
    frame_id: String(line.id),
    page_id: ${lit(input.page_id)},
    stroke_swatch_id: String(strokeSwatch.id)
  };
} finally {
  app.scriptPreferences.measurementUnit = prevUnits;
}
`;
}

export const createLineTool = defineTool<Input, Result>({
  name: "create_line",
  description:
    "Creates a straight line between two points on a page, with optional stroke colour and weight. Useful for rules, dividers, and decorative lines.",
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
        stroke_swatch_id: r.stroke_swatch_id,
      },
      {
        document_state_delta: {
          new_frames: [{ id: r.frame_id, type: "line" }],
        },
      },
    );
  },
});
