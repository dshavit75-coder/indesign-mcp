# InDesign MCP — Plan B8: what remains of F2 (planning document)

**Status: PLANNED. Nothing in this document is approved for implementation and nothing in it exists yet.**
Approving this document is not approval to implement R1, R2 or R3; each step needs its own approval, its own commit, and no push.

Reference: `main` at `711b2f1` (19 commits ahead of `origin/main`, not pushed), 2026-10-17. Source and `dist/` are unchanged since `0d7548f` (`git diff --stat 0d7548f HEAD -- src dist` is empty).
Evidence levels as in v3.8: **Read** (read in code), **Ran** (command executed), **Assumption** (not yet verified), **Decision** (needs the owner). No InDesign run exists for any of this: real InDesign behaviour is UNVERIFIED.

Relationship to other documents: the F2 acceptance criteria F2-1 … F2-11 stay exactly as written in `docs/superpowers/plans/2026-10-16-indesign-mcp-plan-b8-v3.8-reconciliation.md` §7. This document does not rewrite them; it plans only the part that is still open.

## 1. Consistency with decision D2-d

7C (gating of the 23 mutating tools) is **deferred to B9** (decision D2-d, `711b2f1`). Nothing here returns it to B8. **G5 stays open on purpose: the 23 mutating tools have no enforcement that binds an edit to a document, and nothing in this plan changes that or claims otherwise.** This plan concerns only the write path of `save_document` and `export_pdf`.

## 2. What is already done and what is open (Read, against the v3.8 document and the code)

| Criterion | State at `711b2f1` |
| --- | --- |
| F2-1, F2-2 (in-script checks, `save_document`) | implemented; verified against a `vm` sandbox only. `export_pdf` has none (G1, outside F2) |
| F2-3 (exception → error envelope) | `save_document` met; **`export_pdf` partly met** (an unrecognised exception is rethrown unchanged) |
| F2-4 (TOCTOU, Node side) | implemented |
| F2-5 (TOCTOU, document side) | implemented against a mocked transport; real InDesign UNVERIFIED |
| F2-6 (cleanup) | placeholder (path A) implemented; **`.part`: tool side implemented, ownership not proven, `publishPdfPart` removes the temporary name by path (G16)** |
| F2-7 (registry after failure) | `save_document` covered in the listed interleavings; **`export_pdf` failure paths not asserted at tool level**; a late write after a timeout is detected, not prevented (G14) |
| F2-8, F2-9 | implemented |
| F2-10, F2-11 | gates for every step, not tasks |

Naming note: the documents call the save paths A / B / C (C = PDF); in the code `savePath` is `"A" | "B" | "pdf"` (`write-guard.ts:336`). This is a naming difference only and is not changed here.

## 3. Facts verified in the code (Read)

1. `publishPdfPart` (`write-guard.ts:778-829`) is called only from `export-pdf.ts:424` and from three tests in `write-guard.test.ts`.
2. It does `lstatSync(partPath)`, `fs.link(partPath, finalPath)`, then `fs.unlink(partPath)` **by path** without inode verification; an unlink failure is swallowed (lines 805-809).
3. It then writes the registry record `owned` with `registry.set` **without checking that the record it saw is still the current one** (lines 813-826).
4. For a PDF, `sendWriteScript` ends with `markUncertain()`: after an explicit success the target (`finalPath`) does not exist yet, because InDesign wrote the `.part`, so `lstatSync(finalPath)` fails (lines 708-718). So the record present when `publishPdfPart` starts is the `uncertain` one created there.
5. Between `lstatSync(partPath)` and `fs.link` nothing protects the path: `link` publishes whatever the path refers to at that moment.
6. `publishPdfPart` returns `reason: "uncertain"` for every failure; `export-pdf.ts` recognises EEXIST by the message prefix `final PDF path was taken during export:` (G17).
7. `RegistryRecord` has exactly four fields: `state`, `documentId`, `tool`, `fingerprint` (`write-guard.ts:57-62`). **There is no operation id.** For a PDF the pending record carries the zero fingerprint (`decision.expectedFingerprint ?? {0,0,0,0,0}`, line 675), so an `uncertain` PDF record is indistinguishable from any other `uncertain` record with the same document and tool.
8. `sendWriteScript` returns `{ ok: true, result }` and does **not** return the record it installed, nor any token for it (lines 700-722); `markUncertain` creates a new record object each time it is called (line 679).
9. In `src/`, the registry is written at `write-guard.ts:677` (pending), `:680` (uncertain), `:711` (owned, in `sendWriteScript`), `:813` and `:820` (in `publishPdfPart`). It is never deleted from outside tests (`registryReset`). `registrySet` is exported and imported by `save-document.ts:15`, which does not call it (only the import line matches).
10. `decideWrite` consults the registry (line 414) only on the branch where the target file already exists. Whether a second write to the same registry key started between the end of a first `export_pdf` send and its `publishPdfPart` would be refused is **not verified** (Assumption).
11. **Readers of the registry (Read, current code, within the scope searched).** A search of `src/*.ts` and `src/tools/*.ts` for `registry.get` and `registryGet` finds `registry.get` in `write-guard.ts` only at line 414 (the `.indd` branch of `decideWrite`) and at line 678 (`stillPending`), and the export `registryGet` at lines 72-73. A PDF request does not reach line 414: the PDF branch (lines 374-397) returns before it. `src/server.ts:36` reads a different registry (the tools'). So no reader of the `owned` record of a PDF key was found **in the code and the paths examined**; this is a finding about that scope only and says nothing about code not searched (for example tests, which use `registryGet`) or about any change made later.

## 4. New findings G19 and G20 (to be added to the v3.8 gap list when the documentation is next updated)

**G19. `publishPdfPart` writes the registry record `owned` without a compare.** This is the same kind of blind registry write that `b8950fb` removed from `save_document`. If the record was replaced or removed between the end of the send and `publishPdfPart`, it is overwritten by `owned`. **Whether this can happen in practice for `export_pdf` is an Assumption** (there is no lock shared with `save_document`, G13, and no test reproduces it). Handled in step R2, with the limits in R2's "Identity of the record": a change **before** `publishPdfPart` is entered and a change **during** it are two different windows, and comparing against a record read at entry covers only the second.

**G20. `sendWriteScript` records `owned` for a target created by a competitor.** After an explicit send success, `sendWriteScript` takes `lstat(finalPath)` and records `owned` with that file's fingerprint (`write-guard.ts:707-716`). For `export_pdf` the export is written to a temporary `.part`, so `finalPath` normally does not exist at that point and the record becomes `uncertain`. If another process creates `finalPath` while the export runs, `lstat` succeeds and the record becomes `owned` for **the competitor's file**, before `publishPdfPart` reports EEXIST; the tool still returns `pdf_replace_blocked`. **Evidence (Ran, in a scratch copy, not a repository test):** the real guard on real files gave `result=pdf_replace_blocked` and a record `owned` with the fingerprint of a 10-byte `"COMPETITOR"` file. The R1 test commit `0dbe425` deliberately does **not** cover this case. **Effect:** No practical effect was identified in the current decision paths examined (§3, fact 11); the registry nevertheless claims ownership of a file the tool did not create. **Separate from G19** (an unguarded `owned` write inside `publishPdfPart`). **Not fixed here, open:** a fix touches `sendWriteScript`, which is not approved; a separate plan and approval are needed. **This does not change decision D2-d:** G5 (the 23 mutating tools are not gated) stays open until B9. Nothing here was verified against a real InDesign.

## 5. Steps

Each step: a separate approval, a focused plan before any edit, its own commit, no push, no `dist/` change, no change to `sendWriteScript`.

### R1 — tool-level registry tests for `export_pdf` (tests only)
- **Closes:** the "not asserted at tool level" part of F2-7(d).
- **Change:** `tests/unit/tools/export-pdf.test.ts` only.
- **Content:** with the real guard on real files in `mkdtemp`, one test per failure path of `export_pdf` (empty / absent / non-regular `.part`, a non-EEXIST link failure, EEXIST, an exception after dispatch) asserting that the registry record is **not** `owned`; and that it is `owned` only after a successful publish (existing PX13).
- **Acceptance:** each new test fails on a scratch copy in which the record is written `owned` earlier (sensitivity check, scratchpad only).
- **Must not change:** every file under `src/`.
- **R1-specific stop condition:** R1 is tests only. The tests for an empty, absent or non-regular `.part` (and every other R1 path) must pass against the **current** code. If one of them exposes that a required behaviour is **not implemented** (it fails for a reason other than a mistake in the test), **no code is changed within R1**: stop, report the failing test and the missing behaviour, and ask for a separate approval.

### R2 — `publishPdfPart` only: inode-verified removal and a guarded registry write (G16, G19)
- **Closes:** G16 partly; G19 only to the extent allowed by the identity available (see below).
- **Files approved for R2:** `src/write-guard.ts` (`publishPdfPart` only), `tests/unit/write-guard.test.ts`, `tests/unit/tools/export-pdf.test.ts`. **`src/tools/export-pdf.ts` and `sendWriteScript` are not approved for R2.**

**Removal of the temporary name (G16) — design, Assumption until its own plan:** after a successful `link`, both names refer to the same inode. Remove `partPath` only if `lstat(partPath)` still reports the same `dev`/`ino` as the published file; otherwise leave it in place. This narrows the risk; it does not close the window between `lstat` and `unlink` (Node has no `unlinkat`).

**Identity of the record (G19) — what is and is not established**
- *Two different windows.* (A) The record is changed **before** `publishPdfPart` is entered: after `sendWriteScript` has installed the `uncertain` record and returned, and while the tool inspects the `.part` (every `await` in that stretch). (B) The record is changed **during** `publishPdfPart`: across its own `await`s (`fs.link`, `fs.unlink`).
- *A record read at entry is not enough.* Capturing `registry.get(key)` at entry and comparing it just before the write detects (B) only. It cannot detect (A): at entry the record is already the foreign one, so the comparison passes and it would be overwritten. **This plan does not claim that the entry comparison is sufficient.**
- *What binds a record to the original write today: nothing.* There is no operation id (fact 7), the zero fingerprint is shared by every pending PDF record (fact 7), and `sendWriteScript` hands the caller neither the record nor a token (fact 8). Identity of "this record belongs to this export" therefore cannot be proven inside the files approved for R2.
- *Option O-c — the only option limited to R2, subject to a separate approval of the implementation (decision D-R2-1):* **O-c does not bind the record to the original write operation, and window A stays open.** It can only do the following inside the approved files: at entry, require that the record exists and has the expected shape (`state "uncertain"`, `tool "export_pdf"`, the same `documentId`, zero fingerprint) and keep that exact object; **as the last step, after all `await`s, in one synchronous block with no `await` between the compare and the write**, write only if `registry.get(key)` is still that same object (identity, not shape). **Detected:** (B) removal, or replacement by any other object, during `publishPdfPart`; and, at entry, a missing record or a record of a different shape (the part of window A where the foreign record differs in shape). **Not detected:** window A when the foreign record has the same shape, because it is then accepted as the entry record. **Residual risk, stated and not claimed solved: window A stays open** — a same-shape record installed in window A is accepted as the entry record, and nothing in O-c links the record to the original write.
- *What would close (A) — outside the scope of this plan; each needs its own plan and its own approval:*
  - **O-a:** `sendWriteScript` returns the record reference or an opaque operation token, and the tool passes it to `publishPdfPart`. Changes `sendWriteScript`'s return type, `export-pdf.ts` and `publishPdfPart`'s signature.
  - **O-b:** `RegistryRecord` gains an operation id set by `sendWriteScript` and carried by the decision. Changes the record type, the decision type and `sendWriteScript`.
  - Either needs a separate approval and its own plan, and touches files or functions that are not approved. **R2 does not expand to them.** Until one of them is planned and approved separately, G19 stays **partly open** (window A), and R2 must not be presented as full protection against overwriting a foreign record.

**Registry state when the publish succeeded but a later step failed or disagrees (policy)**
The file is published once `link` succeeds; that is a fact and is reported as such. Whether the *operation's state* is certain is a separate question. **Every registry write R2 makes — `owned` or `uncertain` — passes the same identity guard (the last step, the same object, one synchronous block). Leaving the entry record, which is already `uncertain`, untouched is always allowed and is the conservative default.**

| What happened after a successful `link` | Registry record | `partPath` | What may be reported |
| --- | --- | --- | --- |
| every post-link step verified (final stat-able and regular, `partPath` removed, record guard passed) | `owned`, fingerprint of the final file | removed | published |
| `unlink` of `partPath` failed, or `lstat`/inode check failed | **`uncertain`** (the entry record is left as it is; a rewrite with the final file's fingerprint only under the same identity guard) | left in place | published; the temporary name is still present, observed state only, no claimed cause |
| `partPath` now refers to a different inode | **`uncertain`** | left untouched (never removed) | published; the temporary name now refers to another file |
| the final file cannot be stat'ed after `link` | **`uncertain`**, zero fingerprint (as today) | as observed | published, with the state unknown |
| the record guard fails (removed, other shape, or replaced during the window B) | the registry is **not** written; whatever is there stays | as observed | published; the registry was left untouched because the record had changed |

`owned` is recorded **only** when every post-link step is verified; any anomaly keeps `uncertain`, so success is never presented as certain when the state is not. Cost of `uncertain` for a PDF: low, because an existing PDF is never replaced (`pdf_replace_blocked`), so the final path is blocked either way. **What may already reach the user, without any change to `export-pdf.ts` (Read, `export-pdf.ts:449-460`):** after a successful publish the tool itself inspects `partPath` and, if something is there, adds a `warnings` entry (`Published. Observed after publishing: …`). So a leftover temporary name, or another file at that path, **may already be reported** as an observed state; whether each case is reported as intended is to be checked by tests, not assumed. **What does not reach the caller:** the registry state (`owned`, `uncertain`, or left untouched) — `publishPdfPart` returns `{ ok: true }` with no fields. **Open decision D-R2-2 is narrowed to exactly that:** whether the registry state after a publish should be reported to the caller. This plan does **not** claim that every registry state is reported to the user, and it does not change `export-pdf.ts`; without D-R2-2 the registry state is recorded but not reported, and R2's report must say so.

- **Acceptance (each a real test, files in `mkdtemp`):**
  1. the removed file is the same inode that was published;
  2. `partPath` replaced after the publish: the replacement stays in place and the record is `uncertain`;
  3a. the record removed or replaced **during** `publishPdfPart` (injected through a `link`/`unlink` hook): it is not overwritten with `owned`;
  3b. the record replaced **before** entry by one of a **different shape**: no write; replaced by one of the **same shape**: a **characterization test** that pins this documented limitation (it must not be read as proof of protection);
  4. `unlink` failure, inode-check failure and unreadable final file: the record is `uncertain` per the table, never `owned`;
  5. the ordinary successful publish still removes the temporary name and records `owned` (PX13 unchanged in meaning).
- **Not achieved (must be in R2's report):** the `lstat`→`unlink` window remains; the removed name is proven to be the published file, **not** that InDesign created the `.part` (ownership stays unproven); window A stays open without O-a or O-b; real InDesign behaviour stays UNVERIFIED.
- **Assumption verified in R2:** `fs.link` yields two names with one inode on the owner's file system, with real files in the tests.
- **Must not change:** `sendWriteScript`, `dist/`, `result-file.ts`, `package*.json`, `CLAUDE.md`, `src/tools/export-pdf.ts`.
- **R2-specific stop condition:** stop and ask for a separate approval if (a) `uncertain` cannot be kept without overwriting a foreign record (that is, any write would replace a record that is not the entry object), or (b) implementing the policy requires a file or an API outside the approved scope (`sendWriteScript`, `src/tools/export-pdf.ts`, the record type, the decision type, or a change of the `publishPdfPart` return shape, which belongs to R3). No code is widened to get around either case.

### R3 — a structured cause instead of the message-prefix contract (G17)
- **After R2** (same function; avoids editing it twice).
- **Change:** the return type of `publishPdfPart` gains a structured cause (for example `code: "EEXIST"`), in `src/write-guard.ts`; `src/tools/export-pdf.ts` stops matching the message prefix; tests updated.
- **Before the plan is written:** map every failure case of `publishPdfPart` (not found, not a regular file, EEXIST, other link error) and every caller and test (`export-pdf.ts:424`, the three `write-guard.test.ts` tests, the `export-pdf.test.ts` mocks and PX12b/PX12c). The existing return shape must stay compatible for those callers, or the tests that depend on it are updated in the same step.
- **Acceptance:** PX12b and PX12c classify without depending on message wording; the other existing tests still pass.

## 6. Deferred, not approved for implementation

- **R4 — `%PDF-` check (G18).** Do not add it before the contract is defined: does the owner require the header at byte 0, or must valid PDFs with leading bytes also be accepted? Decision needed first.
- **R5 — a lock shared by `export_pdf` and `save_document` (G13).** Needs a focused plan first: entry points, hold time, release on failure, deadlock risk, and whether it changes the behaviour of the save paths.
- Outside F2: in-script checks for `export_pdf` (G1) and `computeAgentName` (G3, D6).

## 7. Dependencies

```
R1  independent of R2/R3 (tests only); recommended first as a safety net for R2
R2  after R1 (recommended)
R3  after R2 (same function)
R4, R5  deferred; each needs its own decision and plan
F2-10, F2-11  gates for every step
```

## 8. Files

| Step | May change | Must not change |
| --- | --- | --- |
| R1 | `tests/unit/tools/export-pdf.test.ts` | all of `src/` |
| R2 | `src/write-guard.ts` (`publishPdfPart` only), `tests/unit/write-guard.test.ts`, `tests/unit/tools/export-pdf.test.ts` | `sendWriteScript`, `src/tools/export-pdf.ts` (unless D-R2-2 is approved), `dist/`, `src/transport/result-file.ts` |
| R3 | `src/write-guard.ts` (`publishPdfPart` return), `src/tools/export-pdf.ts`, the tests above | `sendWriteScript`, `dist/` |
| every step | — | `CLAUDE.md`, `package.json`, `package-lock.json`, `README.md`, `docs/PROJECT_STATE.md` (counts are updated only in a separate documentation step) |

## 9. Tests and validation (every step)

- A focused run of the touched test files first, then `npm test` with the real count and the exit code recorded, then `npx tsc --noEmit`, `git diff --check`, `git status --short`, and a staging check.
- Sensitivity checks on a scratch copy (scratchpad only), never by editing the project.
- Integration tests are **not run** (`npm run test:integration` is forbidden by `CLAUDE.md`); no InDesign operation.

## 10. Open risks

- The `lstat` → `unlink` window remains after R2 (see R2).
- Ownership of an existing `.part` is not proven by R2 or by any step here.
- `fs.link` followed by a swap between the tool's inspection and the link publishes the swapped file (fact 5); not closed by R2.
- Changing the return shape of `publishPdfPart` (R3) touches a contract that tests depend on.
- G19 is an assumption about a real interleaving; R1 and R2 test it, but its real-world likelihood stays unknown. **Window A (a change before `publishPdfPart` is entered) stays open without O-a or O-b**; the entry comparison alone does not close it.
- Without D-R2-2, R2 records the registry state after a publish but `publishPdfPart` returns no registry information to the caller; leftover or foreign files at `partPath` may already be reported through the existing `warnings`, which is to be verified by tests, and not every registry state is reported.
- G20 is open: the registry can record `owned` for a file created by a competitor during an `export_pdf` run. The evidence is a scratch probe, not a repository test, and no reader of that record was found in the code examined (§3, fact 11).
- G13 (no shared lock), G14 (unknown save outcome), G18 and every real-InDesign behaviour remain open.

## 11. Stop conditions

- Any contradiction between this plan and the code that is found while planning a step: stop and report it, do not correct it silently.
- Any need to change `sendWriteScript`, `dist/`, `result-file.ts`, dependencies or `CLAUDE.md`: stop and ask.
- Any sensitivity check that does not fail on its matching mutation: stop and report.
- R1: a test shows that a required behaviour is not implemented: change no code in R1, stop, report, ask for a separate approval.
- R2: `uncertain` cannot be kept without overwriting a foreign record, or the policy needs a file or API outside the approved scope (`sendWriteScript`, `export-pdf.ts`, the record or decision type, the `publishPdfPart` return shape; O-a, O-b, D-R2-2): stop, report, ask for a separate approval; do not widen R2.
- No `git add`, commit or push without a separate explicit approval.

## 12. Decisions that need the owner

1. Approve this document as the plan (it is not approval to implement).
2. For each step R1, R2, R3: a separate approval before implementation.
3. R4: the `%PDF-` contract (header at byte 0, or tolerate leading bytes).
4. R5: a plan for the shared lock, and whether it is wanted at all.
5. Whether G19 is added to the v3.8 gap list now or at the next documentation update.
6. **D-R2-1 (identity of the record) — owner's direction recorded:** O-c is the only option limited to R2, subject to a separate approval of the implementation. Window A stays open and O-c does not bind the record to the original write. O-a and O-b stay outside this plan and need their own plan and approval.
7. **D-R2-2 (reporting the registry state only):** should the registry state after a publish be reported to the caller? That would need a change to `export-pdf.ts` (and probably to the `publishPdfPart` result), which is outside R2 and is not made here. Leftover or foreign files at `partPath` are a separate matter and may already be reported through `warnings`.
8. **G20:** a separate plan (it touches `sendWriteScript`) or a documented limit. It is not part of R2 or R3, and R2's files do not include `sendWriteScript`.
