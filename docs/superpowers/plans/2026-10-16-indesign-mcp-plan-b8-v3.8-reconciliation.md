# InDesign MCP — Plan B8 v3.8 (Reconciliation and Re-plan)

**Date:** 2026-10-16
**Status:** Documentation only. **Not approved for implementation.** This document changes no code, dependency, `dist/`, `CLAUDE.md` or `package-lock.json`. Every step in §7 starts only after explicit approval of that step. Nothing in §7 or §8 exists in the code today.
**Relation to v3.7:** v3.7 (`docs/superpowers/plans/2026-10-13-indesign-mcp-plan-b8.md` and `docs/superpowers/specs/2026-10-13-indesign-mcp-plan-b8-safety-design.md`) is kept unchanged as the historical baseline. Where v3.8 and v3.7 disagree, v3.8 describes the code as it is; v3.7 still describes the original intent. Section references such as "spec §3" point to the v3.7 spec.
**Verified against:** `main` at `660f03c` (working tree clean except untracked `CLAUDE.md`), 2026-10-16.

## How to read this document

Every claim carries a source: `file:line` (static read of the code at `660f03c`), a commit hash, or a command result. Three evidence levels are used:

| Level | Meaning |
| --- | --- |
| **Ran** | A command was executed on 2026-10-16 and its output was observed. |
| **Read** | Established by reading the code. Not executed. |
| **Planned** | Does not exist. Described only so it can be approved or rejected. |

Nothing marked **Planned** may be reported as existing. No InDesign run has happened for any B8 work: every live behaviour (document ids, labels, saving over a placeholder) is still **UNVERIFIED**.

---

## 1. Implemented and verified

| # | Item | Evidence | Level |
| --- | --- | --- | --- |
| 1.1 | Write guard: path gate, `computeAgentName`, registry, `decideWrite`, `assertWriteAllowed`, `sendWriteScript`, placeholder reservation and cleanup, PDF publish (`.part` + `fs.link`) | `src/write-guard.ts` (`pathGate` :97, `computeAgentName` :253, `decideWrite` :354, `assertWriteAllowed` :504, `sendWriteScript` :610, `reservePlaceholder` :701, `cleanupPlaceholder` :727); commit `ee17a4c` | Read + unit tests (**Ran**) |
| 1.2 | `save_document` and `export_pdf` go through the guard; `.strict()` schemas without any `overwrite` field | `src/tools/save-document.ts`, `src/tools/export-pdf.ts`; commit `63af10f` | Read + unit tests (**Ran**) |
| 1.3 | `WriteCapability`: single-use, bound to the exact body string and to the operation (`save-as`, `in-place-save`, `export-pdf`) | `src/write-capability.ts:35,48`; commit `05e1a00` | Unit tests (**Ran**) |
| 1.4 | `ReadToken`: single-use, bound to `documentId` (or `null`); `sendReadScript` issues it, `wrapExtendScript` consumes it | `src/read-capability.ts:48,75,99`; `src/read-guard.ts:56`; `src/compose.ts:105-113`; commit `660f03c` | Unit tests (**Ran**) |
| 1.5 | F1: `save-as` body check matches `doc.save(File(...))` (InDesign's `Document` has no `saveAs`) | `src/write-guard.ts:585-586`; commit `9b296e1`; tests SA-1..SA-3 | **Ran** |
| 1.6 | F1b: a validation failure in `save_document` path A returns a normal `write_not_authorized` envelope, removes the placeholder only if it is the same empty inode, writes nothing to the registry, and the retry succeeds with a fresh decision | `src/tools/save-document.ts:213-236` (catch at :228); commit `9b296e1`; tests FB-1..FB-4 | **Ran** |
| 1.7 | `closeAllDocuments()` is hard-blocked (always throws) | `tests/integration/helpers.ts:23-28`; commit `05e1a00` | Read + unit test (**Ran**) |

**Test results (Ran, 2026-10-16):** `npm test` — 43 files, **520 passed**, exit 0; `npx tsc --noEmit` — exit 0. The "16 pre-existing infra failures" reported in the message of `63af10f` do not reproduce. `node_modules` was rebuilt with `npm ci --ignore-scripts` on 2026-10-16 and now matches `package-lock.json` (SDK 1.29.0, hono 4.12.16, `@hono/node-server` 1.19.14, express 5.2.1, zod 3.25.76, TypeScript 5.9.3, vitest 2.1.9 — all installed = lock).

**Per-file unit test counts** (`grep` of `it(`/`test(`, Read): `write-guard` 51, `write-capability` 8, `read-capability` 9, `read-guard` 8, `compose` 18, `save-document` 10, `save-document-real-guard` 7, `export-pdf` 8, `list-pages` 13, `list-paragraph-styles` 13, `get-page-state` 10, `get-app-version` 4. Total across the suite: 520 (Ran).

---

## 2. Tool inventory — count and status

**29 tools** (30 files in `src/tools` minus `registry.ts`; 29 `registry.register(` calls in `src/index.ts`). Command results, Ran 2026-10-16.

| Track | Count | Tools | Mechanism |
| --- | --- | --- | --- |
| ReadToken | **4** | `get_app_version`, `get_page_state`, `list_pages`, `list_paragraph_styles` | `sendReadScript` → `wrapExtendScript(body, { _readToken, documentId })` |
| WriteCapability | **2** | `save_document`, `export_pdf` | `sendWriteScript` → `wrapExtendScript(body, { _writeCapability, operation })` |
| Legacy pass-through | **23** | `add_page`, `apply_character_style_to_range`, `apply_paragraph_style`, `apply_parent_to_page`, `create_document`, `create_image_frame`, `create_line`, `create_parent_page`, `create_rectangle`, `create_swatch`, `create_text_frame`, `define_character_style`, `define_paragraph_style`, `duplicate_frame`, `find_replace`, `insert_page_number_marker`, `override_parent_item_on_page`, `place_image`, `set_frame_columns`, `set_frame_inset`, `set_text_in_range`, `set_text`, `thread_text_frames` | `wrapExtendScript(body)` with no options — no token, no capability |

**Correction to a comment in the code.** `src/compose.ts:92` (and the Stage 6 commit message) describe the legacy track as serving "the 30+ read tools". That is wrong. By tool descriptions, **all 23 legacy tools modify the document** (create, set, apply, define, place, duplicate, replace, link). All four real read tools already carry a ReadToken. So the ungated population is the set of document-**mutating** tools, not read tools. (Source: `description:` fields of the 23 files, Read.) The comment itself is not changed by this document.

**Other counts:**
- `activeDocument` is referenced in **27** of the 29 tool files (`grep -l`, Ran), including `save_document`, `export_pdf` and all four read tools. Of the two files that do not reference it, `get_app_version` does not touch documents and `create_document` creates one.
- Documentation drift: `README.md:6` and `docs/PROJECT_STATE.md:13` say **26 tools** and `PROJECT_STATE.md` says 415 unit tests. Both are stale (29 tools, 520 unit tests). The v3.7 spec contains "All 28 tool files in `src/tools` use `wrapExtendScript`; only `registry.ts` … does not" (spec §3, Facts) — the code has 29 tool files using it plus `registry.ts`.
- The two write tools send their **pre-query** (`save-document.ts:123`, `export-pdf.ts:167`) through the legacy `wrapExtendScript(script)`. These are read-only queries, but they are not tokened.

---

## 3. Capability model — what each boundary does and does not do

| Boundary | Guarantees (Read/Ran) | Does **not** guarantee |
| --- | --- | --- |
| **`decideWrite` + `assertWriteAllowed`** (`write-guard.ts:354,504`) | decision is a registered, frozen, single-use object (`usedDecisions` :344, marked at :565); tool, document id, final path and operation must match; fresh `lstat`/fingerprint check before sending | any check after the script is sent (file race, spec §3 "I9") |
| **`WriteCapability`** (`write-capability.ts`) | the script that runs is byte-identical to the one authorized, for the stated operation | that the body is *safe*: it binds the body string, not its meaning. Binding to path/document comes only through the body text |
| **`validateOperationBody`** (`write-guard.ts:583`) | advisory regex: the body contains the expected API for the operation | any semantic proof (`doc["save"]()`, variable dispatch). Documented as advisory in the code |
| **`ReadToken`** (`read-capability.ts`) | single-use; `documentId` equality with what was issued | that the script reads only that document: `documentId: null` means "not bound", and 27 tool files can still reach `activeDocument` |
| **`wrapExtendScript`** (`compose.ts:96-115`) | consumes a capability or token when one is supplied | anything when called with no options: **no body scan exists in `compose.ts`** (`grep` for `.save(`, `exportFile`, `scriptClass` in `compose.ts` returned nothing) |
| **Send point** (`runScriptWithResultFile`, `src/transport/result-file.ts`) | — | any enforcement. A caller that builds a script template by hand and passes it here bypasses every layer above. Documented in `read-guard.ts` header; deferred to "7F" (§7). `result-file.ts` is treated as a protected file (`read-guard.ts:18`) |

Consequences that are easy to miss:
1. **Write enforcement is by convention for everything except the two write tools.** Any tool (present or future) calling `wrapExtendScript(body)` with no options can contain `.save(` or `exportFile(` and nothing stops it. The static scan and runtime body check that v3.7 specified (spec §3 items 4–5) **do not exist** — no `test-infra-policy.test.ts`, no body check in `compose.ts`.
2. `issueWriteCapability` and `issueReadToken` are exported; calling them directly bypasses the guards. This is a policy boundary enforced by review and tests, stated in both module headers.
3. `foreign_document_open` exists in `ErrorKind` (`src/types.ts`) but no code returns it.

---

## 4. Save paths — Path A / B / C

| Path | Meaning (spec §2) | State in code | Source |
| --- | --- | --- | --- |
| **A** — new INDD at a free name | placeholder reserved with `wx`; save; record `owned` | Implemented. Placeholder reserved at `save-document.ts:191`; send at :213 with the try/catch added by F1b (catch at :228) | Read + tests |
| **B** — existing INDD owned by this session | fingerprint verified, then save | Implemented (decision + `assertWriteAllowed` fingerprint check). **No try/catch around the send** (`save-document.ts:266`) | Read |
| **C** — existing INDD not owned | absolute refusal, `name_collision` + `suggested_path` | Implemented in `decideWrite`; `.strict()` schema rejects `overwrite` | Read + tests |
| PDF to free path | `.part` + `fs.link` publish | Implemented in `export-pdf.ts` + `publishPdfPart` | Read + tests |
| PDF to existing path | `pdf_replace_blocked` | Implemented | Read + tests |

**In-place save detail:** both tools call the builder with `decision.finalPath`, so an in-place save sends `doc.save(File(<fullName>))`. The `else` branch of `buildSaveScript` (`!doc.saved` check and `doc.save()`) is therefore unreachable (`save-document.ts:80-90`, Read).

---

## 5. Known gaps

IDs are stable references for §7 and §8.

| ID | Gap | Source | Effect | Planned step |
| --- | --- | --- | --- | --- |
| **G1** | The write scripts do **not** perform the in-script checks the spec requires: `id` + `fullName` comparison (I9a), `File(path).exists` and expected size (path B), `length === 0` (path A). `buildSaveScript` only finds the document by id and saves | `save-document.ts:73-99` vs spec §2 "three INDD paths", §3 "I9" | The TOCTOU window is wider than the spec describes; a swapped active document is not detected inside InDesign | **F2** |
| **G2** | No try/catch around `sendWriteScript` in `save_document` path B (:266) and in `export_pdf` (:267) | Read | An exception thrown before dispatch surfaces as a raw rejection instead of a tool error envelope. Not exercised by any test | **F2** |
| **G3** | `computeAgentName` exists but no tool calls it; there is no working-copy or checkpoint option; tests I2, I6, I9a, I12, I13 of the v3.7 plan do not exist | `grep -rn computeAgentName src tests`: no use in `src/` outside its definition in `write-guard.ts`; called only from `tests/unit/write-guard.test.ts` (Ran) | `_cod` naming is not applied by the tools | decision D6 (§8) |
| **G4** | Integration infrastructure is absent: no `global-setup.ts`, `runToken`, `createTestDocument`, `closeTestDocuments`, `vitest.integration.config.ts`, `test-infra-policy.test.ts`, `safety.int.test.ts` | files do not exist (Ran `ls`) | `closeAllDocuments` throws, and 35 of the 36 `tests/integration/*.int.test.ts` files call it → the integration suite cannot run (safe, by design) | §7 steps 4–5 |
| **G5** | 23 document-mutating tools are ungated | §2 | any foreign-document or wrong-document edit is prevented only by convention | **7C** (D1, D2) |
| **G6** | `activeDocument` fallback in 27 tool files | `grep -l` | edits may land on the frontmost document | B9 (out of B8) |
| **G7** | No enforcement at the send point | §3 | hand-built script templates bypass all guards | **7F** (D3) |
| **G8** | Documentation drift: README/PROJECT_STATE (26 tools, 415 tests); v3.7 spec dependency table ("installed 1.32.1", "working-tree lock differs"), limitation 13, Stage 0 expectations (`M package-lock.json`, branch `plan-b8-safety`) | §2, §1 | readers get a wrong picture | docs step (Stage 9) |
| **G9** | `src/compose.ts:92` comment says "30+ read tools" | §2 | misleading; the ungated tools are mutators | documentation/comment fix, with the step that touches `compose.ts` |
| **G10** | `cleanupPlaceholder` deletes with `fs.unlink(...).catch(...)` without awaiting | `write-guard.ts:727-736` | the file may still exist when the tool returns. Tests use `vi.waitFor` | **F2** (decide) |
| **G11** | `write-capability.test.ts` uses a non-existent `doc.saveAs(...)` as its example body | `tests/unit/write-capability.test.ts:28,44,71,103` | harmless (these tests do not pass through `validateOperationBody`) but misleading | with F2 (optional) |
| **G12** | Active `dist/` predates B8: `grep -c decideWrite dist/tools/save-document.js` = 0 | Ran | the running server has **none** of the B8 protections; they take effect only after a build | Stage 9 (separate approval) |

**Race that remains by design (spec §3, limitation 2):** after the script is dispatched, another process can replace the file at the same path; neither ExtendScript nor macOS offers a lock that closes this window. F2 narrows it; it does not close it.

---

## 6. Step mapping — v3.7 plan vs. what happened

The v3.7 stage numbers and the commit titles diverged. This table is the single mapping.

| v3.7 plan stage | v3.7 content | What actually happened | v3.8 step |
| --- | --- | --- | --- |
| 0 | preparation | no `plan-b8-safety` branch; work is on `main` (7 commits ahead of `origin/main`, not pushed) | — (decision D5) |
| 1 | spec + plan docs | `6fad4f5` (v3.6), `e362c71` (v3.7) | done |
| 2 | write-guard core | `ee17a4c` | done |
| 4 | wire the two tools | `63af10f` (+ F1/F1b fixes in `9b296e1`) | done; gaps G1–G3 remain |
| 6 (plan) | script classes, test-mode guard, body check, integration helpers | **not done.** Commit `05e1a00` is titled "Stage 6" but contains **WriteCapability**, which v3.7 does not describe | **new:** capability layer documented here (§3) |
| — (not in v3.7) | ReadToken | `660f03c` ("Stage 7B") | done |
| 7 (plan) | mechanical rename in 35 integration files | not done; `closeAllDocuments` is blocked instead | §7 step 5 |
| 8 | live tests | not done; nothing ran against InDesign | §7 step 6 |
| 9 | docs, merge, build | not done | §7 step 8 |

---

## 7. Planned steps (nothing below exists yet)

Order reflects dependencies. Each step: separate approval, a focused plan before any edit, its own commit, no push, no `dist/` change.

| Step | Scope (to be fixed in its own plan) | Depends on | Stop conditions |
| --- | --- | --- | --- |
| **1. v3.8 documents** | This document | — | user approval of this document |
| **2. F2** | In-script checks for save paths (G1); try/catch for path B and export (G2); decision on `cleanupPlaceholder` awaiting (G10); failure, TOCTOU-simulation and safe-cleanup tests | F1 (done). Independent of D1/D2 | any change needed in `export-pdf`/`sendWriteScript` beyond the approved plan → stop and ask |
| **3. 7C** | Gating of the 23 mutating tools (G5), shape set by D1 and D2 | step 2; D1, D2 decided | not started until F2 passes and the 7C scope is approved separately |
| **4. CloseToken + integration infrastructure** | `global-setup`, `runToken`, `createTestDocument`/`closeTestDocuments`, narrow cleanup (spec §1) — shape set by D1 | D1; 7C scope (create_document is a legacy tool) | no live run before the pre-check (zero open documents) exists |
| **5. Mechanical rename in 35 files** | spec plan Stage 7, with the reverse-comparison script | step 4 | any difference in the reverse comparison → stop |
| **6. Live tests (spec §7)** | L0, L-R, L3…; only on documents the test created; user runs each | steps 2, 4, 5 | any failure stops the sequence |
| **7. 7F** | enforcement at the send point | D3 (touches protected `result-file.ts`) | explicit approval to modify `result-file.ts` |
| **8. Docs, merge, build** | README/PROJECT_STATE corrections (G8), `compose.ts` comment (G9), then build | all above | build only with separate approval (G12) |

### F2 — completion criteria

F2 is complete only when **all** of the following hold. They are acceptance criteria, not a description of existing behaviour; none is met today. Evidence for each is a test (unit, mocked InDesign transport, `mkdtemp` directories only) or a command result reported with its exit code.

| # | Criterion | Gap | How it is shown |
| --- | --- | --- | --- |
| F2-1 | The generated save script, before saving, locates the document by `id` and compares `fullName` with the expected value; on mismatch it throws before any save and the tool returns a normal error envelope | G1 (I9a) | test on the real script body (asserts the checks appear before `.save(`) and a simulated mismatch result |
| F2-2 | Path B script additionally checks `File(path).exists` and the expected size; path A script checks `File(path).length === 0`; on failure it stops without saving | G1 | body assertions (checks precede `.save(`); simulated failure results |
| F2-3 | An exception thrown by `sendWriteScript` before dispatch in `save_document` path B and in `export_pdf` returns a standard tool error envelope (no raw rejection). Behaviour of successful paths is unchanged | G2 | tests with `sendWriteScript` forced to throw, for each of the two tools |
| F2-4 | **TOCTOU (Node side):** if the target file is replaced or modified **between the decision and the send** — each fingerprint field (`dev`, `ino`, `size`, `mtimeMs`, `ctimeMs`), replacement by another file, deletion, replacement by a symlink — the operation fails safely: `fingerprint_mismatch`/refusal, **zero write scripts sent**, the file is untouched | G1 | tests that mutate the file after `decideWrite` and before `sendWriteScript`, using the real `write-guard` |
| F2-5 | **TOCTOU (document side):** a swapped or closed InDesign document between the pre-query and the save is detected by the script's `id`/`fullName` check (F2-1) and ends in a safe failure with no save | G1 | simulated script result; stated limit below |
| F2-6 | **Safe cleanup:** a placeholder (path A) or `.part` file is deleted only if this operation can prove ownership — regular file, same inode recorded by this operation, and (placeholder) length 0. A file that was replaced, gained content, changed inode, or became a symlink is **not** deleted and is reported in the error | G2, G10 | tests for each of: replaced file, content added, different inode, symlink; assert the file still exists with its content |
| F2-7 | **Registry on failure:** no failure path in F2 leaves a record that grants ownership. After a refused or failed write the registry holds no `owned` record for that key created by the failed attempt; a pre-existing record is not upgraded; a state set to `pending` before a send that fails or throws ends as `uncertain` (never `owned`) | G1, G2 | tests that read `registryGet(key)` after each failure scenario in F2-3, F2-4, F2-6 |
| F2-8 | The decision stays single-use after every F2 failure; a retry needs a fresh `decideWrite` and succeeds when the cause is gone | G1, G2 | retry test per failure class |
| F2-9 | Decision on `cleanupPlaceholder` (awaited vs fire-and-forget, G10) is recorded in the F2 plan and covered by a test of the chosen behaviour | G10 | test |
| F2-10 | No regression: `npm test` (all unit tests) passes, `npx tsc --noEmit` is clean, `git diff --check` is clean, and the previously committed tests (SA-1..SA-3, FB-1..FB-4, Stage 7B) still pass | — | command output with exit codes |
| F2-11 | Scope respected: `dist/`, `package.json`, `package-lock.json`, `CLAUDE.md` and `src/transport/result-file.ts` unchanged; **`sendWriteScript` and any `export_pdf` behaviour beyond F2-3 are changed only with separate approval**; no live InDesign run; no commit without approval | — | `git status --short` and `git diff --stat` |

**Limits that F2 does not remove (must be stated in the F2 report, not claimed as solved):** a replacement of the file by another process **after** the script is dispatched (spec §3 "I9", limitation 2) is narrowed, not closed; the in-script size check does not detect a same-size replacement; the in-script checks are verified against a mocked transport only, so InDesign's real behaviour stays **UNVERIFIED** until the live tests (§7 step 6).

**Why this order.** F2 first because it closes the largest *real* gap on the existing write path and does not depend on any open decision; widening capabilities to more tools before the write path is sound would extend trust on a weaker base. 7C after, because its shape depends on D1 and D2. Integration infrastructure after 7C because `create_document` (a legacy tool) is what test helpers call.

---

## 8. Decisions that still need approval

Both D1 and D2 are open. v3.8 does **not** assume `scriptClass` stays or that `mutate-*` modules are required. Neither `mutate-capability.ts` nor `mutate-guard.ts` exists (Ran `ls`).

### D1 — What happens to `scriptClass` and the test-mode foreign-document guard

v3.7 intent (spec §1): `wrapExtendScript` takes `opts.scriptClass` (`tool` | `test-probe` | `test-cleanup`); when `INDESIGN_MCP_TEST_RUN_TOKEN` is set, `tool` scripts refuse to run if a document without the run label is open. Nothing of this exists.

| Option | Description | Pros | Cons / implications |
| --- | --- | --- | --- |
| **D1-a. Keep as specified** | add `scriptClass` and the env-var guard to `compose.ts` | matches the approved spec and live tests L3b/C1/C10; guard runs *inside* tool scripts, so a foreign document opened mid-run stops the next tool | a fourth track in `wrapExtendScript` next to write/read/legacy; production behaviour depends on an environment variable (spec: output must stay byte-identical when unset, enforced by snapshot); two overlapping mechanisms (class + capabilities) |
| **D1-b. Replace with capability-style tokens** | test helpers receive their own issuer (probe/cleanup/close tokens) in the same style as `ReadToken`/`WriteCapability` | one mechanism; consistent audit story | needs a new spec section and new tests; `issue*` functions stay exported (policy boundary); live tests that rely on class semantics (L3b, C2, C10) must be redefined |
| **D1-c. Drop the in-`src` guard; test-side infrastructure only** | pre-check for zero documents, `createTestDocument`, narrow cleanup by id + label, no change to `compose.ts` | smallest change to production code | no runtime protection against a document opened mid-run before a tool body; L3b cannot be satisfied as written; spec failure row "document opened during a test" changes from "stopped" to "may be edited" |

### D2 — Are `mutate-*` modules required for the 23 mutating tools (7C)

Fact: the 23 legacy tools are the mutators (§2). A read-token analogue exists (`read-capability`/`read-guard`); a mutating analogue does not.

| Option | Description | Pros | Cons / implications |
| --- | --- | --- | --- |
| **D2-a. New `mutate-capability.ts` + `mutate-guard.ts`** | token bound to `documentId` (and tool name), consumed in `wrapExtendScript`; 23 tools edited mechanically | symmetry with the read track; makes document binding explicit | 23 tool files + tests change; `documentId: null` (the `activeDocument` case) stays unbound unless `document_id` becomes required, which is B9's scope; two near-identical modules; the `compose.ts` option union grows |
| **D2-b. Reuse `write-capability` with a new `WriteOperation` kind** | add e.g. `"mutate"` | no new module | `assertWriteAllowed`/`decideWrite` are path- and fingerprint-oriented and do not fit mutators; dilutes the meaning of "write" (disk) |
| **D2-c. Do not gate mutators in B8** | add a body scan in `compose.ts` (the write patterns of spec §3) and rely on CloseToken infrastructure; document-binding waits for B9 | smallest scope; closes the "any tool can call `.save(`" hole (§3, consequence 1) | the 23 tools stay token-free; `activeDocument` edits remain possible (G6); the body scan is pattern-based (spec limitation 16) |
| **D2-d. Defer all of 7C to B9** | B9 makes `document_id` required, then tokens can be bound meaningfully | binds tokens to something real instead of `null` | B8 ends with 23 ungated tools; the "legacy pass-through" remains until B9 |

D2 depends partly on D1 (a body scan in `compose.ts` and `scriptClass` both live in `wrapExtendScript`).

### Other open decisions

| ID | Decision | Notes |
| --- | --- | --- |
| **D3** | May 7F modify `src/transport/result-file.ts`? (Treated as protected: `src/read-guard.ts:18` calls it a protected file, and the owner has instructed that it not be changed. `CLAUDE.md` itself does not list it.) | Without it, the send point stays unenforced (G7). Alternative: a wrapper outside `result-file.ts`, which changes every caller |
| **D4** | Push the 7 local commits to `origin/main`? | No remote backup exists for B8 work. Requires explicit approval |
| **D5** | Branch strategy: v3.7 expected `plan-b8-safety`; all work is on `main` | Affects how step commits are reviewed/merged |
| **D6** | Wire `computeAgentName` into `save_document` (working copy, checkpoint flag) now, later, or never within B8? | Closes G3. v3.7 spec §2 and live tests L3-wc/L3-vs depend on it |
| **D7** | When the legacy pass-through is retired (spec/plan: "Stage 7 will replace this with `throw new Error("missing_token: ...")`") | Only possible after D2 is implemented for all 23 tools |

---

## 9. What the v3.8 documents change and do not change

- **Changes:** this file is new. v3.7 documents are untouched.
- **Does not change:** any source file, test, `dist/`, `package.json`, `package-lock.json`, `CLAUDE.md`, `README.md`, `docs/PROJECT_STATE.md`.
- **Corrections to v3.7 text** (G8, G9) are listed, not applied; they are applied in the documentation step after the code settles.
- **v3.7 claims that remain valid:** overwrite policy (no mechanism; absolute refusal on path C; existing PDF never replaced), `_cod` as naming convention only, limitations 1, 2, 15, 16, 17 as stated.

## 10. Verification log (2026-10-16)

| Check | Command (read-only except tests) | Result |
| --- | --- | --- |
| Commits and separation | `git show --stat 9b296e1 660f03c`, `comm` of file lists | 4 and 13 files; 0 shared |
| Working tree | `git status --short`, `git diff HEAD --quiet` | only `?? CLAUDE.md`; tracked tree clean |
| Unit tests | `npm test` | 43 files, 520 passed, exit 0 |
| Typecheck | `npx tsc --noEmit` | exit 0 |
| Tool count | `ls src/tools`, `grep -c "registry.register(" src/index.ts` | 30 files − `registry.ts` = 29; 29 registrations |
| Tracks | `grep` for `sendReadScript` / `sendWriteScript` per tool file | 4 / 2 / 23 |
| `activeDocument` | `grep -l activeDocument src/tools/*.ts` | 27 files |
| `mutate-*` modules | `ls src/mutate-capability.ts src/mutate-guard.ts` | not found |
| `scriptClass` / body scan | `grep scriptClass`, `grep` write patterns in `compose.ts` | none |
| Integration infrastructure | `ls` of the v3.7 file list | absent; `closeAllDocuments` in 35 of 36 integration files |
| `dist/` | `grep -c decideWrite dist/tools/save-document.js` | 0 |
| Dependencies | `node -p require('./node_modules/<pkg>/package.json').version` vs lock | all equal |
| Live InDesign | — | **not run** |
