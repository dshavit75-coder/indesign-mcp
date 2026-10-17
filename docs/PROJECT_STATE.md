# Project state — 2026-05-07

Quick orientation for anyone (or future Claude) coming back to this repo cold.

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

**Test counts:** 730 unit tests (run via `npm test`) + 79 live integration
tests (run via `npm run test:integration` with InDesign 2026 open, requires
`INDESIGN_MCP_INTEGRATION=1` env).

## What's NOT shipped

Foundation spec (`docs/superpowers/specs/2026-05-05-indesign-mcp-design.md`)
listed several tools that never made it into a B-plan:

**Frame editing (would be B8 — most useful next plan):**
- `set_frame_bounds` — move/resize an existing frame
- `set_frame_rotation`
- `delete_frame`

**Page editing (also B8 candidates):**
- `delete_page`, `move_page`
- `set_page_number_style` (roman numerals etc.)

**State reads (B9 grab-bag candidates):**
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
   — they only run when `INDESIGN_MCP_INTEGRATION=1`.
   `afterEach(closeAllDocuments)` is mandatory.
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

1. `npm test` (730 unit tests must pass)
2. `npx tsc --noEmit`
3. `npm run build`
4. With InDesign 2026 running: `npm run test:integration` (79 tests must pass)
5. Final code review on the branch
6. Merge to main with a descriptive non-fast-forward merge commit
