import { z } from "zod";
import { defineTool } from "./registry.js";
import { runScriptWithResultFile } from "../transport/result-file.js";
import { wrapExtendScript, lit, prelude } from "../compose.js";
import { sendMutateScript } from "../mutate-guard.js";
import {
  findDocumentById,
  findFrameById,
  findStyleByName,
} from "../script-helpers.js";
import { ok } from "../errors.js";

const InputSchema = z
  .object({
    frame_id: z.string(),
    style_name: z.string(),
    document_id: z.string().refine(s => s.trim().length > 0, { message: "document_id must contain at least one non-whitespace character" }),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

const ScriptResultSchema = z.object({
  frame_id: z.string(),
  style_name: z.string(),
  affected_paragraphs: z.number().int().nonnegative(),
});

type ScriptResult = z.infer<typeof ScriptResultSchema>;

interface Result {
  frame_id: string;
  style_name: string;
  affected_paragraphs: number;
}

function buildScriptBody(input: Input): string {
  const docExpr =
    `findDocumentById(${lit(input.document_id)})`;

  return `
${prelude(findDocumentById, findFrameById, findStyleByName)}
var doc = ${docExpr};
var frame = findFrameById(doc, ${lit(input.frame_id)});
if (frame.constructor.name !== "TextFrame") {
  throw { name: "not_found", message: "frame " + ${lit(input.frame_id)} + " is not a text frame", entity: "frame", id: ${lit(input.frame_id)} };
}
var style = findStyleByName(doc, ${lit(input.style_name)});
var paragraphs = frame.parentStory.paragraphs;
paragraphs.everyItem().applyParagraphStyle(style, true);
return {
  frame_id: ${lit(input.frame_id)},
  style_name: ${lit(input.style_name)},
  affected_paragraphs: paragraphs.length
};
`;
}

export const applyParagraphStyleTool = defineTool<Input, Result>({
  name: "apply_paragraph_style",
  description:
    "Applies a paragraph style by name to all paragraphs in a text frame, clearing local overrides. Returns the affected paragraph count.",
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
      "apply_paragraph_style",
    );
    if (!env.ok) return env;
    const r = env.result!;
    return ok(
      {
        frame_id: r.frame_id,
        style_name: r.style_name,
        affected_paragraphs: r.affected_paragraphs,
      },
      {
        document_state_delta: {
          changed_frames: [
            { id: r.frame_id, applied_paragraph_style: r.style_name },
          ],
        },
      },
    );
  },
});
