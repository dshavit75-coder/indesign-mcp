/**
 * save_document with the REAL write-guard (F1 + F1b).
 *
 * Only the InDesign transport (runScriptWithResultFile) is mocked. write-guard,
 * the registry, path gate, placeholder handling and validateOperationBody are
 * the real implementations, running against an mkdtemp directory.
 *
 *   SA-1  save-as through the tool succeeds (real validateOperationBody accepts the real body)
 *   SA-2  the script actually sent contains doc.save(File( and no saveAs(
 *   SA-3  the guard still rejects a body without a save call
 *   FB-1  validation failure → normal error envelope, placeholder removed, no registry record
 *   FB-2  the decision is consumed by the failure and cannot be reused
 *   FB-3  a retry through the tool after the failure succeeds
 *   FB-4  a placeholder that gained content is NOT deleted by the failure path
 *
 * The tamper layer wraps sendWriteScript and always delegates to the real one;
 * it only swaps bodyFn so that the real validateOperationBody sees a bad body.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, realpathSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../../src/transport/result-file.js", () => ({
  runScriptWithResultFile: vi.fn(),
}));

const tamper = vi.hoisted(() => ({
  mode: "none" as "none" | "bad_body" | "bad_body_dirty",
}));

vi.mock("../../../src/write-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/write-guard.js")>();
  return {
    ...actual,
    sendWriteScript: ((...args: Parameters<typeof actual.sendWriteScript>) => {
      const [decision, request, sendFn, wrapFn] = args;
      if (tamper.mode === "bad_body") {
        return actual.sendWriteScript(
          decision,
          { ...request, scriptOpts: { bodyFn: () => "return 1;" } },
          sendFn,
          wrapFn,
        );
      }
      if (tamper.mode === "bad_body_dirty") {
        // bodyFn runs after assertWriteAllowed: simulate another process
        // writing into the placeholder at that point.
        return actual.sendWriteScript(
          decision,
          {
            ...request,
            scriptOpts: {
              bodyFn: () => {
                writeFileSync(request.finalPath, "someone else's data");
                return "return 1;";
              },
            },
          },
          sendFn,
          wrapFn,
        );
      }
      return actual.sendWriteScript(...args);
    }) as typeof actual.sendWriteScript,
  };
});

import { saveDocumentTool } from "../../../src/tools/save-document.js";
import * as wg from "../../../src/write-guard.js";
import { runScriptWithResultFile } from "../../../src/transport/result-file.js";

const mockRun = vi.mocked(runScriptWithResultFile);

let dir: string; // realpath of the mkdtemp directory
let counter = 0;

function newPath(): { path: string; key: string } {
  const name = `sa_test_${++counter}_cod.indd`;
  return { path: join(dir, name), key: `${dir}/${name}` };
}

function queueSave(path: string) {
  mockRun.mockResolvedValueOnce({ ok: true, result: { documentId: "42", fullName: "" } } as never); // pre-query
  mockRun.mockResolvedValueOnce({ ok: true, result: { path } } as never); // write
}

beforeEach(() => {
  mockRun.mockReset();
  tamper.mode = "none";
  wg.registryReset();
  dir = realpathSync(mkdtempSync(join(tmpdir(), "b8-sa-")));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("save_document with real write-guard — F1", () => {
  it("SA-1: save-as to a free path succeeds through the real guard", async () => {
    const { path, key } = newPath();
    queueSave(path);

    const env = await saveDocumentTool.handler({ path });

    expect(env.ok).toBe(true);
    expect(mockRun).toHaveBeenCalledTimes(2); // pre-query + write
    expect(wg.registryGet(key)?.state).toBe("owned");
  });

  it("SA-2: the script sent is doc.save(File(...)) and never saveAs(", async () => {
    const { path } = newPath();
    queueSave(path);

    await saveDocumentTool.handler({ path });

    const writeCall = mockRun.mock.calls[1][0] as { scriptTemplate: string };
    expect(writeCall.scriptTemplate).toContain("doc.save(File(");
    expect(writeCall.scriptTemplate).not.toContain("saveAs(");
  });

  it("SA-3: the guard still rejects a save-as body that has no save call", async () => {
    const { path } = newPath();
    const dr = await wg.decideWrite({
      tool: "save_document", operation: "save-as", documentId: "42", path, expectedExtension: ".indd",
    });
    expect(dr.ok).toBe(true);
    if (!dr.ok) return;
    const reserved = wg.reservePlaceholder(path);
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    const sendFn = vi.fn();
    const wrapFn = vi.fn();

    await expect(
      wg.sendWriteScript(
        dr.decision,
        {
          tool: "save_document", documentId: "42", finalPath: dr.decision.finalPath,
          operation: "save-as", reservedFingerprint: reserved.fingerprint,
          scriptOpts: { bodyFn: () => "return 1;" },
        },
        sendFn,
        wrapFn,
      ),
    ).rejects.toThrow("operation_body_mismatch");
    expect(sendFn).not.toHaveBeenCalled();
    expect(wrapFn).not.toHaveBeenCalled();
  });
});

describe("save_document with real write-guard — F1b (validation failure path)", () => {
  it("FB-1: validation failure → standard error envelope, placeholder removed, no registry record", async () => {
    const { path, key } = newPath();
    tamper.mode = "bad_body";
    mockRun.mockResolvedValueOnce({ ok: true, result: { documentId: "42", fullName: "" } } as never);

    const env = await saveDocumentTool.handler({ path }); // must resolve, not reject

    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.kind).toBe("write_not_authorized");
    expect(env.error.message).toContain("operation_body_mismatch");
    expect(mockRun).toHaveBeenCalledTimes(1); // pre-query only: nothing was written to InDesign
    expect(wg.registryGet(key)).toBeUndefined();
    await vi.waitFor(() => expect(existsSync(path)).toBe(false)); // cleanup is fire-and-forget
  });

  it("FB-2: the decision is consumed by the failure and cannot be reused", async () => {
    const { path, key } = newPath();
    const dr = await wg.decideWrite({
      tool: "save_document", operation: "save-as", documentId: "42", path, expectedExtension: ".indd",
    });
    expect(dr.ok).toBe(true);
    if (!dr.ok) return;
    const reserved = wg.reservePlaceholder(path);
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    const sendFn = vi.fn().mockResolvedValue({ path });
    const wrapFn = vi.fn().mockReturnValue("/* wrapped */");
    const request = (body: string) => ({
      tool: "save_document", documentId: "42", finalPath: dr.decision.finalPath,
      operation: "save-as" as const, reservedFingerprint: reserved.fingerprint,
      scriptOpts: { bodyFn: () => body },
    });

    await expect(wg.sendWriteScript(dr.decision, request("return 1;"), sendFn, wrapFn)).rejects.toThrow(
      "operation_body_mismatch",
    );
    expect(wg.registryGet(key)).toBeUndefined(); // no pending / owned / uncertain record

    const second = await wg.sendWriteScript(dr.decision, request("doc.save(File(path));"), sendFn, wrapFn);
    expect(second.ok).toBe(false); // same decision refused
    expect(sendFn).not.toHaveBeenCalled();
    expect(wrapFn).not.toHaveBeenCalled();
  });

  it("FB-3: a retry through the tool after the failure succeeds with a fresh decision", async () => {
    const { path, key } = newPath();
    tamper.mode = "bad_body";
    mockRun.mockResolvedValueOnce({ ok: true, result: { documentId: "42", fullName: "" } } as never);
    const failed = await saveDocumentTool.handler({ path });
    expect(failed.ok).toBe(false);
    await vi.waitFor(() => expect(existsSync(path)).toBe(false));

    tamper.mode = "none";
    queueSave(path);
    const retry = await saveDocumentTool.handler({ path });

    expect(retry.ok).toBe(true);
    expect(wg.registryGet(key)?.state).toBe("owned");
  });

  it("FB-4: a placeholder that gained content is not deleted, and the error is still normal", async () => {
    const { path, key } = newPath();
    tamper.mode = "bad_body_dirty";
    mockRun.mockResolvedValueOnce({ ok: true, result: { documentId: "42", fullName: "" } } as never);

    const env = await saveDocumentTool.handler({ path });

    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.kind).toBe("write_not_authorized");
    await new Promise((r) => setTimeout(r, 100)); // let any (wrongly) scheduled unlink run
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("someone else's data");
    expect(wg.registryGet(key)).toBeUndefined();
  });
});
