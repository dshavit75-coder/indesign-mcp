import { z } from "zod";
import { defineTool } from "./registry.js";
import { runScriptWithResultFile } from "../transport/result-file.js";
import { sendMutateScript } from "../mutate-guard.js";
import { wrapExtendScript, lit, prelude } from "../compose.js";
import { findDocumentById, findFrameById } from "../script-helpers.js";

const InputSchema = z
  .object({
    frame_id: z.string(),
    text: z.string(),
    document_id: z.string().refine(s => s.trim().length > 0, { message: "document_id must contain at least one non-whitespace character" }),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

const ScriptResultSchema = z.object({
  frame_id: z.string(),
  character_count: z.number().int().nonnegative(),
});

type ScriptResult = z.infer<typeof ScriptResultSchema>;

interface Result {
  frame_id: string;
  character_count: number;
}

function buildScriptBody(input: Input): string {
  const docExpr =
    `findDocumentById(${lit(input.document_id)})`;

  return `
${prelude(findDocumentById, findFrameById)}
var doc = ${docExpr};
var frame = findFrameById(doc, ${lit(input.frame_id)});
if (frame.constructor.name !== "TextFrame") {
  throw { name: "not_found", message: "frame " + ${lit(input.frame_id)} + " is not a text frame", entity: "frame", id: ${lit(input.frame_id)} };
}
frame.contents = ${lit(input.text)};
return {
  frame_id: ${lit(input.frame_id)},
  character_count: frame.contents.length
};
`;
}

export const setTextTool = defineTool<Input, Result>({
  name: "set_text",
  description:
    "Replaces all text content in a text frame. Returns the frame ID and resulting character count.",
  inputSchema: InputSchema,
  async handler(input) {
    // InDesign uses \r as paragraph separator. Normalize CRLF and LF to CR
    // so callers can use natural \n-separated text and get expected paragraph
    // structure.
    const normalizedText = input.text.replace(/\r\n|\n/g, "\r");
    return sendMutateScript<Awaited<ReturnType<typeof runScriptWithResultFile<ScriptResult>>>>(
      input.document_id,
      () => buildScriptBody({ ...input, text: normalizedText }),
      (body, tok, docId) => wrapExtendScript(body, { _mutateToken: tok, documentId: docId }),
      (scriptTemplate) =>
        runScriptWithResultFile<ScriptResult>({
          language: "JavaScript",
          scriptTemplate,
          resultSchema: ScriptResultSchema,
        }),
      "set_text",
    );
  },
});
