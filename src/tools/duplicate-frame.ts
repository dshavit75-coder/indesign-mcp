import { z } from "zod";
import { defineTool } from "./registry.js";
import { runScriptWithResultFile } from "../transport/result-file.js";
import { sendMutateScript } from "../mutate-guard.js";
import { wrapExtendScript, lit, prelude } from "../compose.js";
import { findDocumentById, findFrameById } from "../script-helpers.js";
import { ok } from "../errors.js";
import type { FrameType } from "../types.js";

const InputSchema = z
  .object({
    frame_id: z.string().min(1),
    offset_mm: z
      .object({
        x: z.number(),
        y: z.number(),
      })
      .optional(),
    document_id: z.string().refine(s => s.trim().length > 0, { message: "document_id must contain at least one non-whitespace character" }),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

const ScriptResultSchema = z.object({
  source_frame_id: z.string(),
  duplicate_frame_id: z.string(),
  duplicate_type: z.enum(["text", "image", "rectangle", "line"]),
});

type ScriptResult = z.infer<typeof ScriptResultSchema>;

interface Result {
  source_frame_id: string;
  duplicate_frame_id: string;
  duplicate_type: FrameType;
}

function buildScriptBody(input: Input): string {
  const docExpr =
    `findDocumentById(${lit(input.document_id)})`;

  const offsetX = input.offset_mm?.x ?? 0;
  const offsetY = input.offset_mm?.y ?? 0;

  return `
${prelude(findDocumentById, findFrameById)}
var doc = ${docExpr};
var frame = findFrameById(doc, ${lit(input.frame_id)});
var prevUnits = app.scriptPreferences.measurementUnit;
app.scriptPreferences.measurementUnit = MeasurementUnits.MILLIMETERS;
try {
  var parent = frame.parent;
  var dup = frame.duplicate(parent, [${offsetX}, ${offsetY}]);
  var ctor = dup.constructor.name;
  var dupType;
  if (ctor === "TextFrame") {
    dupType = "text";
  } else if (ctor === "Rectangle") {
    dupType = (dup.graphics && dup.graphics.length > 0) ? "image" : "rectangle";
  } else if (ctor === "GraphicLine") {
    dupType = "line";
  } else {
    throw {
      name: "invalid_args",
      message: "duplicated item type " + ctor + " is not supported in document_state_delta",
      entity: "frame",
      id: String(dup.id)
    };
  }
  return {
    source_frame_id: ${lit(input.frame_id)},
    duplicate_frame_id: String(dup.id),
    duplicate_type: dupType
  };
} finally {
  app.scriptPreferences.measurementUnit = prevUnits;
}
`;
}

export const duplicateFrameTool = defineTool<Input, Result>({
  name: "duplicate_frame",
  description:
    "Duplicates a page item (text frame, image frame, rectangle, or line) with an optional millimeter offset from the original position. Returns the source frame ID, the new duplicate frame ID, and the frame type. Emits a new_frames delta for the duplicate.",
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
      "duplicate_frame",
    );
    if (!env.ok) return env;
    const r = env.result!;
    const frameType: FrameType = r.duplicate_type;
    return ok(
      {
        source_frame_id: r.source_frame_id,
        duplicate_frame_id: r.duplicate_frame_id,
        duplicate_type: frameType,
      },
      {
        document_state_delta: {
          new_frames: [{ id: r.duplicate_frame_id, type: frameType }],
        },
      },
    );
  },
});
