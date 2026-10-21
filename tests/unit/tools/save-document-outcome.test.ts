/**
 * save_document path A — what happens to the reserved placeholder (and so to the path) after a
 * failed save-as, depending on whether the failure PROVES that nothing was written.
 * Real write-guard, mocked InDesign transport, real files in mkdtemp. No InDesign.
 *
 *   O1   timeout: outcome unknown -> placeholder kept, path blocked, error explains it
 *   O2   failures that do NOT prove "nothing written" (including every other io_error and
 *        look-alikes of the proofs) -> placeholder kept
 *   O3   failures that DO prove it -> placeholder removed, the next save-as is an ordinary retry
 *   O4   transport rejects after dispatch -> kept
 *   O5   exception before the transport is called -> removed, retry works
 *   O6   InDesign had already written the file -> it is never removed
 *   O7   a late write after a manual clean-up is detected afterwards (not prevented)
 *   O8   path B is untouched by this logic
 *   O9   the failure envelope's own fields survive; only the message gains the explanation
 *
 * The transport is mocked: these tests do not show what InDesign does after a timeout (it may
 * keep running), only how the tool classifies and reacts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync, realpathSync, writeFileSync, existsSync, lstatSync, readFileSync, unlinkSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

const hook = vi.hoisted(() => ({ throwOnFirstCall: false, calls: 0 }));

vi.mock("../../../src/write-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/write-guard.js")>();
  return {
    ...actual,
    sendWriteScript: ((...args: Parameters<typeof actual.sendWriteScript>) => {
      hook.calls++;
      if (hook.throwOnFirstCall && hook.calls === 1) throw new Error("injected failure before dispatch");
      return actual.sendWriteScript(...args);
    }) as typeof actual.sendWriteScript,
  };
});

import { saveDocumentTool } from "../../../src/tools/save-document.js";
import * as wg from "../../../src/write-guard.js";
import { runScriptWithResultFile } from "../../../src/transport/result-file.js";
import type { Envelope } from "../../../src/types.js";

const mockRun = vi.mocked(runScriptWithResultFile);

let dir: string;
let counter = 0;

beforeEach(() => {
  mockRun.mockReset();
  hook.throwOnFirstCall = false;
  hook.calls = 0;
  wg.registryReset();
  dir = realpathSync(mkdtempSync(join(tmpdir(), "b8-outcome-")));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function newPath() {
  const name = `outcome_${++counter}_cod.indd`;
  return { path: join(dir, name), key: `${dir}/${name}` };
}

function failure(env: Envelope<unknown>) {
  expect(env.ok).toBe(false);
  if (env.ok) throw new Error("expected a failure envelope");
  return env.error;
}

const isWrite = (o: unknown) => (o as { scriptTemplate: string }).scriptTemplate.includes("doc.save(File(");

/**
 * Transport mock: pre-queries answer document 42; the FIRST write script gets `first(path)`
 * (a value, or a promise, which may reject); later write scripts succeed.
 */
function installTransport(path: string, first: (path: string) => unknown, fullName = "") {
  const log: string[] = [];
  let writes = 0;
  mockRun.mockImplementation(((o: { scriptTemplate: string }) => {
    if (!isWrite(o)) {
      log.push("pre");
      return Promise.resolve({ ok: true, result: { documentId: "42", fullName } });
    }
    log.push("write");
    writes++;
    return writes === 1 ? Promise.resolve().then(() => first(path)) : Promise.resolve({ ok: true, result: { path } });
  }) as never);
  return { log };
}

const HINT = "was left in place";
const envelope = (kind: string, message: string, extra: Record<string, string> = {}) => ({
  ok: false,
  error: { kind, message, ...extra },
});

/** First call fails with `first`; returns what the first and the next save-as to the same path did. */
async function failThenRetry(first: (path: string) => unknown) {
  const { path, key } = newPath();
  const t = installTransport(path, first);
  const e1 = await saveDocumentTool.handler({ document_id: "42", path });
  const afterFirst = { placeholderExists: existsSync(path), record: wg.registryGet(key)?.state };
  const e2 = await saveDocumentTool.handler({ document_id: "42", path });
  return { path, key, t, e1, e2, afterFirst };
}

// ── O1: timeout ─────────────────────────────────────────────────────────────

describe("O1 — timeout: the outcome is unknown", () => {
  it("rejects missing document_id", () => {
    expect(saveDocumentTool.inputSchema.safeParse({}).success).toBe(false);
  });

  it("rejects empty document_id", () => {
    expect(saveDocumentTool.inputSchema.safeParse({ document_id: "" }).success).toBe(false);
  });

  it("rejects whitespace-only document_id", () => {
    expect(saveDocumentTool.inputSchema.safeParse({ document_id: "   " }).success).toBe(false);
  });

  it("keeps the empty placeholder, blocks the path, and tells the caller; the next save-as is refused and writes nothing", async () => {
    const { path, key, t, e1, e2, afterFirst } = await failThenRetry(() => envelope("timeout", "osascript dispatch exceeded timeout"));

    const first = failure(e1);
    expect(first.kind).toBe("timeout"); // the transport's own kind is preserved
    expect(first.message).toContain(HINT);
    expect(first.message).toContain(path); // names the file to deal with
    expect(afterFirst).toEqual({ placeholderExists: true, record: "uncertain" });
    expect(lstatSync(path).size).toBe(0);

    const second = failure(e2);
    expect(second.kind).toBe("name_collision");
    expect(second.reason).toBe("uncertain");
    expect(t.log).toEqual(["pre", "write", "pre"]); // no second write script
    expect(wg.registryGet(key)?.state).toBe("uncertain");
  });
});

// ── O2 / O3: classification ─────────────────────────────────────────────────

describe("O2 — failures that do not prove 'nothing written' keep the placeholder", () => {
  const unknown: Array<[string, () => unknown]> = [
    ["timeout", () => envelope("timeout", "osascript dispatch exceeded timeout")],
    ["script_error", () => envelope("script_error", "InDesign threw while saving")],
    ["app_not_available", () => envelope("app_not_available", "Application can't be found")],
    ["a generic io_error (result file unreadable after the script ran)", () => envelope("io_error", "result file missing or unreadable")],
    ["an io_error that only MENTIONS spawn", () => envelope("io_error", "the osascript spawn failed earlier was retried")],
    ["name_collision WITHOUT the pre-save entity", () => envelope("name_collision", "target is not the empty reserved placeholder")],
    ["not_found WITHOUT entity 'document'", () => envelope("not_found", "document 42 not found")],
    ["an io_error whose MESSAGE mentions save_precheck but has no entity", () => envelope("io_error", "save_precheck says nothing was written")],
    ["an unrecognised entity", () => envelope("io_error", "document changed", { entity: "something_else" })],
    ["entity 'document' but a kind other than not_found", () => envelope("script_error", "document handling failed", { entity: "document" })],
  ];

  it.each(unknown)("%s → placeholder kept, message explains, next save-as refused", async (_label, produce) => {
    const { t, e1, e2, afterFirst } = await failThenRetry(produce);

    expect(failure(e1).message).toContain(HINT);
    expect(afterFirst.placeholderExists).toBe(true);
    expect(afterFirst.record).toBe("uncertain");
    const second = failure(e2);
    expect(second.kind).toBe("name_collision");
    expect(second.reason).toBe("uncertain");
    expect(t.log).toEqual(["pre", "write", "pre"]);
  });
});

describe("O3 — failures that DO prove 'nothing written' remove the placeholder", () => {
  const proofs: Array<[string, () => unknown]> = [
    ["the script's own pre-save check (io_error + entity save_precheck)", () => envelope("io_error", "document changed between query and save", { entity: "save_precheck" })],
    ["the script's own pre-save check (name_collision + entity save_precheck)", () => envelope("name_collision", "target is not the empty reserved placeholder", { entity: "save_precheck" })],
    ["findDocumentById failed (not_found + entity document)", () => envelope("not_found", "document 42 not found", { entity: "document", id: "42" })],
    ["osascript could not even be spawned", () => envelope("io_error", "osascript spawn failed: ENOENT")],
  ];

  it.each(proofs)("%s → placeholder removed, no hint, the next save-as is an ordinary retry", async (_label, produce) => {
    const { path, key, t, e1, e2, afterFirst } = await failThenRetry(produce);

    expect(failure(e1).message).not.toContain(HINT);
    expect(afterFirst).toEqual({ placeholderExists: false, record: "uncertain" });
    expect(e2.ok).toBe(true); // the path was really free
    expect(t.log).toEqual(["pre", "write", "pre", "write"]);
    expect(wg.registryGet(key)?.state).toBe("owned");
    expect(existsSync(path)).toBe(true);
  });
});

// ── O4, O5: where the failure happened ──────────────────────────────────────

describe("O4 — the transport rejects after dispatch", () => {
  it("is unknown: placeholder kept, io_error/uncertain with the explanation, next save-as refused", async () => {
    const { t, e1, e2, afterFirst } = await failThenRetry(() => { throw new Error("osascript died"); });

    const first = failure(e1);
    expect(first.kind).toBe("io_error");
    expect(first.reason).toBe("uncertain");
    expect(first.message).toContain("osascript died");
    expect(first.message).toContain(HINT);
    expect(afterFirst).toEqual({ placeholderExists: true, record: "uncertain" });
    expect(failure(e2).reason).toBe("uncertain");
    expect(t.log).toEqual(["pre", "write", "pre"]);
  });
});

describe("O5 — an exception before the transport is called", () => {
  it("proves nothing was sent: placeholder removed, normal error, and the retry succeeds", async () => {
    const { path, key } = newPath();
    const t = installTransport(path, () => ({ ok: true, result: { path } }));
    hook.throwOnFirstCall = true;

    const e1 = await saveDocumentTool.handler({ document_id: "42", path });

    const first = failure(e1);
    expect(first.kind).toBe("write_not_authorized");
    expect(first.message).not.toContain(HINT);
    expect(existsSync(path)).toBe(false);
    expect(t.log).toEqual(["pre"]); // the transport was never asked to write

    const e2 = await saveDocumentTool.handler({ document_id: "42", path });
    expect(e2.ok).toBe(true);
    expect(wg.registryGet(key)?.state).toBe("owned");
  });
});

// ── O6, O7: X2 and X3 ───────────────────────────────────────────────────────

describe("O6 — InDesign had already written the file (X2)", () => {
  it("a file with content is never removed, whatever the failure; the next save-as is refused", async () => {
    const { path, e1, e2 } = await failThenRetry((p) => {
      writeFileSync(p, "REAL INDD CONTENT"); // the save happened, then the result could not be read
      return envelope("io_error", "result file missing or unreadable");
    });

    expect(failure(e1).message).toContain(HINT);
    expect(readFileSync(path, "utf8")).toBe("REAL INDD CONTENT");
    const second = failure(e2);
    expect(second.kind).toBe("name_collision");
    expect(second.reason).toBe("uncertain");
  });
});

describe("O7 — a late write (X3)", () => {
  it("after a timeout and a manual clean-up, a late write by the timed-out script is detected by the next save — not prevented", async () => {
    const { path, key } = newPath();
    installTransport(path, () => envelope("timeout", "osascript dispatch exceeded timeout"));

    failure(await saveDocumentTool.handler({ document_id: "42", path })); // timeout: placeholder kept, path blocked
    expect(existsSync(path)).toBe(true);
    unlinkSync(path); // the user inspects and removes the placeholder

    const retry = await saveDocumentTool.handler({ document_id: "42", path }); // an ordinary save-as to the now-free path
    expect(retry.ok).toBe(true);
    expect(wg.registryGet(key)?.state).toBe("owned");

    writeFileSync(path, "LATE WRITE FROM THE TIMED-OUT SCRIPT"); // the first script finally finishes
    mockRun.mockImplementation(((o: { scriptTemplate: string }) =>
      Promise.resolve(isWrite(o) ? { ok: true, result: { path } } : { ok: true, result: { documentId: "42", fullName: path } })) as never);

    const next = failure(await saveDocumentTool.handler({ document_id: "42" })); // the next in-place save
    expect(next.kind).toBe("name_collision");
    expect(next.reason).toBe("fingerprint_mismatch"); // the overwritten content was NOT prevented, only detected here
    expect(readFileSync(path, "utf8")).toBe("LATE WRITE FROM THE TIMED-OUT SCRIPT");
  });
});

// ── O8, O9 ──────────────────────────────────────────────────────────────────

describe("O8 — path B has no placeholder and is not affected", () => {
  it("an in-place failure keeps its behaviour: uncertain record, message without the placeholder explanation", async () => {
    const { path, key } = newPath();
    writeFileSync(path, "0123456789");
    const st = lstatSync(path);
    wg.registrySet(key, {
      state: "owned", documentId: "42", tool: "save_document",
      fingerprint: { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs },
    });
    installTransport(path, () => envelope("timeout", "osascript dispatch exceeded timeout"), path);

    const error = failure(await saveDocumentTool.handler({ document_id: "42" }));

    expect(error.kind).toBe("timeout");
    expect(error.message).toBe("osascript dispatch exceeded timeout"); // untouched
    expect(wg.registryGet(key)?.state).toBe("uncertain");
    expect(existsSync(path)).toBe(true); // the owned file itself is never touched
  });
});

describe("O9 — the failure envelope keeps its own fields", () => {
  it("only the message gains the explanation; kind, stack, entity and id are unchanged", async () => {
    const { e1 } = await failThenRetry(() =>
      envelope("script_error", "InDesign threw while saving", { stack: "at doc.save", entity: "document_save", id: "42" }));

    const error = failure(e1);
    expect(error.kind).toBe("script_error");
    expect(error.stack).toBe("at doc.save");
    expect(error.entity).toBe("document_save");
    expect(error.id).toBe("42");
    expect(error.message.startsWith("InDesign threw while saving. ")).toBe(true);
    expect(error.message).toContain(HINT);
  });
});
