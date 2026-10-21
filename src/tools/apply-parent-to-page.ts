import { z } from "zod";
import { defineTool } from "./registry.js";
import { runScriptWithResultFile } from "../transport/result-file.js";
import { wrapExtendScript, lit, prelude } from "../compose.js";
import { findDocumentById, findPageById, findMasterSpreadByName } from "../script-helpers.js";
import { ok } from "../errors.js";

const InputSchema = z
  .object({
    page_id: z.string().min(1),
    parent_name: z.string().min(1),
    document_id: z.string().refine(s => s.trim().length > 0, { message: "document_id must contain at least one non-whitespace character" }),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

const ScriptResultSchema = z.object({
  page_id: z.string(),
  parent_name: z.string(),
});

type ScriptResult = z.infer<typeof ScriptResultSchema>;

interface Result {
  page_id: string;
  parent_name: string;
}

function buildScriptBody(input: Input): string {
  const docExpr =
    `findDocumentById(${lit(input.document_id)})`;

  return `
${prelude(findDocumentById, findPageById, findMasterSpreadByName)}
var doc = ${docExpr};
var page = findPageById(doc, ${lit(input.page_id)});
var master = findMasterSpreadByName(doc, ${lit(input.parent_name)});
page.appliedMaster = master;
return {
  page_id: ${lit(input.page_id)},
  parent_name: master.name
};
`;
}

export const applyParentToPageTool = defineTool<Input, Result>({
  name: "apply_parent_to_page",
  description:
    "Applies a named parent page (master spread) to a document page. Use the full parent name including prefix, e.g. \"A-Footer\". Returns the page and parent name.",
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
      { page_id: r.page_id, parent_name: r.parent_name },
      {
        document_state_delta: {
          changed_pages: [{ id: r.page_id, applied_parent_name: r.parent_name }],
        },
      },
    );
  },
});
