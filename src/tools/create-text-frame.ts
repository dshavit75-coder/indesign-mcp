import { z } from "zod";
import { defineTool } from "./registry.js";
import { runScriptWithResultFile } from "../transport/result-file.js";
import { wrapExtendScript, lit, prelude } from "../compose.js";
import { findDocumentById, findPageById } from "../script-helpers.js";
import { ok } from "../errors.js";
import { sendMutateScript } from "../mutate-guard.js";

const InputSchema = z
  .object({
    page_id: z.string(),
    bounds_mm: z.object({
      x: z.number().nonnegative(),
      y: z.number().nonnegative(),
      width: z.number().positive(),
      height: z.number().positive(),
    }),
    initial_text: z.string().optional(),
    document_id: z.string().refine(s => s.trim().length > 0, { message: "document_id must contain at least one non-whitespace character" }),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

const ScriptResultSchema = z.object({
  frame_id: z.string(),
  page_id: z.string(),
});

type ScriptResult = z.infer<typeof ScriptResultSchema>;

interface Result {
  frame_id: string;
  page_id: string;
}

function buildScriptBody(input: Input): string {
  const docExpr =
    `findDocumentById(${lit(input.document_id)})`;

  const { x, y, width, height } = input.bounds_mm;
  const y2 = y + height;
  const x2 = x + width;

  const setInitial =
    input.initial_text !== undefined
      ? `frame.contents = ${lit(input.initial_text)};`
      : "";

  return `
${prelude(findDocumentById, findPageById)}
var prevUnits = app.scriptPreferences.measurementUnit;
app.scriptPreferences.measurementUnit = MeasurementUnits.MILLIMETERS;
try {
  var doc = ${docExpr};
  var page = findPageById(doc, ${lit(input.page_id)});
  var frame = page.textFrames.add({
    geometricBounds: [${y}, ${x}, ${y2}, ${x2}]
  });
  ${setInitial}
  return {
    frame_id: String(frame.id),
    page_id: ${lit(input.page_id)}
  };
} finally {
  app.scriptPreferences.measurementUnit = prevUnits;
}
`;
}

export const createTextFrameTool = defineTool<Input, Result>({
  name: "create_text_frame",
  description:
    "Creates an empty text frame on a specified page with the given bounds (in mm). Optionally sets initial text content. Returns the frame and page IDs.",
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
      "create_text_frame",
    );
    if (!env.ok) return env;
    const r = env.result!;
    return ok(
      { frame_id: r.frame_id, page_id: r.page_id },
      {
        document_state_delta: {
          new_frames: [{ id: r.frame_id, type: "text" }],
        },
      },
    );
  },
});
