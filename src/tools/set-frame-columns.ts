import { z } from "zod";
import { defineTool } from "./registry.js";
import { runScriptWithResultFile } from "../transport/result-file.js";
import { sendMutateScript } from "../mutate-guard.js";
import { wrapExtendScript, lit, prelude } from "../compose.js";
import { findDocumentById, findFrameById } from "../script-helpers.js";
import { ok } from "../errors.js";

const InputSchema = z
  .object({
    frame_id: z.string(),
    count: z.number().int().min(1),
    gutter_mm: z.number().min(0).optional(),
    document_id: z.string().refine(s => s.trim().length > 0, { message: "document_id must contain at least one non-whitespace character" }),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

const ScriptResultSchema = z.object({
  frame_id: z.string(),
  count: z.number().int(),
  gutter_mm: z.number(),
});

type ScriptResult = z.infer<typeof ScriptResultSchema>;

interface Result {
  frame_id: string;
  count: number;
  gutter_mm: number;
}

function buildScriptBody(input: Input): string {
  const docExpr =
    `findDocumentById(${lit(input.document_id)})`;

  const gutter = input.gutter_mm ?? 4;

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
  tfp.textColumnCount = ${input.count};
  tfp.textColumnGutter = ${gutter};
  return {
    frame_id: ${lit(input.frame_id)},
    count: tfp.textColumnCount,
    gutter_mm: tfp.textColumnGutter
  };
} finally {
  app.scriptPreferences.measurementUnit = prevUnits;
}
`;
}

export const setFrameColumnsTool = defineTool<Input, Result>({
  name: "set_frame_columns",
  description:
    "Sets the column count and gutter width on a text frame. count must be an integer ≥ 1. gutter_mm defaults to 4 if omitted. Returns the frame ID, confirmed column count, and gutter width.",
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
      "set_frame_columns",
    );
    if (!env.ok) return env;
    const r = env.result!;
    return ok(
      { frame_id: r.frame_id, count: r.count, gutter_mm: r.gutter_mm },
      {
        document_state_delta: {
          changed_frames: [
            { id: r.frame_id, columns: { count: r.count, gutter_mm: r.gutter_mm } },
          ],
        },
      },
    );
  },
});
