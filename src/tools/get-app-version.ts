import { z } from "zod";
import { defineTool } from "./registry.js";
import { runScriptWithResultFile } from "../transport/result-file.js";
import { wrapExtendScript } from "../compose.js";
import { sendReadScript } from "../read-guard.js";
import type { Envelope } from "../types.js";

const InputSchema = z.object({}).strict();

interface Result {
  version: string;
}

const SCRIPT_BODY = `
return { version: String(app.version) };
`.trim();

export const getAppVersionTool = defineTool<Record<string, never>, Result>({
  name: "get_app_version",
  description:
    "Returns the version string of the running InDesign application. Requires InDesign 2026 to be open.",
  inputSchema: InputSchema,
  async handler(): Promise<Envelope<Result>> {
    return sendReadScript<Envelope<Result>>(
      null,          // documentId: null — global query, not tied to any open document.
      "get_app_version",
      { bodyFn: () => SCRIPT_BODY },
      (opts) => runScriptWithResultFile<Result>({ language: "JavaScript", ...opts }),
      (body, tok, docId) =>
        wrapExtendScript(body, { _readToken: tok, documentId: docId }),
    );
  },
});
