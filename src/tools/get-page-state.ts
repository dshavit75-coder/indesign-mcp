import { z } from "zod";
import { defineTool } from "./registry.js";
import { runScriptWithResultFile } from "../transport/result-file.js";
import { wrapExtendScript, lit, prelude } from "../compose.js";
import { findDocumentById, findPageById } from "../script-helpers.js";
import { sendReadScript } from "../read-guard.js";
import type { Envelope } from "../types.js";

const InputSchema = z
  .object({
    page_id: z.string(),
    document_id: z.string().refine(s => s.trim().length > 0, { message: "document_id must contain at least one non-whitespace character" }),
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

const BoundsMmSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

const FrameSchema = z.object({
  id: z.string(),
  type: z.enum(["text", "image", "rectangle", "line"]),
  bounds_mm: BoundsMmSchema,
  paragraph_style_name: z.string().optional(),
  text_snippet: z.string().optional(),
});

const ScriptResultSchema = z.object({
  page_id: z.string(),
  page_index: z.number().int().nonnegative(),
  bounds_mm: BoundsMmSchema,
  frames: z.array(FrameSchema),
});

type ScriptResult = z.infer<typeof ScriptResultSchema>;

type Result = ScriptResult;

function buildScriptBody(input: Input): string {
  const docExpr =
    `findDocumentById(${lit(input.document_id)})`;

  return `
${prelude(findDocumentById, findPageById)}
var prevUnits = app.scriptPreferences.measurementUnit;
app.scriptPreferences.measurementUnit = MeasurementUnits.MILLIMETERS;
try {
  var doc = ${docExpr};
  var page = findPageById(doc, ${lit(input.page_id)});

  var pageIndex = -1;
  for (var i = 0; i < doc.pages.length; i++) {
    if (doc.pages[i].id === page.id) { pageIndex = i; break; }
  }

  var pb = page.bounds;
  var pageBounds = {
    x: pb[1],
    y: pb[0],
    width: pb[3] - pb[1],
    height: pb[2] - pb[0]
  };

  var frames = [];
  for (var j = 0; j < page.pageItems.length; j++) {
    var item = page.pageItems[j].getElements()[0];
    var ctor = item.constructor.name;

    var frameType;
    if (ctor === "TextFrame") {
      frameType = "text";
    } else if (ctor === "Rectangle") {
      if (item.graphics && item.graphics.length > 0) {
        frameType = "image";
      } else {
        frameType = "rectangle";
      }
    } else if (ctor === "GraphicLine") {
      frameType = "line";
    } else {
      continue;
    }

    var gb = item.geometricBounds;
    var frameInfo = {
      id: String(item.id),
      type: frameType,
      bounds_mm: {
        x: gb[1],
        y: gb[0],
        width: gb[3] - gb[1],
        height: gb[2] - gb[0]
      }
    };

    if (frameType === "text") {
      var paras = item.parentStory.paragraphs;
      if (paras.length > 0) {
        var firstStyle = paras[0].appliedParagraphStyle;
        var allSame = true;
        for (var k = 1; k < paras.length; k++) {
          if (paras[k].appliedParagraphStyle !== firstStyle) {
            allSame = false;
            break;
          }
        }
        if (allSame && firstStyle.name !== "[No paragraph style]" && firstStyle.name !== "[Basic Paragraph]") {
          frameInfo.paragraph_style_name = String(firstStyle.name);
        }
      }

      var contents = String(item.contents || "");
      if (contents.length > 0) {
        if (contents.length > 200) {
          frameInfo.text_snippet = contents.substring(0, 200) + "...";
        } else {
          frameInfo.text_snippet = contents;
        }
      }
    }

    frames.push(frameInfo);
  }

  return {
    page_id: ${lit(input.page_id)},
    page_index: pageIndex,
    bounds_mm: pageBounds,
    frames: frames
  };
} finally {
  app.scriptPreferences.measurementUnit = prevUnits;
}
`;
}

export const getPageStateTool = defineTool<Input, Result>({
  name: "get_page_state",
  description:
    "Returns a snapshot of a page: its bounds in mm and a list of frames with their type, bounds, applied paragraph style (if uniform), and a text snippet (first 200 chars).",
  inputSchema: InputSchema,
  async handler(input): Promise<Envelope<Result>> {
    // documentId: use the supplied document_id, or null for activeDocument queries.
    // null here means "not bound to a specific document by ID" — see read-guard.ts.
    const documentId = input.document_id ?? null;
    return sendReadScript<Envelope<Result>>(
      documentId,
      "get_page_state",
      { bodyFn: () => buildScriptBody(input) },
      (opts) => runScriptWithResultFile<ScriptResult>({ language: "JavaScript", resultSchema: ScriptResultSchema, ...opts }),
      (body, tok, docId) =>
        wrapExtendScript(body, { _readToken: tok, documentId: docId }),
    );
  },
});
