# InDesign MCP — Plan B8 Implementation Plan (Write Safety)

**Status:** Plan only. Version 3.6 is approved in principle as documentation. **Not approved for implementation.** Each stage below starts only after explicit approval of that stage.

**Goal:** Protect the user's documents from the integration tests, and protect existing files from being overwritten by `save_document` and `export_pdf`, without any mechanism that overwrites a file the server does not own.

**Reference spec:** `docs/superpowers/specs/2026-10-13-indesign-mcp-plan-b8-safety-design.md` (section numbers below refer to it).

**Tech stack:** TypeScript 5.9.3, Node 20+, MCP SDK (installed 1.32.1, Git lock 1.29.0), Zod, Vitest 2.1.9. No new runtime dependencies. No dependency changes.

**Branch:** `plan-b8-safety`.

---

## Ground rules for every stage

- Every stage ends with a **stop** for the user's review and approval. No stage starts without approval.
- The maintainer runs every command in Terminal and returns the output. Nothing here assumes Claude can run commands on the user's machine.
- Commit only with approval, and only with `git add <explicit paths>` — never `git add -A` or `git add .`.
- `package-lock.json` and `CLAUDE.md` stay exactly as they are and are excluded from every commit.
- The active `dist/` is not rebuilt until stage 9, after the merge, with separate approval.
- Integration tests never run automatically. They require `INDESIGN_MCP_INTEGRATION=1` and an explicit command.
- Stages 3 and 5 were removed in plan version 3.5; the numbering is kept so references do not change. Eight active stages: 0, 1, 2, 4, 6, 7, 8, 9.

---

## Stage 0 — Preparation (no code)

- **Files:** none.
- **Actions (maintainer):** `node -v`; check the server entry in the Claude Desktop configuration; `ps` for the running server; `git switch -c plan-b8-safety`.
- **Success:** Node 20+; the branch exists; `git status --short` unchanged (`M package-lock.json`, `?? CLAUDE.md`); it is known which `dist/index.js` the host runs.
- **Risks:** no file changes.
- **Stop:** output to Claude; approval for stage 1.

## Stage 1 — Spec and plan documents

- **Files (new):** `docs/superpowers/specs/2026-10-13-indesign-mcp-plan-b8-safety-design.md`, `docs/superpowers/plans/2026-10-13-indesign-mcp-plan-b8.md`.
- **Success:** the content matches plan version 3.6; neither document describes `COPYFILE_EXCL`, `fs.rename` for PDF, `overwrite: true` or any overwrite-approval mechanism as active; `git status` shows only these two files as new (plus the existing `M package-lock.json` and `?? CLAUDE.md`).
- **Tests:** none.
- **Risks:** a mismatch between these documents and the approved plan — checked by the user's review.
- **Stop:** approval of the content, and of a commit if wanted.

## Stage 2 — Write-guard core (Node only)

- **Files:** `src/write-guard.ts` (new), `src/types.ts`, `tests/unit/write-guard.test.ts` (new).
- **What:** path gate and normalization; registry and states (`owned` / `pending` / `uncertain`); fingerprint; suggested name; the PDF publish function operating on a `.part` file already on disk; the INDD name-reservation function; `decideWrite()`, `assertWriteAllowed()` and `sendWriteScript()` (spec §3), with `sendWriteScript` receiving the send function as a parameter. **No InDesign, no tool code, no overwrite-approval mechanism.**
- **Tests (unit only, files in `mkdtemp` directories only):**
  - The normalization spec (§2) — all 9 rules and examples; NFC/NFD; symlink as file name; `/var` vs `/private/var`.
  - Registry state transitions, and a mismatch in each of the five fingerprint fields.
  - The §5 rows that do not depend on InDesign: "write succeeded, stat succeeded"; "write succeeded, recording failed"; "server stopped" (module reset); "file changed outside the server"; "file deleted externally"; "error in the gate itself".
  - **P2–P6** on the publish function, with a `.part` file prepared by the test and mocked filesystem errors for `link`, `unlink` and `lstat`.
  - INDD name reservation: `wx` succeeds; `wx` on a taken name → `EEXIST`; `wx` on a symlink → fails; cleanup only with the same inode and length 0.
  - Path C at gate level: every reason (`not_owned`, `fingerprint_mismatch`, `document_mismatch`, `path_changed`, `uncertain`) returns a refusal, and the gate has no parameter that changes this.
  - **W1–W6 — runtime verification** (with a mock sender that counts calls):
    - **W1** — forged decision (object with the same fields, via `as WriteAllowed`) → `write_not_authorized`, 0 sends.
    - **W2** — decision reused → refused, also when the first send failed.
    - **W3** — decision for document A and path X used with document B, or with path Y (including the same name in NFD) → refused.
    - **W4** — a `save_document` decision used by `export_pdf`, or a save-as decision used for an in-place save → refused.
    - **W5** — file changed between the decision and `assertWriteAllowed`: each of the five fields, replacement, deletion, symlink → `fingerprint_mismatch`, 0 sends.
    - **W6** — the path-A placeholder replaced or given content before sending → refused.
- **Success:** all tests above exist and pass in `npm test`; `npx tsc --noEmit` clean; `git diff --stat` = 3 files; `src/write-guard.ts` imports neither `runScriptWithResultFile` nor `compose`, and does not read `process.env` (scan).
- **Not in this stage (stage 4):** P1, P7, P8, and the §5 rows that involve InDesign.
- **Risks:** tests create and delete files in OS temporary directories only; macOS filesystem behaviour is verified only when the tests run on the user's machine.
- **Stop:** `npm test` and `tsc` output to Claude.

## Stage 3 — removed in plan version 3.5

The user-approval infrastructure left B8 together with the overwrite-approval mechanism. No files, tests or stop.

## Stage 4 — Wiring the two tools

- **Files:** `src/tools/save-document.ts`, `src/tools/export-pdf.ts`, `tests/unit/tools/save-document.test.ts`, `tests/unit/tools/export-pdf.test.ts`.
- **Test type:** unit only, with mocks. They prove the gate and the order of sends, not InDesign behaviour. Live proof is in stage 8 (mapping in spec §7).
- **Moved from stage 2:** **P1** (target exists → `pdf_replace_blocked`, zero sends), **P7** (InDesign timeout → `uncertain`, no `link`, temporary file not deleted), **P8** (existing target with the environment variable and with `overwrite_confirmation_id` → `invalid_args`; without the field → `pdf_replace_blocked`), and the §5 InDesign rows: "timeout talking to InDesign" and "InDesign returned an error or crashed" (INDD and PDF), plus "timeout / export error" from the PDF table.
- **The three INDD paths (spec §2):**
  - **I1** — free path (path A): a placeholder is created, and the script includes the `length === 0` check.
  - **I2** — our path with a matching fingerprint (path B): `fs.open` with `wx` is **not** called; the script checks existence and expected size.
  - **I3** — save-as to an existing unregistered path, or one whose fingerprint changed, or whose record is `pending` / `uncertain` (path C): `name_collision`, zero sends, no placeholder.
  - **I4** — in-place save of a document whose `fullName` is unregistered (path C): one read-only query, then `name_collision`; no save script built or sent; the query body is scanned and contains no `.save(`, `.close(`, `exportFile(`, `insertLabel` or property assignment.
  - **I5** — in-place save of our document (path B): no placeholder; the save script locates the document by `id` and compares `fullName` before saving.
  - **I6** — path C with bypass attempts: `overwrite: true`, `overwrite_confirmation_id`, environment variable `INDESIGN_MCP_ELICITED_OVERWRITE=enabled`, and combinations. Parameters → `invalid_args`; the environment variable → the same `name_collision` as without it. In every case: zero save scripts.
  - **I7** — in-place save of a never-saved document: `io_error`, as today.
  - **I8** — name taken between the gate and `wx` (simulated): `name_collision`, no save.
  - **I9a** — in-place save when the InDesign document was swapped between the query and the save (simulated): the save script detects the `id` or `fullName` mismatch, stops without saving, `uncertain`.
  - **I9b** — in-place save on path B when the file on disk changed between the query and `sendWriteScript` (mocked filesystem): `fingerprint_mismatch`, no save script sent. This test does **not** cover a change after sending (spec §3).
  - **I10** — every write script of both tools goes through `sendWriteScript`: the mock sender receives only requests that passed `assertWriteAllowed`.
  - **I11** — calling a builder directly with a forged `WriteAllowed` (`as`) and sending → `write_not_authorized`, 0 sends.
- **Additional tests:** on every refusal the number of write-script sends is 0; relative path → `invalid_args`; in-place save = two sends in the right order; expected values embedded via `lit()`.
- **Success:** all tests above exist and pass; `npm test` and `npx tsc --noEmit` clean; the save and export builders accept only `WriteAllowed` (compile-time protection); `assertWriteAllowed` runs before every write-script send (I10, I11 — runtime protection); `git diff --stat` = 4 files.
- **Risks:** an intended behaviour change — saves that worked until now will be refused. No effect on the running server, because `dist/` is not rebuilt.
- **Stop:** output to Claude.

## Stage 5 — removed in plan version 3.5

The separate test build, LE and V1 served only the overwrite-approval mechanism and left B8 with it. No files, build or stop.

## Stage 6 — Script classes and integration-test infrastructure

- **Files:** `src/compose.ts`, `tests/unit/compose.test.ts`, `tests/unit/test-infra-policy.test.ts` (new), `tests/integration/helpers.ts`, `tests/integration/global-setup.ts` (new), `vitest.integration.config.ts` (new), `package.json` (the `test:integration` line only).
- **Tests (unit only):**
  - **Extended scan (spec §3, item 4):** the scanner also runs on sample code snippets inside the test file. It must detect `doc["save"]()`, `app.menuActions.itemByName("Save").invoke()`, `File(p).open("w")`, `fs.writeFileSync` inside a tool, and a write builder sent other than through `sendWriteScript`. It must not flag `master.pages[0].remove()`.
  - **Runtime body check (spec §3, item 5):** `wrapExtendScript` with a body containing `.save(` and no decision → throws before sending; with a decision that passed `assertWriteAllowed` → passes.
  - **C3–C9** (spec §7), including runtime enforcement of `test-probe` and manifest-based file cleanup.
- **Success:** `compose` snapshot unchanged; policy test green (0 uses of `scriptClass` outside `compose.ts`); `git diff package.json` = one line; C3–C9 green; the `src` write-point scan (spec §3) green; the existing unit tests of all 29 tools green with the body check active; `npm test` and `tsc` green. Integration tests are not run.
- **Risks:** `compose.ts` serves all 29 tools; the snapshot is the proof that production output did not change. The body check may wrongly refuse an existing tool (false positive); if so — stop and report, without widening the exception list unilaterally.
- **Stop:** output to Claude.

## Stage 7 — Mechanical replacement in 35 files, with full review

- **Files:** 35 `tests/integration/*.int.test.ts` files (all except `get-app-version.int.test.ts`).
- **Before editing — inventory (read-only):** per file, count `createDocumentTool.handler(`, `closeAllDocuments`, and hooks (`beforeAll`, `beforeEach`, `afterEach`, `afterAll`); direct calls to `runScriptWithResultFile` or `wrapExtendScript`; `document_id`; `.close(`; mocks and spies. The inventory is added as a table to this plan file (section "Stage 7 inventory" below) before any edit. Expected total: 77 `createDocumentTool.handler(` calls in 35 files.
- **Edit rules (closed list):** (a) the `./helpers` import line — add `createTestDocument`, `closeTestDocuments`, remove `closeAllDocuments`; (b) remove the `createDocumentTool` import only if it has no other use; (c) `createDocumentTool.handler(` → `createTestDocument(`; (d) `closeAllDocuments()` → `closeTestDocuments()`. No other change — no reordering, whitespace, comments or values.
- **Post-edit review (read-only commands, run by the maintainer):**
  1. `git diff --stat -- tests/integration ':!tests/integration/helpers.ts'` → exactly 35 files.
  2. **Reverse comparison against HEAD:** a short Node script (added to this plan file in stage 7, before any edit, for review) takes `git show HEAD:<file>` and the current file, reverts the two replacements in the current file, strips import lines from both, and compares. Must be identical in all 35 files. Any difference = stop. The script only reads and prints.
  3. **Counts:** `createTestDocument(` per file = `createDocumentTool.handler(` in the inventory (total 77); `closeTestDocuments()` count = former `closeAllDocuments()` count.
  4. **Negative scan in `tests/`:** zero `closeAllDocuments`; zero `createDocumentTool.handler(` outside `helpers.ts`; zero `documents[0]`; zero `.close(` outside the two cleanup functions in `helpers.ts`.
  5. `get-app-version.int.test.ts` unchanged.
  6. `npx tsc --noEmit` — `createTestDocument` returns exactly the handler's envelope type, so all existing assertions compile unchanged.
  7. `npm test` green (integration files are skipped without the variable).
- **Intended behaviour change only:** `createTestDocument` adds read queries and labelling; `closeTestDocuments` closes less — only identified documents. The two files with direct calls (`create-document`, `plan-b4-end-to-end`) are flagged in the inventory; their scripts are `tool`-class queries and pass the guard because only labelled documents are open.
- **Not changed in this stage:** the `rmSync(tmpDir, { recursive: true, force: true })` cleanup lines in existing test files (spec §8, limitation 17; separate follow-up task).
- **Success:** 1–7 pass, and the user reviewed the diff.
- **Risks:** typos — caught by 2, 3 and 6.
- **Stop:** output of 1–7 to Claude.

### Stage 7 inventory

To be filled in stage 7, before any edit (read-only).

## Stage 8 — Live integration and visual tests

- **Files:** `tests/integration/safety.int.test.ts` (new).
- **Order, every run started manually by the user:** L0 → L-R → L1a, L1b → L2 → L3–L6, L3b, L4b, L4c, C1, C2, C10 → L8, L9 → V2, V3.
- **Success:** per the spec §7 tables; at the end of every passing run — zero open documents; the report records the installed SDK version.
- **Risks:** labels, ids and saving over a placeholder are still UNVERIFIED. Any failure stops the sequence; do not continue after a failure.
- **Stop:** after every run, output to Claude.

## Stage 9 — Documentation, commit and merge

- **Files:** `README.md`, `docs/PROJECT_STATE.md` (new behaviour, limitations, correct the tool count 26 → 29).
- **Success:** before every commit, `git diff --cached --name-only` contains only B8 files from the list — never `package-lock.json` or `CLAUDE.md`.
- **After merge only, with separate approval:** close Claude Desktop → `npm run build` → reopen → L7.
- **Risks:** replacing the running server — happens only now, once, by the user's decision.
- **Stop:** end of B8. Afterwards — separate plans for `CLAUDE.md` and the skill, the dependency decision, the existing-test cleanup task (spec §8), and B9.

---

## File list

**19 files with logic changes (8 new, 11 edited)**, plus 35 test files with a mechanical replacement.

| File | Action | Stage | Role |
| --- | --- | --- | --- |
| `docs/superpowers/specs/2026-10-13-indesign-mcp-plan-b8-safety-design.md` | new | 1 | spec |
| `docs/superpowers/plans/2026-10-13-indesign-mcp-plan-b8.md` | new | 1 | implementation plan |
| `src/write-guard.ts` | new | 2 | path gate, ownership registry, decisions and runtime verification, PDF publish, name reservation |
| `src/types.ts` | edit | 2 | `foreign_document_open`; fields `existing_path`, `suggested_path`, `reason` |
| `tests/unit/write-guard.test.ts` | new | 2 | |
| `src/tools/save-document.ts` | edit | 4 | gate, the three paths, path-C refusal |
| `src/tools/export-pdf.ts` | edit | 4 | gate, exclusive publish, replacement blocked |
| `tests/unit/tools/save-document.test.ts` | edit | 4 | |
| `tests/unit/tools/export-pdf.test.ts` | edit | 4 | |
| `src/compose.ts` | edit | 6 | script classes, test-mode guard, runtime body check |
| `tests/unit/compose.test.ts` | edit | 6 | existing snapshot unchanged |
| `tests/unit/test-infra-policy.test.ts` | new | 6 | forbids guard bypass and extra write routes in `src/`; C3–C9 |
| `tests/integration/helpers.ts` | edit | 6 | creation, checks, narrow cleanup, run manifest |
| `tests/integration/global-setup.ts` | new | 6 | pre-check, `runToken`, run directory |
| `vitest.integration.config.ts` | new | 6 | integration-only configuration |
| `package.json` | edit | 6 | `test:integration` line only; no dependency change |
| 35 `tests/integration/*.int.test.ts` | mechanical edit | 7 | function names and imports |
| `tests/integration/safety.int.test.ts` | new | 8 | L-R, L3–L6, L3b, L4b, L4c, C1, C2, C10 |
| `README.md` | edit | 9 | |
| `docs/PROJECT_STATE.md` | edit | 9 | |

**Removed from scope in plan version 3.5:** `src/user-confirmation.ts`, `src/tools/registry.ts`, `src/server.ts`, `tests/unit/user-confirmation.test.ts`, `tests/unit/server-context.test.ts`.

**Not changed in B8:** `package-lock.json` (local change, undecided), `CLAUDE.md`, `src/index.ts`, `src/server.ts`, `src/tools/registry.ts`, `src/transport/*`, `src/script-helpers.ts`, `src/path-utils.ts`, the other 27 tools, `dist/` (until stage 9), all dependencies, and the cleanup code in the 12 existing test files that use recursive `rmSync`. The `indesign-art-director` skill — separate plan.
