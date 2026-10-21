import { z } from "zod";
import { defineTool } from "./registry.js";
import { runScriptWithResultFile } from "../transport/result-file.js";
import { wrapExtendScript, lit, prelude } from "../compose.js";
import { findDocumentById } from "../script-helpers.js";
import { sendReadScript } from "../read-guard.js";
import type { Envelope } from "../types.js";

const InputSchema = z
  .object({
    document_id: z.string().refine(s => s.trim().length > 0, { message: "document_id must contain at least one non-whitespace character" }),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

const PageSchema = z.object({
  id: z.string(),
  index: z.number().int().nonnegative(),
  side: z.string(),
  applied_parent_name: z.string(),
  name: z.string(),
});

const ScriptResultSchema = z.object({
  pages: z.array(PageSchema),
});

type ScriptResult = z.infer<typeof ScriptResultSchema>;

interface Result {
  pages: Array<{
    id: string;
    index: number;
    side: string;
    applied_parent_name: string;
    name: string;
  }>;
}

function buildScriptBody(input: Input): string {
  const docExpr =
    `findDocumentById(${lit(input.document_id)})`;

  return `
${prelude(findDocumentById)}
var doc = ${docExpr};
var pages = doc.pages;
var result = [];
for (var i = 0; i < pages.length; i++) {
  var p = pages[i];
  var parentName = (p.appliedMaster === null) ? "[None]" : p.appliedMaster.name;
  result.push({
    id: String(p.id),
    index: i,
    side: String(p.side),
    applied_parent_name: parentName,
    name: p.name
  });
}
return { pages: result };
`;
}

export const listPagesTool = defineTool<Input, Result>({
  name: "list_pages",
  description:
    "Lists all pages in the document with their index (0-based), side (LEFT_HAND / RIGHT_HAND / SINGLE_SIDED), applied parent spread name ('[None]' if none), and user-visible page name. Read-only — no delta emitted.",
  inputSchema: InputSchema,
  async handler(input): Promise<Envelope<Result>> {
    // documentId: use the supplied document_id, or null for activeDocument queries.
    // null here means "not bound to a specific document by ID" — see read-guard.ts.
    const documentId = input.document_id ?? null;
    return sendReadScript<Envelope<Result>>(
      documentId,
      "list_pages",
      { bodyFn: () => buildScriptBody(input) },
      (opts) => runScriptWithResultFile<ScriptResult>({ language: "JavaScript", resultSchema: ScriptResultSchema, ...opts }),
      (body, tok, docId) =>
        wrapExtendScript(body, { _readToken: tok, documentId: docId }),
    );
  },
});
