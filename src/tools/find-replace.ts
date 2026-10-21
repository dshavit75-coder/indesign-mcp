import { z } from "zod";
import { defineTool } from "./registry.js";
import { runScriptWithResultFile } from "../transport/result-file.js";
import { wrapExtendScript, lit, prelude } from "../compose.js";
import { findDocumentById, findFrameById } from "../script-helpers.js";
import { ok } from "../errors.js";

const InputSchema = z
  .object({
    find: z.string().min(1),
    replace: z.string(),
    mode: z.enum(["literal", "grep"]).optional(),
    scope: z.enum(["document", "frame"]).optional(),
    frame_id: z.string().optional(),
    document_id: z.string().refine(s => s.trim().length > 0, { message: "document_id must contain at least one non-whitespace character" }),
  })
  .strict()
  .refine(
    (data) => !(data.scope === "frame" && data.frame_id === undefined),
    { message: "frame_id is required when scope is 'frame'", path: ["frame_id"] },
  );

type Input = z.infer<typeof InputSchema>;

const ScriptResultSchema = z.object({
  matches_changed: z.number().int().nonnegative(),
  scope: z.enum(["document", "frame"]),
  mode: z.enum(["literal", "grep"]),
});

type ScriptResult = z.infer<typeof ScriptResultSchema>;

interface Result {
  matches_changed: number;
  scope: "document" | "frame";
  mode: "literal" | "grep";
}

function buildScriptBody(input: Input): string {
  const docExpr =
    `findDocumentById(${lit(input.document_id)})`;

  const mode = input.mode ?? "literal";
  const scope = input.scope ?? "document";

  // Always reset grep preferences before and after for safety
  const grepReset = `
app.findGrepPreferences = NothingEnum.NOTHING;
app.changeGrepPreferences = NothingEnum.NOTHING;
`;

  // Frame-scope: resolve + validate as TextFrame, then take its parentStory.
  // Doc-scope: target is the document itself.
  const targetSetup =
    scope === "frame"
      ? `var frame = findFrameById(doc, ${lit(input.frame_id!)});
if (frame.constructor.name !== "TextFrame") {
  throw { name: "invalid_args", message: "frame " + ${lit(input.frame_id!)} + " is not a text frame", entity: "frame", id: ${lit(input.frame_id!)} };
}
var target = frame.parentStory;`
      : `var target = doc;`;

  const findBody =
    mode === "literal"
      ? `
app.findTextPreferences = NothingEnum.NOTHING;
app.changeTextPreferences = NothingEnum.NOTHING;
app.findTextPreferences.findWhat = ${lit(input.find)};
app.changeTextPreferences.changeTo = ${lit(input.replace)};
var changed = target.changeText();
app.findTextPreferences = NothingEnum.NOTHING;
app.changeTextPreferences = NothingEnum.NOTHING;
`
      : `
app.findGrepPreferences.findWhat = ${lit(input.find)};
app.changeGrepPreferences.changeTo = ${lit(input.replace)};
var changed = target.changeGrep();
`;

  return `
${prelude(findDocumentById, findFrameById)}
var doc = ${docExpr};
${targetSetup}
${grepReset}
try {
${findBody}
  return {
    matches_changed: changed.length,
    scope: ${lit(scope)},
    mode: ${lit(mode)}
  };
} finally {
${grepReset}
}
`;
}

export const findReplaceTool = defineTool<Input, Result>({
  name: "find_replace",
  description:
    "Replaces text matches across the active document or within a single frame's story. mode 'literal' matches plain text; mode 'grep' matches a GREP/regex pattern. scope 'frame' requires frame_id. Returns the number of replacements made, the scope, and the mode.",
  inputSchema: InputSchema,
  async handler(input) {
    const env = await runScriptWithResultFile<ScriptResult>({
      language: "JavaScript",
      scriptTemplate: wrapExtendScript(buildScriptBody(input)),
      resultSchema: ScriptResultSchema,
    });
    if (!env.ok) return env;
    const r = env.result!;
    return ok(r, {
      document_state_delta: {
        changed_frames: [],
      },
    });
  },
});
