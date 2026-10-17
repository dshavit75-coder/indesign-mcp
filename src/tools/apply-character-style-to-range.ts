import { z } from "zod";
import { defineTool } from "./registry.js";
import { runScriptWithResultFile } from "../transport/result-file.js";
import { wrapExtendScript, lit, prelude } from "../compose.js";
import { sendMutateScript } from "../mutate-guard.js";
import { findDocumentById, findFrameById, findCharacterStyleByName } from "../script-helpers.js";
import { ok } from "../errors.js";

const InputSchema = z
  .object({
    frame_id: z.string().min(1),
    character_style_name: z.string().min(1),
    start_index: z.number().int().min(0),
    end_index: z.number().int(),
    document_id: z.string().optional(),
  })
  .strict()
  .refine((data) => data.end_index > data.start_index, {
    message: "end_index must be greater than start_index",
    path: ["end_index"],
  });

type Input = z.infer<typeof InputSchema>;

const ScriptResultSchema = z.object({
  frame_id: z.string(),
  character_style_name: z.string(),
  start_index: z.number().int(),
  end_index: z.number().int(),
  applied_chars: z.number().int(),
});

type ScriptResult = z.infer<typeof ScriptResultSchema>;

interface Result {
  frame_id: string;
  character_style_name: string;
  start_index: number;
  end_index: number;
  applied_chars: number;
}

function buildScriptBody(input: Input): string {
  const docExpr =
    input.document_id !== undefined
      ? `findDocumentById(${lit(input.document_id)})`
      : "app.activeDocument";

  // Translate exclusive end_index to InDesign's inclusive end (itemByRange uses inclusive).
  const inclusiveEnd = input.end_index - 1;

  return `
${prelude(findDocumentById, findFrameById, findCharacterStyleByName)}
var doc = ${docExpr};
var frame = findFrameById(doc, ${lit(input.frame_id)});
if (frame.constructor.name !== "TextFrame") {
  throw { name: "invalid_args", message: "frame " + ${lit(input.frame_id)} + " is not a text frame", entity: "frame", id: ${lit(input.frame_id)} };
}
var storyLen = frame.parentStory.characters.length;
if (${input.end_index} > storyLen) {
  throw { name: "invalid_args", message: "end_index " + ${input.end_index} + " exceeds story length " + storyLen, entity: "frame", id: ${lit(input.frame_id)} };
}
var style = findCharacterStyleByName(doc, ${lit(input.character_style_name)});
var range = frame.parentStory.characters.itemByRange(${input.start_index}, ${inclusiveEnd});
range.applyCharacterStyle(style);
return {
  frame_id: ${lit(input.frame_id)},
  character_style_name: ${lit(input.character_style_name)},
  start_index: ${input.start_index},
  end_index: ${input.end_index},
  applied_chars: ${input.end_index - input.start_index}
};
`;
}

export const applyCharacterStyleToRangeTool = defineTool<Input, Result>({
  name: "apply_character_style_to_range",
  description:
    "Applies a named character style to a character range within a text frame. start_index is 0-based inclusive; end_index is exclusive (JavaScript slice convention). The frame must be a text frame. The character style must already exist.",
  inputSchema: InputSchema,
  async handler(input) {
    const documentId = input.document_id ?? null;
    const env = await sendMutateScript<Awaited<ReturnType<typeof runScriptWithResultFile<ScriptResult>>>>(
      documentId,
      () => buildScriptBody(input),
      (body, tok, docId) => wrapExtendScript(body, { _mutateToken: tok, documentId: docId }),
      (scriptTemplate) =>
        runScriptWithResultFile<ScriptResult>({
          language: "JavaScript",
          scriptTemplate,
          resultSchema: ScriptResultSchema,
        }),
      "apply_character_style_to_range",
    );
    if (!env.ok) return env;
    const r = env.result!;
    return ok(
      {
        frame_id: r.frame_id,
        character_style_name: r.character_style_name,
        start_index: r.start_index,
        end_index: r.end_index,
        applied_chars: r.applied_chars,
      },
      {
        document_state_delta: {
          changed_frames: [
            {
              id: r.frame_id,
              applied_character_style_range: {
                character_style_name: r.character_style_name,
                start_index: r.start_index,
                end_index: r.end_index,
              },
            },
          ],
        },
      },
    );
  },
});
