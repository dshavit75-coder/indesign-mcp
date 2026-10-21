import { z } from "zod";
import { defineTool } from "./registry.js";
import { runScriptWithResultFile } from "../transport/result-file.js";
import { wrapExtendScript, lit, prelude } from "../compose.js";
import { findDocumentById, findFrameById } from "../script-helpers.js";
import { ok } from "../errors.js";

const InputSchema = z
  .object({
    source_frame_id: z.string(),
    target_frame_id: z.string(),
    document_id: z.string().refine(s => s.trim().length > 0, { message: "document_id must contain at least one non-whitespace character" }),
  })
  .strict()
  .refine((data) => data.source_frame_id !== data.target_frame_id, {
    message: "source_frame_id and target_frame_id must be different frames",
    path: ["target_frame_id"],
  });

type Input = z.infer<typeof InputSchema>;

const ScriptResultSchema = z.object({
  source_frame_id: z.string(),
  target_frame_id: z.string(),
  story_length_after: z.number().int().nonnegative(),
});

type ScriptResult = z.infer<typeof ScriptResultSchema>;

interface Result {
  source_frame_id: string;
  target_frame_id: string;
  story_length_after: number;
}

function buildScriptBody(input: Input): string {
  const docExpr =
    `findDocumentById(${lit(input.document_id)})`;

  return `
${prelude(findDocumentById, findFrameById)}
var doc = ${docExpr};
var sourceFrame = findFrameById(doc, ${lit(input.source_frame_id)});
if (sourceFrame.constructor.name !== "TextFrame") {
  throw { name: "invalid_args", message: "source frame " + ${lit(input.source_frame_id)} + " is not a text frame", entity: "frame", id: ${lit(input.source_frame_id)} };
}
var targetFrame = findFrameById(doc, ${lit(input.target_frame_id)});
if (targetFrame.constructor.name !== "TextFrame") {
  throw { name: "invalid_args", message: "target frame " + ${lit(input.target_frame_id)} + " is not a text frame", entity: "frame", id: ${lit(input.target_frame_id)} };
}
var nextFrame = sourceFrame.nextTextFrame;
var alreadyLinked = nextFrame !== null && String(nextFrame.id) === String(targetFrame.id);
if (!alreadyLinked) {
  sourceFrame.nextTextFrame = targetFrame;
}
return {
  source_frame_id: ${lit(input.source_frame_id)},
  target_frame_id: ${lit(input.target_frame_id)},
  story_length_after: sourceFrame.parentStory.length
};
`;
}

export const threadTextFramesTool = defineTool<Input, Result>({
  name: "thread_text_frames",
  description:
    "Links two text frames into a single story so that text flows from the source frame into the target frame. If the frames are already threaded in this order, the call is a no-op. Note: if the target frame has existing content, it will be merged into the source story. Returns the source frame ID, target frame ID, and total story character count after threading.",
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
        source_frame_id: r.source_frame_id,
        target_frame_id: r.target_frame_id,
        story_length_after: r.story_length_after,
      },
      {
        document_state_delta: {
          changed_frames: [
            { id: r.source_frame_id, threaded_to_frame_id: r.target_frame_id },
          ],
        },
      },
    );
  },
});
