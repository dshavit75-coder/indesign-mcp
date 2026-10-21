# Project state — 2026-10-21

Quick orientation for anyone (or future Claude) coming back to this repo cold.

## Read this first (state at 2026-10-21, HEAD `3f81d0e`)

- **B8 is the write-safety plan** (guards for writes to InDesign documents and files), **not** a frame-editing plan.
  Its documents (under `docs/superpowers/plans/`): `2026-10-13-indesign-mcp-plan-b8.md`,
  `2026-10-16-indesign-mcp-plan-b8-v3.8-reconciliation.md`, `2026-10-17-indesign-mcp-plan-b8-f2-remaining.md`; and the spec
  `docs/superpowers/specs/2026-10-13-indesign-mcp-plan-b8-safety-design.md`.
  B8 is **partly done** (see "Safety work (B8)" below). **B9** (a required `document_id`, then gating the remaining
  mutating tools) is planned and not started.
- **`dist/` was rebuilt on 2026-10-18 at 17:24 and includes the B8 guard modules.** Per the P1–P3 build log:
  96 files, `npm run build` exit 0, seven guard modules present and non-empty (`write-guard.js`, `read-guard.js`,
  `mutate-guard.js`, `mutate-capability.js`, and three others); `grep -c decideWrite dist/tools/save-document.js` > 0.
  **However:** (a) the build reflects the state at 17:24 on 2026-10-18; the current working tree may differ from what
  was built; (b) `npm run build` alone does not activate the guards — the MCP server process must be restarted (e.g.
  by reconnecting in Claude Code) after the build; (c) string presence in the build output is not a proof of runtime
  correctness. `dist/` is git-ignored. `npm start` runs `node dist/index.js`. On the owner's machine the InDesign MCP
  server is configured in **Claude Code** (user scope, `~/.claude.json`), not in Claude Desktop (its config holds a
  different server only), and the command runs `/Users/danielshavit/Projects/indesign-mcp/dist/index.js` (checked
  2026-10-18). So **do not assume that the guards in `src/` are active in the running server** without confirming that
  the last build post-dates any `src/` change and that the server process was restarted after the build.
- **The integration suite is blocked.** `closeAllDocuments()` in `tests/integration/helpers.ts` is disabled (it always
  throws, since `05e1a00`), and 35 of the 36 `tests/integration/*.int.test.ts` files call it in `afterEach`. If the suite is
  run, every test fails at cleanup. **Do not run `npm run test:integration`.** It is blocked until the CloseToken /
  integration infrastructure (B8 G4, decision D1) is done; the old helper closed EVERY open document, which is unsafe.
- **What the numbers mean:** 824 = unit tests with a **mocked** transport (current; verified 2026-10-21, 54 files, exit 0). History: 796 after Stage 7C, 817 after P1, 824 after P2. 79 = a **historical**
  live-integration figure from before B8 (InDesign 21.3.0.60), **not re-verified**. Limited live checks for P1–P3 were performed on demo documents, as documented below. No comprehensive live verification of all B8 protections has been performed.

## What this is

MCP server bridging Claude → ExtendScript → Adobe InDesign 2026. Architecture:
Node/TS stdio MCP server emits ExtendScript bodies, dispatches via macOS
`osascript` JXA wrapper, reads structured results back through a temp file.

## What's shipped

**29 tools across 7 plans, all merged to `main`:**

| Plan | Theme | Tools |
|------|-------|-------|
| B1   | Doc lifecycle | `create_document`, `add_page`, `save_document`, `export_pdf`, `get_app_version` |
| B2   | Text + paragraph styles | `create_text_frame`, `set_text`, `define_paragraph_style`, `apply_paragraph_style`, `get_page_state` |
| B3   | Visuals & geometry | `create_image_frame`, `place_image`, `create_rectangle`, `create_line` |
| B4   | Parent pages & page numbers | `create_parent_page`, `apply_parent_to_page`, `override_parent_item_on_page`, `insert_page_number_marker` |
| B5   | Inline character styling | `define_character_style`, `apply_character_style_to_range`, `set_text_in_range` |
| B6   | Frame refinements | `set_frame_inset`, `set_frame_columns`, `thread_text_frames` |
| B7   | Polish & utility | `create_swatch`, `duplicate_frame`, `find_replace`, `list_paragraph_styles`, `list_pages` |

**Test counts:**
- **824 unit tests in 54 files** (`npm test`; `npx tsc --noEmit` is clean; verified 2026-10-21). History: 796 after Stage 7C (53 files), 817 after P1 (`save-document-unsaved.test.ts` added, 54 files), 824 after P2 (SP1–SP6, PX14 added). They run with a **mocked** InDesign transport.
  They check the generated scripts, the guards and the error handling; they do **not** prove behaviour in a real InDesign.
- **79 live integration tests: historical.** They passed against InDesign 2026 (21.3.0.60) before the B8 work. They are
  **not** a current result, and the suite cannot run now (see "Read this first"). The owner's machine runs 21.6.0.57,
  which is not recorded as verified anywhere.
- **Live verification of B8: limited.** P1–P3 (2026-10-18) included live checks on demo documents only (no customer
  document opened, saved or changed). Verified live: save-as of a never-saved document (P1, twice); `export_pdf` and
  `pdf_replace_blocked` with the correct `.pdf` suggestion (P3 gate 4); two in-place saves with inode change observed
  (P3 gates 5A and 5A2). **Not verified live:** `fingerprint_mismatch` (gate 5B), Stage 7C token rejection, G5 (21
  ungated mutating tools), G6 (`document_id` not checked against the active InDesign document), G16, G19, G20.
  These P1–P3 checks are **not** a comprehensive B8 verification.

## Safety work (B8) — status

Only what the code and the plan documents show (unit-tested with a mocked transport, not run against InDesign; unit tests do not prove behaviour against a real InDesign). The P1–P3 subsection below separately documents limited live checks on demo documents.

- **Done:** write guard and capabilities for `save_document` and `export_pdf` (single-use token bound to the script body
  and operation); registry of files this server owns; `save_document` lock and outcome classification; `export_pdf`
  hardening (publish through a `.part` file, verify `final`, guarded cleanup of the temporary name); ReadToken for 4 read
  tools (`get_app_version`, `get_page_state`, `list_pages`, `list_paragraph_styles`); **Stage 7C (partial)**, below.
- **P1–P3 fixes and live checks (2026-10-18).** Summary based on `docs/P1-P3-validation-2026-10-18.md`:
  - **P1** (commit `11649fb`): `save_document` save-as for a never-saved document. InDesign 21.6.0.57 throws error
    90938 for `doc.fullName` on unsaved docs (not `""` as assumed). Fix: `__readFullName` helper. 817 tests (20 new
    in `save-document-unsaved.test.ts`). Two live successes on demo docs.
  - **P2** (commit `3189cd8`): `computeSuggestedName` always appended `.indd` — fixed to pass `opts.expectedExtension`
    so PDF export gets `_cod_vN.pdf`. 824 tests (7 new: SP1–SP6, PX14).
  - **P3**: `dist/` built at 17:24:07 (96 files, 7 guard modules present), server reconnected (new PID 90160, 17:27:55).
    Live checks on demo documents: `export_pdf` ok, `pdf_replace_blocked` with correct `.pdf` suggestion, two in-place
    saves (inode changed both times). **Explicitly not done in P3:** gate 5B (`fingerprint_mismatch`), Stage 7C token
    rejection, G5/G6/G16/G19/G20. Not a comprehensive B8 verification.
- **Stage 7C is partial.** A MutateToken is enforced only for `apply_paragraph_style` and
  `apply_character_style_to_range` (a targeted exception to decision D2-d, commit `769d5d1`). **The other 21 of the 23
  mutating tools still call `runScriptWithResultFile` directly with no token (G5).** The token is bound to the script body
  and to the `documentId` the tool passes; it is not verified against the document InDesign actually receives (G6), it does
  not restrict the kind of operation, and `sendMutateScript` does not check that `wrapFn` consumed the token.
- **Open gaps** (full text in the v3.8 and F2 documents; `Ran`/`Read` evidence there):
  - **G3:** `computeAgentName` (the `_cod` naming) exists but no tool uses it; no working-copy or checkpoint option.
  - **G4:** no integration infrastructure (`global-setup`, `runToken`, `createTestDocument`, `closeTestDocuments`,
    `vitest.integration.config.ts`); this is what blocks the integration suite.
  - **G5:** 21 of 23 mutating tools ungated (D2-d: deferred to B9; not repealed).
  - **G6:** the `activeDocument` fallback in 27 tool files; `document_id` is optional; deferred to B9.
  - **G7:** nothing is enforced at the send point; callers of `runScriptWithResultFile` that do not use the guard bypass
    it (Stage 7F, decision D3; touches the protected `src/transport/result-file.ts`).
  - **G13:** the `save_document` lock covers `save_document` only, is process-local, and the 90 s limit is on waiting in the
    queue, not on how long a save may run.
  - **G14:** an unknown save outcome needs manual handling (the placeholder stays and the path is blocked); a late write
    after the user removed it is detected afterwards, not prevented; whether killing `osascript` stops the InDesign script is
    unverified.
  - **G15:** `cleanupPlaceholder` has a race between its `lstat` and `unlinkSync`, and ownership is decided by inode.
  - **G16:** `publishPdfPart` removes the temporary name by path; a swap between the check and `unlinkSync` is not closed.
  - **G17:** two text-prefix contracts between `export-pdf.ts` and the guard (no error class).
  - **G18:** no `%PDF-` check on a non-empty exported file.
  - **G19:** "window A": a foreign registry record of the same shape installed before entry is accepted.
  - **G20:** `sendWriteScript` can record `owned` for a file a competitor created during the export. No fix planned.
- **Also open:** `ok:false` from `publishPdfPart` can follow a publish that already happened (documented in its JSDoc);
  the registry state is not reported to the caller.

## What's NOT shipped

Foundation spec (`docs/superpowers/specs/2026-05-05-indesign-mcp-design.md`)
listed several tools that never made it into a B-plan:

**Frame editing (feature candidate, not scheduled; "B8" now means the safety plan above):**
- `set_frame_bounds` — move/resize an existing frame
- `set_frame_rotation`
- `delete_frame`

**Page editing (feature candidates, not scheduled):**
- `delete_page`, `move_page`
- `set_page_number_style` (roman numerals etc.)

**State reads (feature candidates, not scheduled; "B9" now means the planned `document_id` work):**
- `list_swatches`, `list_character_styles`, `list_master_spreads`
- `get_document_summary` — single roll-up read
- `get_frame` — full detail on one frame
- `set_text_attributes` — direct font/size overrides without saved style

**Open task tracker followups:**
- #27: log failure-branch envelope + cap `scriptTemplate` length in logs
- #48: B3 prep: font_substitution warning + spec/code reconciliation

**Deliberately impossible:**
- `import_font` — InDesign DOM has no font installation hook.
- `list_fonts` — implemented and dropped before merge in B7. Even
  `app.fonts.length` times out at 60s+ on systems with large font libraries.

## Conventions established (load-bearing)

These were learned the hard way, mostly via integration-test failures.
Encoded in code now, but the patterns matter for new tools:

1. **`app.scriptPreferences.measurementUnit`** (NOT `doc.viewPreferences.measurementUnit`
   — the latter doesn't exist on Document; B6 caught this with 5 integration
   failures).
2. **`obj.relation === null`** for InDesign nullable accessors like
   `nextTextFrame`, `appliedMaster` (NOT `.isValid` — accessors return
   actual `null`, not a `{isValid:false}` placeholder; B6 caught this).
3. **`findGrepPreferences`/`changeGrepPreferences`/`findTextPreferences`/
   `changeTextPreferences` MUST be reset to `NothingEnum.NOTHING` BEFORE
   AND AFTER each use** (in a `finally`), otherwise stale state leaks
   across calls. See `find_replace`.
4. **Unit tests use bare-substring `.toContain()`** for value assertions —
   never `.toContain('"<value>"')` with literal quotes. The
   `wrapExtendScript` outer wrapper JSON-encodes the inner script body, so
   quoted-literal substrings get escaped to `\"<value>\"` and never match.
5. **Handlers MUST wrap results with `ok()`** when they emit a
   `document_state_delta`. Read-only tools (`list_*`, `get_*`,
   `get_app_version`) skip the wrapper. The reviewer caught omissions in
   B5 Tasks 3 and 5 — keep watching for it.
6. **Integration tests gate via `integrationGate`** (`tests/integration/helpers.ts`)
   — they only run when `INDESIGN_MCP_INTEGRATION=1`. **Do not run them now:** `closeAllDocuments()` is disabled and
   always throws (see "Read this first"). Until the CloseToken infrastructure exists, new integration tests must track
   the document IDs they create, pass `document_id` explicitly, and clean up only those documents.
7. **macOS firmlinks** (`/var` → `/private/var`) — path comparisons in
   tests should use `existsSync` + suffix matching, not strict equality.
8. **InDesign uses `\r` for paragraph separators**, not `\n`. Server-side
   normalization (`text.replace(/\r\n|\n/g, "\r")`) lives in `set_text` and
   `set_text_in_range`.
9. **Range arithmetic**: external API uses JavaScript-style exclusive
   `end_index`; ExtendScript `itemByRange(start, end)` uses inclusive end.
   Translate via `end_index - 1`. See `apply_character_style_to_range`,
   `set_text_in_range`.
10. **Frame type discrimination via `constructor.name`** — `TextFrame`,
    `Rectangle` (with `graphics.length > 0` → image), `GraphicLine`. The
    same logic appears in `get_page_state`, `override_parent_item_on_page`,
    `duplicate_frame`. If a 4th consumer arrives, factor out a helper.

## Workflow that worked

For each plan: brainstorm → spec (`docs/superpowers/specs/`) → plan
(`docs/superpowers/plans/`) → subagent-driven implementation per task
(implementer → spec-compliance reviewer → code-quality reviewer) → live
integration verification → final code review → merge to main.

The subagent-driven model paid off: each task is small enough to fit in a
fresh context, the two-stage review catches both correctness and quality
issues, and review feedback often catches handler-wrapping omissions and
DOM mismatches before they reach integration tests.

## Repo layout

```
src/
├── compose.ts          wrapExtendScript, lit, prelude — outer JXA + inner ExtendScript composition
├── transport/          osascript dispatch, result-file IPC, Zod envelope validation
├── script-helpers.ts   findDocumentById, findFrameById, findStyleByName,
│                       findMasterSpreadByName, findCharacterStyleByName, resolveSwatch
├── path-utils.ts       resolveUserPath (~/ expansion)
├── errors.ts           ok(), fail(), Envelope shape
├── types.ts            DocumentStateDelta and friends
├── tools/              one file per tool, all follow post-Task-3 template
└── index.ts            MCP stdio server entrypoint, registers all tools

tests/
├── unit/               vitest, mocks runScriptWithResultFile, fast
└── integration/        live InDesign required, gated by INDESIGN_MCP_INTEGRATION=1

docs/superpowers/
├── specs/              design specs (one per plan)
└── plans/              implementation plans with TDD task breakdowns
```

## Live verification

Before declaring any work shipped:

1. `npm test` (824 unit tests must pass; mocked transport)
2. `npx tsc --noEmit`
3. `npm run build`, then confirm that `dist/` contains the guards (for example
   `grep -c decideWrite dist/tools/save-document.js` must be above 0)
4. **Do NOT run `npm run test:integration` for now** (blocked, see "Read this first"). A live check, when the
   owner approves one, is done by hand on a document created for the test, with no other document open, and its result
   is recorded as a live result; the 79-test figure is not a current result.
5. Final code review on the branch
6. Merge to main with a descriptive non-fast-forward merge commit
