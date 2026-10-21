import { z } from "zod";
import { existsSync } from "node:fs";
import { defineTool } from "./registry.js";
import { runScriptWithResultFile } from "../transport/result-file.js";
import { wrapExtendScript, lit, prelude } from "../compose.js";
import { findDocumentById, findFrameById } from "../script-helpers.js";
import { resolveUserPath } from "../path-utils.js";
import { fail, ok } from "../errors.js";

const InputSchema = z
  .object({
    frame_id: z.string(),
    image_path: z.string(),
    fit: z
      .enum([
        "fill_proportionally",
        "fit_proportionally",
        "fit_content_to_frame",
        "center_content",
      ])
      .optional(),
    document_id: z.string().refine(s => s.trim().length > 0, { message: "document_id must contain at least one non-whitespace character" }),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

const ScriptResultSchema = z.object({
  frame_id: z.string(),
  image_path: z.string(),
  link_status: z.string(),
});

type ScriptResult = z.infer<typeof ScriptResultSchema>;

interface Result {
  frame_id: string;
  image_path: string;
  link_status: string;
}

const FIT_ENUM_MAP = {
  fill_proportionally: "FILL_PROPORTIONALLY",
  fit_proportionally: "PROPORTIONALLY",
  fit_content_to_frame: "CONTENT_TO_FRAME",
  center_content: "CENTER_CONTENT",
} as const;

function buildScriptBody(input: Input, absolutePath: string): string {
  const docExpr =
    `findDocumentById(${lit(input.document_id)})`;

  const fitEnum = FIT_ENUM_MAP[input.fit ?? "fill_proportionally"];

  return `
${prelude(findDocumentById, findFrameById)}
var doc = ${docExpr};
var frame = findFrameById(doc, ${lit(input.frame_id)});
frame.place(File(${lit(absolutePath)}));
frame.fit(FitOptions.${fitEnum});
var graphics = frame.graphics;
var linkStatus = "UNKNOWN";
if (graphics.length > 0 && graphics[0].itemLink) {
  linkStatus = String(graphics[0].itemLink.status);
}
return {
  frame_id: ${lit(input.frame_id)},
  image_path: ${lit(absolutePath)},
  link_status: linkStatus
};
`;
}

export const placeImageTool = defineTool<Input, Result>({
  name: "place_image",
  description:
    "Places an image file (PNG, JPG, SVG, EPS, PDF, etc.) into an existing rectangle, applying a fit mode. Returns the absolute path and InDesign link status.",
  inputSchema: InputSchema,
  async handler(input) {
    const absolutePath = resolveUserPath(input.image_path);
    if (!existsSync(absolutePath)) {
      return fail("io_error", `image file not found: ${absolutePath}`);
    }

    const env = await runScriptWithResultFile<ScriptResult>({
      language: "JavaScript",
      scriptTemplate: wrapExtendScript(buildScriptBody(input, absolutePath)),
      resultSchema: ScriptResultSchema,
    });
    if (!env.ok) return env;
    const r = env.result!;
    return ok(
      {
        frame_id: r.frame_id,
        image_path: r.image_path,
        link_status: r.link_status,
      },
      {
        document_state_delta: {
          changed_frames: [
            { id: r.frame_id, applied_image_path: r.image_path },
          ],
        },
      },
    );
  },
});
