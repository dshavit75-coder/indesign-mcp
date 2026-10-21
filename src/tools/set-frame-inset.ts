import { z } from "zod";
import { defineTool } from "./registry.js";
import { runScriptWithResultFile } from "../transport/result-file.js";
import { wrapExtendScript, lit, prelude } from "../compose.js";
import { findDocumentById, findFrameById } from "../script-helpers.js";
import { ok } from "../errors.js";

const InsetSchema = z.object({
  top: z.number().min(0),
  left: z.number().min(0),
  bottom: z.number().min(0),
  right: z.number().min(0),
});

const InputSchema = z
  .object({
    frame_id: z.string(),
    inset_mm: InsetSchema,
    document_id: z.string().refine(s => s.trim().length > 0, { message: "document_id must contain at least one non-whitespace character" }),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

const ScriptResultSchema = z.object({
  frame_id: z.string(),
  inset_mm: z.object({
    top: z.number(),
    left: z.number(),
    bottom: z.number(),
    right: z.number(),
  }),
});

type ScriptResult = z.infer<typeof ScriptResultSchema>;

interface Result {
  frame_id: string;
  inset_mm: { top: number; left: number; bottom: number; right: number };
}

function buildScriptBody(input: Input): string {
  const docExpr =
    `findDocumentById(${lit(input.document_id)})`;

  const { top, left, bottom, right } = input.inset_mm;

  return `
${prelude(findDocumentById, findFrameById)}
var doc = ${docExpr};
var frame = findFrameById(doc, ${lit(input.frame_id)});
if (frame.constructor.name !== "TextFrame") {
  throw { name: "invalid_args", message: "frame " + ${lit(input.frame_id)} + " is not a text frame", entity: "frame", id: ${lit(input.frame_id)} };
}
var prevUnits = app.scriptPreferences.measurementUnit;
app.scriptPreferences.measurementUnit = MeasurementUnits.MILLIMETERS;
try {
  var tfp = frame.textFramePreferences;
  tfp.insetSpacing = [${top}, ${left}, ${bottom}, ${right}];
  var s = tfp.insetSpacing;
  return {
    frame_id: ${lit(input.frame_id)},
    inset_mm: { top: s[0], left: s[1], bottom: s[2], right: s[3] }
  };
} finally {
  app.scriptPreferences.measurementUnit = prevUnits;
}
`;
}

export const setFrameInsetTool = defineTool<Input, Result>({
  name: "set_frame_inset",
  description:
    "Sets per-side inset spacing (padding) on a text frame in millimeters. All four sides must be provided and must be ≥ 0. Returns the frame ID and the confirmed inset values read back from InDesign.",
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
      { frame_id: r.frame_id, inset_mm: r.inset_mm },
      {
        document_state_delta: {
          changed_frames: [{ id: r.frame_id, inset_mm: r.inset_mm }],
        },
      },
    );
  },
});
