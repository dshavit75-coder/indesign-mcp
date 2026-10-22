import { z } from "zod";
import { defineTool } from "./registry.js";
import { runScriptWithResultFile } from "../transport/result-file.js";
import { wrapExtendScript, lit, prelude } from "../compose.js";
import { findDocumentById, findPageById } from "../script-helpers.js";
import { ok } from "../errors.js";
import { sendMutateScript } from "../mutate-guard.js";

const AfterPageId = z.object({ after_page_id: z.string() }).strict();
const BeforePageId = z.object({ before_page_id: z.string() }).strict();

const InputSchema = z
  .object({
    at: z
      .union([z.literal("start"), z.literal("end"), AfterPageId, BeforePageId])
      .optional(),
    document_id: z.string().refine(s => s.trim().length > 0, { message: "document_id must contain at least one non-whitespace character" }),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

const ScriptResultSchema = z.object({
  new_page_id: z.string(),
  position_index: z.number().int().nonnegative(),
  page_count: z.number().int().positive(),
});

type ScriptResult = z.infer<typeof ScriptResultSchema>;

interface Result {
  new_page_id: string;
  position_index: number;
}

function buildScriptBody(input: Input): string {
  const at = input.at ?? "end";
  const docExpr =
    `findDocumentById(${lit(input.document_id)})`;

  let insertion: string;
  if (at === "end") {
    insertion = `var newPage = doc.pages.add(LocationOptions.AT_END);`;
  } else if (at === "start") {
    insertion = `var newPage = doc.pages.add(LocationOptions.AT_BEGINNING);`;
  } else if ("after_page_id" in at) {
    insertion = `
      var anchor = findPageById(doc, ${lit(at.after_page_id)});
      var newPage = doc.pages.add(LocationOptions.AFTER, anchor);
    `;
  } else {
    insertion = `
      var anchor = findPageById(doc, ${lit(at.before_page_id)});
      var newPage = doc.pages.add(LocationOptions.BEFORE, anchor);
    `;
  }

  return `
${prelude(findDocumentById, findPageById)}
var doc = ${docExpr};
${insertion}
var idx = -1;
for (var i = 0; i < doc.pages.length; i++) {
  if (doc.pages[i].id === newPage.id) { idx = i; break; }
}
return {
  new_page_id: String(newPage.id),
  position_index: idx,
  page_count: doc.pages.length
};
`;
}

export const addPageTool = defineTool<Input, Result>({
  name: "add_page",
  description:
    "Adds a single page to an InDesign document. Defaults to appending at the end of the active document. Returns the new page ID and its position.",
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
      "add_page",
    );
    if (!env.ok) return env;
    const r = env.result!;
    return ok(
      { new_page_id: r.new_page_id, position_index: r.position_index },
      {
        document_state_delta: {
          page_count: r.page_count,
          new_page_ids: [r.new_page_id],
        },
      },
    );
  },
});
