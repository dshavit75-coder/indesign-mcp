# B9-S2 — Mutate-token track for six object-creation tools

**Date:** 2026-10-22
**Base commit:** `f6d699b` (`fix: require document_id for existing-document tools`)
**Prerequisite:** B9-S1 complete — `document_id` is required and non-empty in all 27 target tools.
**Status:** Plan only. No code has been changed.

---

## 1. Goals

Extend the Stage 7C mutate-token track (introduced in `769d5d1` for
`apply_paragraph_style` and `apply_character_style_to_range`) to the six
object-creation tools listed below, now that `document_id` is guaranteed
non-empty at the schema layer (B9-S1).

A MutateToken binds the exact script body **and** the `documentId` into a
single-use capability token. `consumeMutateToken` in `wrapExtendScript`
verifies both before the script is dispatched. A forged token, a replayed
token, a wrong document ID, or a swapped script body each throw
`mutate_not_authorized` and prevent dispatch.

This partially closes G5 for these six tools. G5, G6, and G7 are **not**
fully closed by S2 (see §9).

---

## 2. Scope

### In scope — exactly these six tools

| Tool | Source file |
|------|-------------|
| `create_text_frame` | `src/tools/create-text-frame.ts` |
| `create_image_frame` | `src/tools/create-image-frame.ts` |
| `create_line` | `src/tools/create-line.ts` |
| `create_parent_page` | `src/tools/create-parent-page.ts` |
| `create_rectangle` | `src/tools/create-rectangle.ts` |
| `create_swatch` | `src/tools/create-swatch.ts` |

### Explicitly out of scope

- The remaining **15 mutating tools** still on the legacy pass-through (G5
  stays open for them). They require a separate plan and approval.
- `create_document` — requires a separate decision and approval per F2 §161
  and decision D2-d. Not touched here.
- `src/transport/result-file.ts`, `src/compose.ts`, `src/write-guard.ts`,
  `src/mutate-guard.ts`, `src/mutate-capability.ts`, `src/server.ts`,
  `src/types.ts` — protected files, not modified.
- `CLAUDE.md`, `dist/`, `package.json`, `package-lock.json`, `tsconfig.json` —
  not modified.
- Integration test files — not modified (integration suite is blocked until
  CloseToken infrastructure is done; see PROJECT_STATE).
- Any expansion of scope beyond the six tools above.

---

## 3. Current state vs. target state

All six tools are identical in structure after B9-S1. The current and target
states are therefore described once and apply to all six.

### Current state (after B9-S1)

```
handler(input) {
  const env = await runScriptWithResultFile<ScriptResult>({
    language: "JavaScript",
    scriptTemplate: wrapExtendScript(buildScriptBody(input)),
    // ↑ legacy pass-through: wrapExtendScript called without opts,
    //   no _mutateToken, no token binding, G5 open for this tool.
    resultSchema: ScriptResultSchema,
  });
  return ok(env.result!, { document_state_delta: { ... } });
}
```

- `document_id` is required and non-empty (B9-S1 ✓).
- `findDocumentById(lit(input.document_id))` used in script body (B9-S1 ✓).
- **No mutate token.** Script dispatched via legacy pass-through.
- Unit tests mock only `result-file.js`; no tamper suite.

### Target state (after B9-S2)

```
import { sendMutateScript } from "../mutate-guard.js";

handler(input) {
  const env = await sendMutateScript<
    Awaited<ReturnType<typeof runScriptWithResultFile<ScriptResult>>>
  >(
    input.document_id,                          // documentId bound in token
    () => buildScriptBody(input),               // body built BEFORE token issued
    (body, tok, docId) =>
      wrapExtendScript(body, { _mutateToken: tok, documentId: docId }),
    (scriptTemplate) =>
      runScriptWithResultFile<ScriptResult>({
        language: "JavaScript",
        scriptTemplate,
        resultSchema: ScriptResultSchema,
      }),
    "create_<tool_name>",                       // toolName for audit
  );
  if (!env.ok) return env;
  const r = env.result!;
  return ok(r, { document_state_delta: { ... } });
}
```

- `sendMutateScript` flow (from `mutate-guard.ts`):
  1. Build body (`bodyFn()`).
  2. Issue token binding body + documentId (`issueMutateToken`).
  3. Wrap — `consumeMutateToken` runs inside `wrapExtendScript` on the
     `_mutateToken` track.
  4. Dispatch (`sendFn`).
  5. On any throw: revoke token silently (`revokeMutateToken`).

**Note on `?? null`:** `apply_paragraph_style` has `const documentId = input.document_id ?? null`
before calling `sendMutateScript`. The six S2 tools do **not** have this
intermediate variable. After B9-S1 `input.document_id` is always a non-empty
string, so `input.document_id` is passed directly. The null branch is
unreachable and there is no reason to introduce it.

---

## 4. Files to change

| File | Change | Reason |
|------|--------|--------|
| `src/tools/create-text-frame.ts` | Add import `sendMutateScript`; replace `runScriptWithResultFile` direct call in handler with `sendMutateScript` pattern; add `if (!env.ok) return env` guard | Activate mutate-token track |
| `src/tools/create-image-frame.ts` | Same | Same |
| `src/tools/create-line.ts` | Same | Same |
| `src/tools/create-parent-page.ts` | Same | Same |
| `src/tools/create-rectangle.ts` | Same | Same |
| `src/tools/create-swatch.ts` | Same | Same |
| `tests/unit/tools/create-text-frame.test.ts` | Add tamper suite T1–T5 + `vi.mock("../../../src/compose.js")` partial mock | Verify token enforcement, not just that a mock was called |
| `tests/unit/tools/create-image-frame.test.ts` | Same | Same |
| `tests/unit/tools/create-line.test.ts` | Same | Same |
| `tests/unit/tools/create-parent-page.test.ts` | Same | Same |
| `tests/unit/tools/create-rectangle.test.ts` | Same | Same |
| `tests/unit/tools/create-swatch.test.ts` | Same | Same |

**Total: 12 files.**

No other files are modified. `mutate-guard.ts` and `mutate-capability.ts` are
unchanged; the token machinery is already in place from `769d5d1`.

---

## 5. TDD plan — tests that must FAIL before implementation and PASS after

Each of the six tools gets the same five tamper tests (T1–T5). The model is
identical to the `apply_paragraph_style` tamper suite in
`tests/unit/tools/apply-paragraph-style.test.ts` (lines 116–227).

### 5.1 Mocking strategy

The key insight: mocking only `result-file.js` does **not** verify that the
token enforcement ran. A test that mocks `runScriptWithResultFile` and checks
it was called once proves only that a script was dispatched — it does not
prove the token was checked.

To verify the token machinery, we mock `compose.js` **partially**: the mock
intercepts `wrapExtendScript` calls on the `_mutateToken` track only, and
forwards every call to the **real** `wrapExtendScript` (via `importOriginal`).
This means `consumeMutateToken` runs for real inside the real implementation.
A tampered call therefore throws a real `mutate_not_authorized` error — not a
mock assertion.

```typescript
// vi.hoisted state shared across tamper tests:
const tamper = vi.hoisted(() => ({
  mode: "passthrough" as
    | "passthrough" | "forged" | "replay" | "wrong_doc" | "body_swap",
  firstConsumeOk: 0,
}));

vi.mock("../../../src/compose.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/compose.js")>();
  return {
    ...actual,
    wrapExtendScript: (...args: Parameters<typeof actual.wrapExtendScript>) => {
      const [body, opts] = args;
      if (opts !== undefined && "_mutateToken" in opts) {
        if (tamper.mode === "forged")
          return actual.wrapExtendScript(body, { _mutateToken: {}, documentId: opts.documentId });
        if (tamper.mode === "replay") {
          actual.wrapExtendScript(body, opts);   // consume once (does not throw)
          tamper.firstConsumeOk++;
          return actual.wrapExtendScript(body, opts); // second use — throws
        }
        if (tamper.mode === "wrong_doc")
          return actual.wrapExtendScript(body, { _mutateToken: opts._mutateToken, documentId: "doc-EVIL" });
        if (tamper.mode === "body_swap")
          return actual.wrapExtendScript("var evil = 1; return {};", { _mutateToken: opts._mutateToken, documentId: opts.documentId });
      }
      return actual.wrapExtendScript(...args);
    },
  };
});
```

### 5.2 Tamper tests (per tool, same structure for all six)

Use a `validInput` object appropriate for the tool (with `document_id: "doc-1"` and the
minimum required fields).

| Test | Tamper mode | Expected result | Proves |
|------|-------------|-----------------|--------|
| **T1** — happy path | `passthrough` | `runScriptWithResultFile` called exactly once | Normal dispatch works end-to-end through `sendMutateScript` |
| **T2** — forged token | `forged` | throws `mutate_not_authorized: token not issued by this guard`; `runScriptWithResultFile` not called | A token not issued by `issueMutateToken` is rejected before dispatch |
| **T3** — replay | `replay` | throws `mutate_not_authorized: token not issued by this guard`; `firstConsumeOk === 1`; `runScriptWithResultFile` not called | Token is single-use; the first consume succeeded so the rejection is the single-use check, not a bad token |
| **T4** — wrong document | `wrong_doc` | throws `mutate_not_authorized: documentId mismatch`; `runScriptWithResultFile` not called | Token is bound to the document ID at issue time |
| **T5** — body swap | `body_swap` | throws `mutate_not_authorized: body mismatch`; `runScriptWithResultFile` not called | Token is bound to the exact script body at issue time |

### 5.3 Existing tests — must continue to pass unchanged

The existing dispatch tests (`vi.mocked(runScriptWithResultFile).mockResolvedValueOnce(...)`)
continue to work after the change because `sendMutateScript` still calls
`runScriptWithResultFile` at the end of its chain. The mock intercepts the call
at the same point. No existing test is modified.

The three schema tests added in B9-S1 (`rejects missing / empty / whitespace-only
document_id`) are untouched.

### 5.4 Test count

The last verified test run was **912 tests** (the base for this plan). B9-S2
adds **30 new tests** (5 × 6 tools). The arithmetic projection is **942 tests**.
This is a computational estimate only. The actual count must be verified by
running `npm test` after implementation.

---

## 6. Validation commands

Run in this order on the Mac (Linux container cannot run `npm test`):

```bash
cd ~/Projects/indesign-mcp

# 1. TypeScript — must exit 0
npx tsc --noEmit

# 2. Unit tests — must pass; verify count ≥ 942
npm test

# 3. Verify all six tools use sendMutateScript
grep -c "sendMutateScript" src/tools/create-{text-frame,image-frame,line,parent-page,rectangle,swatch}.ts
# expected: 1 per file (6 lines total)

# 4. Verify no direct runScriptWithResultFile call outside sendFn callback
grep -n "runScriptWithResultFile" src/tools/create-{text-frame,image-frame,line,parent-page,rectangle,swatch}.ts
# each file should show exactly one occurrence: inside the sendFn lambda

# 5. Verify legacy pass-through gone (wrapExtendScript called without opts)
grep -n "wrapExtendScript(buildScriptBody" src/tools/create-{text-frame,image-frame,line,parent-page,rectangle,swatch}.ts
# expected: no output
```

---

## 7. Acceptance criteria

All of the following must hold before B9-S2 is considered complete.

1. `npx tsc --noEmit` exits 0.
2. `npm test` passes. Actual count ≥ 942 (verify, do not assume).
3. All five tamper tests (T1–T5) pass for each of the six tools (30 tests total).
4. All existing dispatch tests for the six tools continue to pass (no regression).
5. All B9-S1 schema tests continue to pass (3 × 6 = 18 tests).
6. `grep -c "sendMutateScript"` returns 1 for each of the six source files.
7. No direct `wrapExtendScript(buildScriptBody(...))` call remains in the six handler functions.
8. None of the protected files (`mutate-guard.ts`, `mutate-capability.ts`,
   `compose.ts`, `result-file.ts`, `types.ts`, `server.ts`, `CLAUDE.md`,
   `dist/`) was modified (`git diff --name-only HEAD` shows only 12 files).
9. A local commit is made with the message:
   `fix: add mutate-token track to six object-creation tools (B9-S2)`
   after owner approval.

---

## 8. Review steps

### Unit review (can run in cloud container)
- `npx tsc --noEmit`
- `git diff --stat` — exactly 12 files, no others
- `git diff --check` — no whitespace errors

### Unit test run (requires Mac)
- `npm test` — count, all pass

### Live verification (requires InDesign on Mac — deferred, not a gate for commit)
The following are **not** gates for the S2 commit. They are post-commit checks.

- `npm run test:integration` is **blocked** until CloseToken infrastructure
  is complete (PROJECT_STATE, §2). Do not run it.
- Manual live test (optional, post-commit): call each of the six tools through
  the MCP server with a valid `document_id` and verify the object is created.
  This is a functional check, not a security check. The token enforcement is
  covered by unit tests (T1–T5).

---

## 9. Known gaps — S2 does not close these

### G5 — 15 tools remain ungated
S2 gates 6 of the 23 mutating tools. After S2:
- **Gated (Stage 7C):** `apply_paragraph_style`, `apply_character_style_to_range`,
  `create_text_frame`, `create_image_frame`, `create_line`, `create_parent_page`,
  `create_rectangle`, `create_swatch` (8 tools).
- **Legacy pass-through (G5 open):** the remaining 15 mutating tools, including
  `create_document`, `set_text`, `place_image`, `apply_parent_to_page`, and others.
  These require a separate plan and approval.

### G6 — documentId not verified against InDesign's active document
The token binds `input.document_id` (the value the tool passes), not the document
InDesign actually receives the script on. If the wrong document is frontmost in
InDesign, the script runs on it. This gap is acknowledged in `mutate-capability.ts`
and `mutate-guard.ts` (both say "Full enforcement deferred to B9"). S2 does not
close G6.

### G7 — no enforcement at the send point in result-file.ts
Callers of `runScriptWithResultFile` that do not go through `wrapExtendScript`
bypass the token entirely. Decision D3 deferred this to Stage 7F, which requires
modifying the protected `result-file.ts`. S2 does not touch `result-file.ts` and
does not address G7.

### MutateToken is not a runtime barrier against all bypass paths
`issueMutateToken` is exported. Any module that imports it directly can issue
a token without going through `sendMutateScript`. This is a policy boundary
enforced by code review, not a runtime barrier (same limitation documented in
`mutate-capability.ts`).

---

## 10. Decisions required before implementation

The following must be confirmed before any code is changed.

| # | Question | Default if not answered |
|---|----------|------------------------|
| D-S2-1 | Is approval-in-conversation sufficient as the plan record (as in `769d5d1`), or must this file be committed first? | **Stop; require answer.** |
| D-S2-2 | Confirm the six tools listed in §2 are the complete and final scope of S2. No additional tools are to be added without a new plan. | Stop; require confirmation. |

Both questions are answered by the owner's approval message that authorizes
implementation. This plan file is the written record of the scope and
decision.

---

## 11. What is NOT a decision for this plan

- Whether to gate the remaining 15 tools — separate plan required.
- Whether to fix G6 or G7 — separate plan required, touches protected files.
- `create_document` — separate decision and approval required.
- Integration test infrastructure (CloseToken, D1) — separate plan required.
- Any change to `CLAUDE.md` or the skill file.
