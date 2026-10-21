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

const ParagraphStyleSchema = z.object({
  name: z.string(),
  point_size: z.number().optional(),
  leading_pt: z.number().optional(),
  color_swatch_name: z.string().optional(),
});

const ScriptResultSchema = z.object({
  paragraph_styles: z.array(ParagraphStyleSchema),
});

type ScriptResult = z.infer<typeof ScriptResultSchema>;

interface Result {
  paragraph_styles: Array<{
    name: string;
    point_size?: number;
    leading_pt?: number;
    color_swatch_name?: string;
  }>;
}

function buildScriptBody(input: Input): string {
  const docExpr =
    `findDocumentById(${lit(input.document_id)})`;

  return `
${prelude(findDocumentById)}
var doc = ${docExpr};
var styles = doc.paragraphStyles;
var result = [];
for (var i = 0; i < styles.length; i++) {
  var s = styles[i];
  if (s.name.charAt(0) === "[") continue;
  var entry = { name: s.name };
  if (typeof s.pointSize === "number") entry.point_size = s.pointSize;
  if (typeof s.leading === "number") entry.leading_pt = s.leading;
  if (s.fillColor && s.fillColor.name) entry.color_swatch_name = s.fillColor.name;
  result.push(entry);
}
return { paragraph_styles: result };
`;
}

export const listParagraphStylesTool = defineTool<Input, Result>({
  name: "list_paragraph_styles",
  description:
    "Lists paragraph styles defined in the document. Internal styles whose names begin with '[' (such as '[No Paragraph Style]' and '[Basic Paragraph]') are excluded. Returns name, point size, leading in points (if set numerically), and fill colour swatch name.",
  inputSchema: InputSchema,
  async handler(input): Promise<Envelope<Result>> {
    // documentId: use the supplied document_id, or null for activeDocument queries.
    // null here means "not bound to a specific document by ID" — see read-guard.ts.
    const documentId = input.document_id ?? null;
    return sendReadScript<Envelope<Result>>(
      documentId,
      "list_paragraph_styles",
      { bodyFn: () => buildScriptBody(input) },
      (opts) => runScriptWithResultFile<ScriptResult>({ language: "JavaScript", resultSchema: ScriptResultSchema, ...opts }),
      (body, tok, docId) =>
        wrapExtendScript(body, { _readToken: tok, documentId: docId }),
    );
  },
});
