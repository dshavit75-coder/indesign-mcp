import { z } from "zod";
import { defineTool } from "./registry.js";
import { runScriptWithResultFile } from "../transport/result-file.js";
import { wrapExtendScript, lit, prelude } from "../compose.js";
import { findDocumentById } from "../script-helpers.js";
import { ok } from "../errors.js";

const NAME_PREFIX_RE = /^[A-Z]$/;

const InputSchema = z
  .object({
    base_name: z.string().min(1).max(60),
    name_prefix: z.string().regex(NAME_PREFIX_RE).optional(),
    facing: z.boolean().optional(),
    document_id: z.string().refine(s => s.trim().length > 0, { message: "document_id must contain at least one non-whitespace character" }),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

const ScriptResultSchema = z.object({
  parent_name: z.string(),
  page_ids: z.array(z.string()),
  page_count: z.number().int().nonnegative(),
});

type ScriptResult = z.infer<typeof ScriptResultSchema>;

interface Result {
  parent_name: string;
  page_ids: string[];
}

function buildScriptBody(input: Input): string {
  const docExpr =
    `findDocumentById(${lit(input.document_id)})`;

  // Only emit namePrefix assignment when explicitly provided; omitting it
  // lets InDesign auto-assign the next available letter.
  const namePrefixLine =
    input.name_prefix !== undefined
      ? `master.namePrefix = ${lit(input.name_prefix)};`
      : "";

  // When facing is explicitly provided, adjust the master spread's page count:
  // true → 2-page spread, false → 1-page spread.
  // When omitted, leave at the document default.
  const facingBlock =
    input.facing !== undefined
      ? `
  var wantFacing = ${lit(input.facing)};
  while (master.pages.length > (wantFacing ? 2 : 1)) {
    master.pages[master.pages.length - 1].remove();
  }
  while (master.pages.length < (wantFacing ? 2 : 1)) {
    master.pages.add();
  }
`
      : "";

  return `
${prelude(findDocumentById)}
var doc = ${docExpr};
var master = doc.masterSpreads.add();
master.baseName = ${lit(input.base_name)};
${namePrefixLine}
${facingBlock}
var pageIds = [];
for (var i = 0; i < master.pages.length; i++) {
  pageIds.push(String(master.pages[i].id));
}
return {
  parent_name: master.name,
  page_ids: pageIds,
  page_count: master.pages.length
};
`;
}

export const createParentPageTool = defineTool<Input, Result>({
  name: "create_parent_page",
  description:
    'Creates a master spread (parent page) in the active document. Returns the full parent name (e.g. "A-Footer") and the IDs of the master spread\'s pages, which can be used with create_text_frame and other tools to add shared content.',
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
      { parent_name: r.parent_name, page_ids: r.page_ids },
      {
        document_state_delta: {
          new_parent_spreads: [{ name: r.parent_name, page_count: r.page_count }],
        },
      },
    );
  },
});
