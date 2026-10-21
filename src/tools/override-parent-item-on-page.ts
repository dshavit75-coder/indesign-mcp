import { z } from "zod";
import { defineTool } from "./registry.js";
import { runScriptWithResultFile } from "../transport/result-file.js";
import { wrapExtendScript, lit, prelude } from "../compose.js";
import { findDocumentById, findPageById, findFrameById } from "../script-helpers.js";
import { ok } from "../errors.js";
import type { FrameType } from "../types.js";

const InputSchema = z
  .object({
    page_id: z.string().min(1),
    parent_item_id: z.string().min(1),
    document_id: z.string().refine(s => s.trim().length > 0, { message: "document_id must contain at least one non-whitespace character" }),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

const ScriptResultSchema = z.object({
  page_id: z.string(),
  source_parent_item_id: z.string(),
  overridden_frame_id: z.string(),
  frame_type: z.enum(["text", "image", "rectangle", "line"]),
});

type ScriptResult = z.infer<typeof ScriptResultSchema>;

interface Result {
  page_id: string;
  source_parent_item_id: string;
  overridden_frame_id: string;
}

function buildScriptBody(input: Input): string {
  const docExpr =
    `findDocumentById(${lit(input.document_id)})`;

  return `
${prelude(findDocumentById, findPageById, findFrameById)}
var doc = ${docExpr};
var parentItem = findFrameById(doc, ${lit(input.parent_item_id)});
var targetPage = findPageById(doc, ${lit(input.page_id)});

var containerType = parentItem.parent.constructor.name;
if (containerType !== "MasterSpread") {
  throw {
    name: "invalid_args",
    message: "parent_item_id " + ${lit(input.parent_item_id)} + " is not on a master spread",
    entity: "frame",
    id: ${lit(input.parent_item_id)}
  };
}

var localItem = parentItem.override(targetPage);
// Mirror get_page_state's frame-type discrimination so deltas stay
// consistent with what a subsequent get_page_state call will report.
var ctor = localItem.constructor.name;
var frameType;
if (ctor === "TextFrame") {
  frameType = "text";
} else if (ctor === "Rectangle") {
  frameType = (localItem.graphics && localItem.graphics.length > 0) ? "image" : "rectangle";
} else if (ctor === "GraphicLine") {
  frameType = "line";
} else {
  throw {
    name: "invalid_args",
    message: "overridden item type " + ctor + " is not supported in document_state_delta",
    entity: "frame",
    id: String(localItem.id)
  };
}
return {
  page_id: ${lit(input.page_id)},
  source_parent_item_id: ${lit(input.parent_item_id)},
  overridden_frame_id: String(localItem.id),
  frame_type: frameType
};
`;
}

export const overrideParentItemOnPageTool = defineTool<Input, Result>({
  name: "override_parent_item_on_page",
  description:
    "Overrides a parent-page (master spread) item onto a document page, making it locally editable. Returns the new local frame's id. The source item must be on a master spread.",
  inputSchema: InputSchema,
  async handler(input) {
    const env = await runScriptWithResultFile<ScriptResult>({
      language: "JavaScript",
      scriptTemplate: wrapExtendScript(buildScriptBody(input)),
      resultSchema: ScriptResultSchema,
    });
    if (!env.ok) return env;
    const r = env.result!;
    const frameType: FrameType = r.frame_type;
    return ok(
      {
        page_id: r.page_id,
        source_parent_item_id: r.source_parent_item_id,
        overridden_frame_id: r.overridden_frame_id,
      },
      {
        document_state_delta: {
          new_frames: [{ id: r.overridden_frame_id, type: frameType }],
        },
      },
    );
  },
});
