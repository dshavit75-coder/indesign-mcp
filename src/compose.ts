// Stage 6: import capability consumer for the write track.
// Stage 7B: import ReadToken consumer for the read track.
// compose.ts remains a leaf for callers that pass no opts (legacy pass-through).
import { consumeWriteCapability } from "./write-capability.js";
import type { WriteOperation } from "./write-capability.js";
import { consumeReadToken } from "./read-capability.js";

/**
 * Sentinel replaced by runScriptWithResultFile with the actual temp-file path
 * before the script is dispatched to osascript.
 */
export const RESULT_PATH_SENTINEL = "__INDESIGN_MCP_RESULT_PATH__";

/**
 * Returns the JavaScript source representation of a primitive value, safe
 * for interpolation into an ExtendScript body string. Always use this when
 * embedding tool input values into a script:
 *
 *   const body = `var w = ${lit(input.width_mm)}; var name = ${lit(input.name)};`;
 *
 * Strings get JSON-quoted (escaping handled). Numbers and booleans serialize
 * as their JS literal form. null/undefined become "null".
 */
export function lit(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

/**
 * Minimal JSON.stringify shim for InDesign's ExtendScript engine, which is
 * pre-ES5 and does not provide a global JSON. Handles primitives, arrays, and
 * plain objects. Strings are escaped to be JSON-safe.
 *
 * Authored as a String.raw template so backslash sequences inside regex/string
 * literals are passed through verbatim into the runtime ExtendScript source.
 */
const ES_STRINGIFY = String.raw`function _stringify(v) {
  if (v === null || v === undefined) return 'null';
  var t = typeof v;
  if (t === 'number') return isFinite(v) ? String(v) : 'null';
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'string') {
    return '"' + v
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t') + '"';
  }
  if (t === 'object') {
    if (Object.prototype.toString.call(v) === '[object Array]') {
      var parts = [];
      for (var i = 0; i < v.length; i++) parts.push(_stringify(v[i]));
      return '[' + parts.join(',') + ']';
    }
    var pairs = [];
    for (var k in v) {
      if (v.hasOwnProperty(k)) pairs.push(_stringify(k) + ':' + _stringify(v[k]));
    }
    return '{' + pairs.join(',') + '}';
  }
  return 'null';
}`;

/**
 * Joins a sequence of ExtendScript helper sources with newlines, suitable
 * for prepending to a tool's body string. Use:
 *
 *   const body = prelude(findDocumentById, findPageById) + `var doc = findDocumentById(${lit(id)}); ...`;
 */
export function prelude(...sources: string[]): string {
  return sources.join("\n") + "\n";
}

/**
 * Wraps an ExtendScript body in a JXA shell that dispatches to InDesign.
 *
 * Body must end with `return <value>;` — it's invoked inside an IIFE.
 * Sentinel RESULT_PATH_SENTINEL is substituted by runScriptWithResultFile.
 *
 * Result envelopes written:
 *   success              → {ok:true, result}
 *   structured throw     → {ok:false, error:{kind, message, [entity], [id], [stack]}}
 *   plain JS throw       → {ok:false, error:{kind:"script_error", message, stack}}
 *   no InDesign          → {ok:false, error:{kind:"app_not_available", message}}
 *
 * Stage 7B — three tracks:
 *   1. Write operation: opts._writeCapability present → consumeWriteCapability()
 *      The capability is consumed here, binding the body to the authorized operation.
 *   2. Read operation: opts._readToken present → consumeReadToken() [Stage 7B: active]
 *   3. Legacy pass-through: no opts → allowed in Stage 6 for the 30+ read tools
 *      that have not yet been given ReadTokens. Stage 7 will replace this with
 *      `throw new Error("missing_token: ...")`.
 */
export function wrapExtendScript(
  body: string,
  opts?:
    | { _writeCapability: object; operation: WriteOperation }
    | { _readToken: object; documentId: string | null },
): string {
  if (opts !== undefined && "_writeCapability" in opts) {
    // Write track: consume the capability — throws if not authorized, mismatched body/op, or already used.
    consumeWriteCapability(opts._writeCapability, body, opts.operation);
  } else if (opts !== undefined && "_readToken" in opts) {
    // Read track (Stage 7B): consume the token — throws if not issued, already used,
    // or documentId does not match.
    //
    // KNOWN LIMITATION: enforcement here does not prevent a caller from constructing
    // a scriptTemplate string and passing it directly to runScriptWithResultFile,
    // bypassing wrapExtendScript entirely. Full enforcement at the send point is a
    // Stage 7F task. result-file.ts is a protected file and is not modified here.
    consumeReadToken(opts._readToken, opts.documentId, "wrapExtendScript");
  }
  // else: legacy pass-through — no token required in Stage 6.
  const innerSource =
    ES_STRINGIFY +
    `
(function() {
  var knownKinds = {
    "not_found": true,
    "app_not_available": true,
    "io_error": true,
    "name_collision": true,
    "invalid_args": true,
    "timeout": true,
    "script_error": true
  };
  var prevLevel = app.scriptPreferences.userInteractionLevel;
  app.scriptPreferences.userInteractionLevel = UserInteractionLevels.NEVER_INTERACT;
  try {
    try {
      var __r = (function() {
${body}
      })();
      return '{"ok":true,"result":' + _stringify(__r) + '}';
    } catch (e) {
      if (e && typeof e === "object" && knownKinds[e.name]) {
        var kindName = e.name;
        var errObj = { kind: kindName, message: String(e.message || e.name) };
        if (e.entity) errObj.entity = String(e.entity);
        if (e.id) errObj.id = String(e.id);
        if (e.stack) errObj.stack = String(e.stack);
        return _stringify({ ok: false, error: errObj });
      }
      var msg = String(e.message || e);
      var stk = String(e.stack || '');
      return _stringify({ ok: false, error: { kind: "script_error", message: msg, stack: stk } });
    }
  } finally {
    app.scriptPreferences.userInteractionLevel = prevLevel;
  }
})();
`;

  const innerLiteral = JSON.stringify(innerSource);

  return `
ObjC.import("Foundation");
var resultPath = "${RESULT_PATH_SENTINEL}";

function writeResult(envObj) {
  var s = $.NSString.alloc.initWithUTF8String(JSON.stringify(envObj));
  s.writeToFileAtomicallyEncodingError(resultPath, true, $.NSUTF8StringEncoding, null);
}

try {
  var indd = Application("Adobe InDesign 2026");
  var raw = indd.doScript(${innerLiteral}, { language: "javascript" });
  var env = JSON.parse(String(raw));
  writeResult(env);
} catch (outer) {
  var msg = String(outer.message || outer);
  var n = outer.errorNumber;
  var kind = (n === -600 || n === -1728 || n === -10814 ||
              msg.indexOf("Application can't be found") !== -1)
    ? "app_not_available"
    : "script_error";
  writeResult({ ok:false, error: { kind: kind, message: msg } });
}
`;
}
