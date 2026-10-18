/**
 * save_document — a document that was never saved (live finding, InDesign 21.6.0.57).
 *
 * Observed live (ONE observation, one machine): for a never-saved document, doc.fullName THROWS
 * "Unsaved documents have no full name." (error number 90938) and doc.filePath THROWS
 * "Unsaved documents have no path." (90937). Neither returns "". Until this fix the pre-query read
 * String(doc.fullName) unguarded, so save-as of any new document failed with script_error.
 *
 *   P1..P8   the generated PRE-QUERY script
 *   W1..W6   the generated SAVE script
 *   F1..F6   the tool flow with the real write-guard (mocked transport, mkdtemp only)
 *
 * The scripts run in a node:vm sandbox that simulates only the ExtendScript objects they touch.
 * That shows the scripts' own logic, NOT InDesign's behaviour: the error numbers and messages below
 * are the values seen on the one live observation, supplied by the simulator.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";

vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

import { saveDocumentTool } from "../../../src/tools/save-document.js";
import * as wg from "../../../src/write-guard.js";
import { runScriptWithResultFile } from "../../../src/transport/result-file.js";

const mockRun = vi.mocked(runScriptWithResultFile);

let dir: string;
let counter = 0;

beforeEach(() => {
  mockRun.mockReset();
  wg.registryReset();
  dir = realpathSync(mkdtempSync(join(tmpdir(), "b8-unsaved-")));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ── simulator ────────────────────────────────────────────────────────────────

interface ErrSpec { message: string; number?: number }
type Prop = string | { throws: ErrSpec };

interface DocSim {
  saved: boolean;
  fullName: Prop;
  filePath: Prop;
}

const KNOWN_FULLNAME: ErrSpec = { message: "Unsaved documents have no full name.", number: 90938 };
const KNOWN_FILEPATH: ErrSpec = { message: "Unsaved documents have no path.", number: 90937 };

const UNSAVED: DocSim = {
  saved: false,
  fullName: { throws: KNOWN_FULLNAME },
  filePath: { throws: KNOWN_FILEPATH },
};

function innerSourceOf(scriptTemplate: string): string {
  const start = scriptTemplate.indexOf("indd.doScript(") + "indd.doScript(".length;
  const end = scriptTemplate.indexOf(", { language", start);
  return JSON.parse(scriptTemplate.slice(start, end)) as string;
}

function read(p: Prop): string {
  if (typeof p === "string") return p;
  throw Object.assign(new Error(p.throws.message), p.throws.number === undefined ? {} : { number: p.throws.number });
}

function runScript(scriptTemplate: string, sim: DocSim, target = { exists: true, length: 0 }) {
  const saves: string[] = [];
  // After a successful save InDesign knows the file: the simulator then behaves like a saved document.
  let state: DocSim = sim;
  const doc = {
    id: 42,
    get saved() { return state.saved; },
    get fullName() { return read(state.fullName); },
    get filePath() { return read(state.filePath); },
    save(f: { path: string }) {
      saves.push(f.path);
      state = { saved: true, fullName: f.path, filePath: dir };
    },
  };
  const app = {
    scriptPreferences: { userInteractionLevel: 0 },
    documents: [doc],
    activeDocument: doc,
  };
  const File = (p: string) => ({ path: p, exists: target.exists, length: target.length });
  const raw = new Script(innerSourceOf(scriptTemplate)).runInNewContext({
    app,
    UserInteractionLevels: { NEVER_INTERACT: 1 },
    File,
  });
  return { env: JSON.parse(raw as string), saves };
}

// ── script capture ───────────────────────────────────────────────────────────

function newPath(): string {
  return join(dir, `unsaved_${++counter}_cod.indd`);
}

/** The pre-query script of a save-as call (the call stops there: the mocked pre-query fails). */
async function preQueryScript(): Promise<string> {
  mockRun.mockResolvedValueOnce({ ok: false, error: { kind: "script_error", message: "stop here" } } as never);
  await saveDocumentTool.handler({ document_id: "42", path: newPath() });
  return (mockRun.mock.calls[0][0] as { scriptTemplate: string }).scriptTemplate;
}

/** The save script of a save-as call to a free path (pre-query and write are mocked as successes). */
async function saveScript(): Promise<{ path: string; tpl: string }> {
  const path = newPath();
  mockRun.mockResolvedValueOnce({ ok: true, result: { documentId: "42", fullName: "" } } as never);
  mockRun.mockResolvedValueOnce({ ok: true, result: { path } } as never);
  expect((await saveDocumentTool.handler({ document_id: "42", path })).ok).toBe(true);
  return { path, tpl: (mockRun.mock.calls[1][0] as { scriptTemplate: string }).scriptTemplate };
}

// ── pre-query ────────────────────────────────────────────────────────────────

describe("pre-query script — reading fullName", () => {
  it("P1: never-saved document with the known error pair (numbers and messages) → fullName \"\"", async () => {
    const tpl = await preQueryScript();
    const { env } = runScript(tpl, UNSAVED);
    expect(env.ok).toBe(true);
    expect(env.result).toEqual({ documentId: "42", fullName: "" });
  });

  it("P2: recognised by the numbers alone (the messages are in another language)", async () => {
    const tpl = await preQueryScript();
    const { env } = runScript(tpl, {
      saved: false,
      fullName: { throws: { message: "(localized text)", number: 90938 } },
      filePath: { throws: { message: "(localized text)", number: 90937 } },
    });
    expect(env.ok).toBe(true);
    expect(env.result.fullName).toBe("");
  });

  it("P3: recognised by the messages alone (the numbers differ or are missing)", async () => {
    const tpl = await preQueryScript();
    const { env } = runScript(tpl, {
      saved: false,
      fullName: { throws: { message: KNOWN_FULLNAME.message } },
      filePath: { throws: { message: KNOWN_FILEPATH.message, number: 1 } },
    });
    expect(env.ok).toBe(true);
    expect(env.result.fullName).toBe("");
  });

  it("P4: saved document with a normal fullName → the name is returned as before", async () => {
    const tpl = await preQueryScript();
    const { env } = runScript(tpl, { saved: true, fullName: "/Users/x/a.indd", filePath: "/Users/x" });
    expect(env.ok).toBe(true);
    expect(env.result).toEqual({ documentId: "42", fullName: "/Users/x/a.indd" });
  });

  it("P5: fullName throws the known error but filePath does NOT throw → the original error, no \"\"", async () => {
    const tpl = await preQueryScript();
    const { env } = runScript(tpl, { saved: false, fullName: { throws: KNOWN_FULLNAME }, filePath: "/Users/x" });
    expect(env.ok).toBe(false);
    expect(env.error.message).toBe(KNOWN_FULLNAME.message);
  });

  it("P6: saved === true with the known errors → not classified as unsaved; the original error", async () => {
    const tpl = await preQueryScript();
    const { env } = runScript(tpl, { saved: true, fullName: { throws: KNOWN_FULLNAME }, filePath: { throws: KNOWN_FILEPATH } });
    expect(env.ok).toBe(false);
    expect(env.error.message).toBe(KNOWN_FULLNAME.message);
  });

  it("P7: an unknown error (other number and message) → fails closed with that error", async () => {
    const tpl = await preQueryScript();
    const { env } = runScript(tpl, {
      saved: false,
      fullName: { throws: { message: "Something else went wrong", number: 12345 } },
      filePath: { throws: KNOWN_FILEPATH },
    });
    expect(env.ok).toBe(false);
    expect(env.error.message).toBe("Something else went wrong");
  });

  it("P8: fullName is the known error but filePath throws an UNKNOWN error → the original fullName error", async () => {
    const tpl = await preQueryScript();
    const { env } = runScript(tpl, {
      saved: false,
      fullName: { throws: KNOWN_FULLNAME },
      filePath: { throws: { message: "Something else went wrong", number: 12345 } },
    });
    expect(env.ok).toBe(false);
    expect(env.error.message).toBe(KNOWN_FULLNAME.message);
  });
});

// ── save script ──────────────────────────────────────────────────────────────

describe("save script — reading fullName before doc.save", () => {
  it("W1: still never saved (expected \"\") → the secured flow continues and saves once", async () => {
    const { path, tpl } = await saveScript();
    const { env, saves } = runScript(tpl, UNSAVED, { exists: true, length: 0 });
    expect(env.ok).toBe(true);
    expect(saves).toEqual([path]);
  });

  it("W2: unknown error while reading fullName → the original error, never reaches doc.save", async () => {
    const { tpl } = await saveScript();
    const { env, saves } = runScript(tpl, {
      saved: false,
      fullName: { throws: { message: "Something else went wrong", number: 12345 } },
      filePath: { throws: KNOWN_FILEPATH },
    });
    expect(env.ok).toBe(false);
    expect(env.error.message).toBe("Something else went wrong");
    expect(env.error.kind).toBe("script_error");
    expect(env.error.entity).toBe("save_precheck"); // raised before doc.save: this is the proof of "nothing written"
    expect(saves).toEqual([]);
  });

  it("W3: the document was saved elsewhere between the pre-query and the save → \"document changed\", no save", async () => {
    const { tpl } = await saveScript();
    const { env, saves } = runScript(tpl, { saved: true, fullName: "/Users/x/other.indd", filePath: "/Users/x" });
    expect(env.ok).toBe(false);
    expect(env.error.kind).toBe("io_error");
    expect(env.error.entity).toBe("save_precheck");
    expect(env.error.message).toContain("document changed between query and save");
    expect(saves).toEqual([]);
  });

  it("W4: saved === true with the known errors → not classified as unsaved, no save", async () => {
    const { tpl } = await saveScript();
    const { env, saves } = runScript(tpl, { saved: true, fullName: { throws: KNOWN_FULLNAME }, filePath: { throws: KNOWN_FILEPATH } });
    expect(env.ok).toBe(false);
    expect(env.error.message).toBe(KNOWN_FULLNAME.message);
    expect(env.error.entity).toBe("save_precheck");
    expect(saves).toEqual([]);
  });

  it("W5: the placeholder check still runs for a never-saved document (target not the empty placeholder → no save)", async () => {
    const { tpl } = await saveScript();
    const { env, saves } = runScript(tpl, UNSAVED, { exists: true, length: 7 });
    expect(env.ok).toBe(false);
    expect(env.error.kind).toBe("name_collision");
    expect(saves).toEqual([]);
  });

  it("W6: the re-thrown error keeps the original message and the stack; only the entity is added", async () => {
    const { tpl } = await saveScript();
    const { env } = runScript(tpl, {
      saved: false,
      fullName: { throws: { message: "Something else went wrong", number: 12345 } },
      filePath: { throws: KNOWN_FILEPATH },
    });
    expect(env.error).toMatchObject({ kind: "script_error", entity: "save_precheck", message: "Something else went wrong" });
    expect(typeof env.error.stack).toBe("string");
  });
});

// ── tool flow (real write-guard) ─────────────────────────────────────────────

describe("tool flow for a never-saved document", () => {
  it("F1: save-as with a new path goes through the guard: pre-query, then one write dispatch", async () => {
    const { path } = await saveScript();
    expect(mockRun).toHaveBeenCalledTimes(2);
    expect(existsSync(path)).toBe(true); // the placeholder stays until InDesign's real save replaces it
  });

  it("F2: in-place save without a path on a never-saved document → io_error, no write dispatch", async () => {
    mockRun.mockResolvedValueOnce({ ok: true, result: { documentId: "42", fullName: "" } } as never);
    const env = await saveDocumentTool.handler({ document_id: "42" });
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error("expected failure");
    expect(env.error.kind).toBe("io_error");
    expect(env.error.message).toContain("provide a `path` argument");
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it("F3: save-as to an existing file that is not ours → name_collision, no write dispatch, file untouched", async () => {
    const existing = join(dir, "client_file.indd");
    writeFileSync(existing, "CLIENT CONTENT");
    mockRun.mockResolvedValueOnce({ ok: true, result: { documentId: "42", fullName: "" } } as never);
    const env = await saveDocumentTool.handler({ document_id: "42", path: existing });
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error("expected failure");
    expect(env.error.kind).toBe("name_collision");
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(readFileSync(existing, "utf8")).toBe("CLIENT CONTENT");
  });

  it("F4: a failing pre-query is returned as it is (the original error), and nothing is written", async () => {
    mockRun.mockResolvedValueOnce({
      ok: false,
      error: { kind: "script_error", message: KNOWN_FULLNAME.message },
    } as never);
    const path = newPath();
    const env = await saveDocumentTool.handler({ document_id: "42", path });
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error("expected failure");
    expect(env.error.kind).toBe("script_error");
    expect(env.error.message).toBe(KNOWN_FULLNAME.message);
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(existsSync(path)).toBe(false);
  });

  it("F5: the save script fails BEFORE doc.save with the save_precheck entity → our empty placeholder is removed, the path is free", async () => {
    const path = newPath();
    mockRun.mockResolvedValueOnce({ ok: true, result: { documentId: "42", fullName: "" } } as never);
    mockRun.mockResolvedValueOnce({
      ok: false,
      error: { kind: "script_error", entity: "save_precheck", message: "Something else went wrong" },
    } as never);
    const env = await saveDocumentTool.handler({ document_id: "42", path });
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error("expected failure");
    expect(env.error.message).toContain("Something else went wrong");
    expect(env.error.message).not.toContain("is blocked");
    expect(existsSync(path)).toBe(false);
  });

  it("F6: a script_error WITHOUT the save_precheck entity is still an unknown outcome → the placeholder stays and the path is blocked", async () => {
    const path = newPath();
    mockRun.mockResolvedValueOnce({ ok: true, result: { documentId: "42", fullName: "" } } as never);
    mockRun.mockResolvedValueOnce({
      ok: false,
      error: { kind: "script_error", message: "Something else went wrong" },
    } as never);
    const env = await saveDocumentTool.handler({ document_id: "42", path });
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error("expected failure");
    expect(env.error.message).toContain("is blocked");
    expect(existsSync(path)).toBe(true);
  });
});
