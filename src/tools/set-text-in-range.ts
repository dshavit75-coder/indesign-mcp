import { z } from "zod";
import { defineTool } from "./registry.js";
import { runScriptWithResultFile } from "../transport/result-file.js";
import { sendMutateScript } from "../mutate-guard.js";
import { wrapExtendScript, lit, prelude } from "../compose.js";
import { findDocumentById, findFrameById } from "../script-helpers.js";
import { ok } from "../errors.js";

const InputSchema = z
  .object({
    frame_id: z.string().min(1),
    start_index: z.number().int().min(0),
    end_index: z.number().int(),
    text: z.string(),
    document_id: z.string().refine(s => s.trim().length > 0, { message: "document_id must contain at least one non-whitespace character" }),
  })
  .strict()
  .refine((data) => data.end_index > data.start_index, {
    message: "end_index must be greater than start_index",
    path: ["end_index"],
  });

type Input = z.infer<typeof InputSchema>;

const ScriptResultSchema = z.object({
  frame_id: z.string(),
  removed_chars: z.number().int().nonnegative(),
  inserted_chars: z.number().int().nonnegative(),
  total_length_after: z.number().int().nonnegative(),
});

type ScriptResult = z.infer<typeof ScriptResultSchema>;

interface Result {
  frame_id: string;
  removed_chars: number;
  inserted_chars: number;
  total_length_after: number;
}

function buildScriptBody(input: Input): string {
  const docExpr =
    `findDocumentById(${lit(input.document_id)})`;

  // Translate exclusive end_index to InDesign's inclusive end (itemByRange uses inclusive).
  const inclusiveEnd = input.end_index - 1;
  const removedChars = input.end_index - input.start_index;

  return `
${prelude(findDocumentById, findFrameById)}
var doc = ${docExpr};
var frame = findFrameById(doc, ${lit(input.frame_id)});
if (frame.constructor.name !== "TextFrame") {
  throw { name: "invalid_args", message: "frame " + ${lit(input.frame_id)} + " is not a text frame", entity: "frame", id: ${lit(input.frame_id)} };
}
var storyLen = frame.parentStory.characters.length;
if (${input.end_index} > storyLen) {
  throw { name: "invalid_args", message: "end_index " + ${input.end_index} + " exceeds story length " + storyLen, entity: "frame", id: ${lit(input.frame_id)} };
}
var range = frame.parentStory.characters.itemByRange(${input.start_index}, ${inclusiveEnd});
range.contents = ${lit(input.text)};
return {
  frame_id: ${lit(input.frame_id)},
  removed_chars: ${removedChars},
  inserted_chars: ${input.text.length},
  total_length_after: frame.parentStory.length
};
`;
}

export const setTextInRangeTool = defineTool<Input, Result>({
  name: "set_text_in_range",
  description:
    "Replaces text within a character range in a text frame, leaving surrounding text and styling intact. start_index is 0-based inclusive; end_index is exclusive. text may be empty to delete the range. Paragraph separators: use \\n (normalized to InDesign's \\r internally).",
  inputSchema: InputSchema,
  async handler(input) {
    // InDesign uses \r as paragraph separator. Normalize CRLF and LF to CR.
    const normalizedText = input.text.replace(/\r\n|\n/g, "\r");
    const env = await sendMutateScript<Awaited<ReturnType<typeof runScriptWithResultFile<ScriptResult>>>>(
      input.document_id,
      () => buildScriptBody({ ...input, text: normalizedText }),
      (body, tok, docId) => wrapExtendScript(body, { _mutateToken: tok, documentId: docId }),
      (scriptTemplate) =>
        runScriptWithResultFile<ScriptResult>({
          language: "JavaScript",
          scriptTemplate,
          resultSchema: ScriptResultSchema,
        }),
      "set_text_in_range",
    );
    if (!env.ok) return env;
    const r = env.result!;
    return ok(r, {
      document_state_delta: {
        changed_frames: [{ id: r.frame_id }],
      },
    });
  },
});
