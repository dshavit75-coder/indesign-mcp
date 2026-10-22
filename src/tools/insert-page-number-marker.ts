import { z } from "zod";
import { defineTool } from "./registry.js";
import { runScriptWithResultFile } from "../transport/result-file.js";
import { wrapExtendScript, lit, prelude } from "../compose.js";
import { findDocumentById, findFrameById } from "../script-helpers.js";
import { ok } from "../errors.js";
import { sendMutateScript } from "../mutate-guard.js";

const InputSchema = z
  .object({
    frame_id: z.string().min(1),
    position: z.enum(["start", "end"]).optional(),
    document_id: z.string().refine(s => s.trim().length > 0, { message: "document_id must contain at least one non-whitespace character" }),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

const ScriptResultSchema = z.object({
  frame_id: z.string(),
  inserted_at: z.enum(["start", "end"]),
});

type ScriptResult = z.infer<typeof ScriptResultSchema>;

interface Result {
  frame_id: string;
  inserted_at: "start" | "end";
}

function buildScriptBody(input: Input): string {
  const docExpr =
    `findDocumentById(${lit(input.document_id)})`;

  const position = input.position ?? "end";
  const insertionPointExpr =
    position === "start"
      ? "frame.parentStory.insertionPoints[0]"
      : "frame.parentStory.insertionPoints[-1]";

  return `
${prelude(findDocumentById, findFrameById)}
var doc = ${docExpr};
var frame = findFrameById(doc, ${lit(input.frame_id)});
if (frame.constructor.name !== "TextFrame") {
  throw {
    name: "invalid_args",
    message: "frame " + ${lit(input.frame_id)} + " is not a TextFrame",
    entity: "frame",
    id: ${lit(input.frame_id)}
  };
}
${insertionPointExpr}.contents = SpecialCharacters.AUTO_PAGE_NUMBER;
return {
  frame_id: ${lit(input.frame_id)},
  inserted_at: ${lit(position)}
};
`;
}

export const insertPageNumberMarkerTool = defineTool<Input, Result>({
  name: "insert_page_number_marker",
  description:
    "Inserts an auto-page-number marker (SpecialCharacters.AUTO_PAGE_NUMBER) into a text frame. The marker renders as the current page number. Specify position \"start\" or \"end\" (default \"end\").",
  inputSchema: InputSchema,
  async handler(input) {
    const env = await sendMutateScript<Awaited<ReturnType<typeof runScriptWithResultFile<ScriptResult>>>>(
      input.document_id,
      () => buildScriptBody(input),
      (body, tok, documentId) =>
        wrapExtendScript(body, { _mutateToken: tok, documentId }),
      (scriptTemplate) =>
        runScriptWithResultFile<ScriptResult>({
          language: "JavaScript",
          scriptTemplate,
          resultSchema: ScriptResultSchema,
        }),
      "insert_page_number_marker",
    );
    if (!env.ok) return env;
    const r = env.result!;
    return ok(
      { frame_id: r.frame_id, inserted_at: r.inserted_at },
      {
        document_state_delta: {
          changed_frames: [{ id: r.frame_id }],
        },
      },
    );
  },
});
