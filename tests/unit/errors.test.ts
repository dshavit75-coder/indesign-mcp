import { describe, it, expect } from "vitest";
import { ok, fail, ErrorKind } from "../../src/errors.js";

describe("envelope helpers", () => {
  it("ok() builds a success envelope with a payload", () => {
    const env = ok({ value: 42 });
    expect(env).toEqual({ ok: true, result: { value: 42 } });
  });

  it("ok() with no payload still sets ok: true", () => {
    const env = ok();
    expect(env).toEqual({ ok: true });
  });

  it("fail() builds an error envelope with kind + message", () => {
    const env = fail("not_found", "frame 99 missing");
    expect(env).toEqual({
      ok: false,
      error: { kind: "not_found", message: "frame 99 missing" },
    });
  });

  it("fail() preserves additional error details", () => {
    const env = fail("script_error", "bad ref", { stack: "line 3" });
    expect(env).toEqual({
      ok: false,
      error: { kind: "script_error", message: "bad ref", stack: "line 3" },
    });
  });

  it("ErrorKind covers exactly the closed set from the spec", () => {
    // Compile-time exhaustiveness: if ErrorKind gains or loses a member,
    // this Record literal fails to type-check (missing key or excess key).
    const exhaustive: Record<ErrorKind, true> = {
      script_error: true,
      app_not_available: true,
      not_found: true,
      name_collision: true,
      io_error: true,
      timeout: true,
      invalid_args: true,
      foreign_document_open: true,   // B8
      pdf_replace_blocked: true,     // B8
      write_not_authorized: true,    // B8
    };
    expect(Object.keys(exhaustive).sort()).toEqual([
      "app_not_available",
      "foreign_document_open",
      "invalid_args",
      "io_error",
      "name_collision",
      "not_found",
      "pdf_replace_blocked",
      "script_error",
      "timeout",
      "write_not_authorized",
    ]);
  });

  it("ok() accepts an optional warnings array", () => {
    const env = ok({ value: 1 }, { warnings: ["font substituted"] });
    expect(env).toEqual({
      ok: true,
      result: { value: 1 },
      warnings: ["font substituted"],
    });
  });

  it("ok() accepts an optional document_state_delta", () => {
    const delta = { new_frames: [{ id: "f1", type: "text" as const }], page_count: 2 };
    const env = ok({ value: 1 }, { document_state_delta: delta });
    expect(env).toEqual({
      ok: true,
      result: { value: 1 },
      document_state_delta: delta,
    });
  });

  it("ok() omits warnings/delta keys when not provided", () => {
    const env = ok({ value: 1 });
    expect(env).toEqual({ ok: true, result: { value: 1 } });
    expect(Object.keys(env)).not.toContain("warnings");
    expect(Object.keys(env)).not.toContain("document_state_delta");
  });

  it("ok() works with no args and accepts options", () => {
    const env = ok(undefined, { warnings: ["empty op"] });
    expect(env).toEqual({ ok: true, warnings: ["empty op"] });
  });
});
