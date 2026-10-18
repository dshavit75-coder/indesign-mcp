# P1–P3 validation record — 2026-10-18

Scope: the `save_document` fix (P1), the PDF `suggested_path` fix (P2) and the live checks that followed (P3).
Environment: macOS, Adobe InDesign 21.6.0.57, MCP server started from the local `dist/index.js`.
All live checks used demo documents created for the test. No customer document was opened, saved or changed.

**Evidence levels used below.** *Unit* = mocked transport or a node:vm simulator: it shows the script and guard logic, not InDesign's behaviour.
*Live* = a real call against InDesign on a demo document, verified by reading the document and the files back.
*Not verified* = no evidence either way.

Paths of the demo files are written relative to the session scratch directory (`<scratch>`); that directory is temporary.

## P1 — `save_document` for a document that was never saved

- Commit: `11649fb0a5a75ce7c5ff1ddc8d2973d581bf67e1`
- Message: `fix(save_document): save-as for a never-saved document (doc.fullName throws on InDesign 21.6.0.57)`
- Files: `src/tools/save-document.ts`, `tests/unit/tools/save-document-f2.test.ts`, `tests/unit/tools/save-document-unsaved.test.ts` (new). 414 insertions, 11 deletions.

### The finding (live, one observation)
For a document that was never saved, InDesign 21.6.0.57 does not return `""` for `doc.fullName`; it throws:

| Read | Error number | Message |
|---|---|---|
| `doc.fullName` | 90938 | `Unsaved documents have no full name.` |
| `doc.filePath` | 90937 | `Unsaved documents have no path.` |

The code assumed `""` ("Assumption ט.1"), so `save_document` with `document_id` and a new `path` failed with `script_error`. The assumption was wrong; the stale comment was replaced in the same commit.
The numbers and messages come from a single observation on one machine and one UI language. They are not known to be stable across versions or languages.

### The fix
A shared ExtendScript helper, `__readFullName`, is injected once into the pre-query script and once into the save script. It returns `""` only when all of these hold:
1. `doc.saved === false`;
2. `doc.fullName` threw an error that is the known one (number 90938, or a message starting with `Unsaved documents have no`);
3. `doc.filePath` also threw, and its error is the known one (number 90937, or the same message prefix).

In every other case it re-throws the original error of `doc.fullName`, so nothing unexpected is swallowed (the old code turned any error into `""`).
In the save script that re-thrown error carries `entity: "save_precheck"`, because the read happens before `doc.save`. The existing proof-of-no-write rule (`envelopeProvesNoWrite`) therefore lets the path-A placeholder be removed (Unit: test F5 only; not verified live). A `script_error` without that entity is still an unknown outcome: the placeholder stays and the path is blocked (Unit: pinned by test F6).
Not changed: `decideWrite`, tokens, the lock, ownership checks, overwrite refusal, `envelopeProvesNoWrite`.

### Tests (unit)
- 20 new tests in `save-document-unsaved.test.ts`: P1–P8 (pre-query), W1–W6 (save script), F1–F6 (tool flow with the real write guard). Mocked transport, `node:vm` simulator, `mkdtemp` only.
- `save-document-f2.test.ts`: S7 split into S7 and S7b. An unknown error while reading `fullName` is no longer reported as "document changed"; it comes back as the original error and nothing is saved.
- Mutation checks in a scratch copy (14 mutations of the new logic; one first attempt was invalid and was redone), each killed by the matching tests.
- Result recorded before the commit: 54 test files, 817 tests passed, `tsc --noEmit` clean, `git diff --check` clean.

### Live results
- Save-as of a never-saved document to a new path: succeeded, twice (a 868,352-byte file in the first run, 876,544 bytes in the P3 run). The file was identified as an InDesign document and the document reported `saved=true`, `modified=false`.
- Not verified live: placeholder clean-up after a failure that happens before `doc.save`.

## P2 — the PDF `suggested_path` keeps the `.pdf` extension

- Commit: `3189cd8987ab3c1e50be3308a9fda87a608fd6a7`
- Message: `fix(write-guard): preserve PDF extension in suggested paths`
- Files: `src/write-guard.ts`, `tests/unit/write-guard.test.ts`, `tests/unit/tools/export-pdf.test.ts`. 103 insertions, 8 deletions.

### Root cause
`decideWrite` called `computeSuggestedNameIndd(finalPath)` in three places whatever the expected extension was. The function stripped only a trailing `.indd` and always appended `_cod_vN.indd`. For an existing `b8-live-export.pdf` the live suggestion was `b8-live-export.pdf_cod_v1.indd`.

### The fix
The function became `computeSuggestedName(existingPath, ext)`; all three calls pass `opts.expectedExtension`.
- `.indd`: unchanged (strips a trailing `.indd`, suggests `<name>_cod_vN.indd`).
- `.pdf`: strips the file's own extension (any case, because `pathGate` accepts `.PDF`) and suggests `<name>_cod_vN.pdf`.
- Kept: the `_cod_vN` convention, removal of a trailing `_cod`, skipping names that exist.
Naming convention for PDFs (decision D6) remains with the owner.

### Tests (unit)
- `write-guard.test.ts` SP1–SP6 with the real `decideWrite` and real files in a temp directory: `.pdf` suffix, not `.indd`, first free name (v1 taken gives v2), `_cod` not doubled, upper-case `.PDF`, INDD unchanged, contract (`name_collision`, `not_owned`, `existing_path`) unchanged.
- `export-pdf.test.ts` PX14: `export_pdf` on an existing PDF with the real `decideWrite`: `pdf_replace_blocked`, suggestion ends in `.pdf` and is free, file untouched, nothing sent or published.
- Mutation checks (six, one first attempt invalid and redone) killed by the tests above.
- Result recorded before the commit: 54 files, 824 tests passed, `tsc` clean, `git diff --check` clean.

### Live result
See P3 gate 4: the suggestion for an existing PDF was `p3-demo_cod_v1.pdf`.

## P3 — build, reconnect and live checks

Build of `dist/` after P2: 2026-10-18 17:24:07 (96 files, `npm run build` exit 0, `node --check` on the key files, the seven guard modules present and non-empty; compared with the pre-P1 build that is kept as a backup, only `tools/save-document.js` (the P1 fix and the comment change) and `write-guard.js` (the P2 fix) differed). The old server (PID 84365, started 16:01:26) kept running the previous code until `/mcp` Reconnect; the new server was PID 90160, started 17:27:55, from the same local `dist/index.js`. `get_app_version` returned `21.6.0.57`. The "new build is loaded" conclusion rests on the process start time being after the build, not on inspecting the loaded code; gate 4 then confirmed the P2 behaviour directly.

### Gate 4 — PDF export and overwrite refusal (live, demo only)
Demo dir: `<scratch>/p3-demo/run-EfBas7`. One document (`document_id` 2) with one text frame.

| Step | Result |
|---|---|
| Save-as `p3-demo.indd` | ok; 876,544 bytes; sha256 `88fc9e15774226aff0d171bbed0d0b9d2ff0f388a8331cedd44eea023b027afd` |
| First `export_pdf` to `p3-demo.pdf` | ok, `page_count: 1`; 9,765 bytes; `%PDF-1.4`, `%%EOF`; sha256 `808409ff2006087876a986dde5e3bdeb0f9e5004ddba44360c877a6dacbab9ba`; one hard link; no `.part` or temporary file left |
| Second `export_pdf` to the same path | `pdf_replace_blocked`, `reason: not_owned`; `suggested_path` = `<dir>/p3-demo_cod_v1.pdf` |
| Checks on the suggestion | ends in `.pdf`; not `.indd`; no `.pdf_cod`; differs from the existing path; does not exist on disk |
| Original PDF afterwards | size, mtime and sha256 identical |

Note: the refusal reports `not_owned` even for a PDF that this server session itself exported (the exact time between the two calls was not recorded). The PDF branch refuses any existing regular file by design (comment in the code: "PDF: never allow overwriting any existing file"); the label can mislead. Not changed.

### Gate 5A — in-place save (live)
`set_text` on frame 245, then `save_document` with `document_id` only (no `path`).
- Result `ok: true`, path unchanged; the document went from `modified=true` to `saved=true`, `modified=false`; the text read back matched.
- INDD before: 876,544 bytes, mtime 17:31:22, inode 93816484, sha256 `88fc9e15…027afd`.
- INDD after: 876,544 bytes, mtime 18:02:15, inode **93820805**, sha256 `529c78a7aad5ffae179ebc0ebe07f73a52cacea8486bcc2a73f273e620217cb1`.
- The PDF was unchanged. No alternative INDD was created.

### Gate 5A2 — second in-place save (live observation; registry refresh inferred)
A second text change (`… [registry refresh test 2]`), then the same call.
- Result `ok: true`; `saved=true`, `modified=false`; suffix present in the text.
- INDD before: 876,544 bytes, mtime 18:02:15, inode 93820805. INDD after: 880,640 bytes, mtime 20:45:31, inode **93843982**, sha256 `2e31ff64f2f88635756540d56fb718a7cce569c455963ff69abcd42d154719d2`.
- Interpretation: the first save changed the inode, mtime and content of the file, and the second save passed the fingerprint check. That is consistent with the registry record having been refreshed after the first save (inferred from the code path in `sendWriteScript`/`decideWrite`). The registry itself was never read directly; there is no tool that exposes it.

### Finding: the inode changed on both in-place saves (observed twice)
Two in-place saves, two inode changes at the same path: 93816484 to 93820805 (first save), and 93820805 to 93843982 (second save). That InDesign writes a new file and replaces the old one is an inference from this; the mechanism was not inspected. Consequences, if that holds:
- Identifying "the same file" by inode across saves would not be possible.
- A check that records ownership by comparing the inode of the reserved placeholder (an idea for the G20 gap) is probably not workable if save-as also replaces the file. That has been seen for in-place saves only; the inode of a placeholder across a save-as was not measured.

### Gate 5B — `fingerprint_mismatch` (not verified live)
Not run. It needs an external change to the open demo file; that was not allowed. On path B (in-place) it is covered by unit tests only: `write-guard.test.ts` (each of the five fingerprint fields) and `save-document-f2.test.ts` T-B (size and mtime changed between the decision and the send). `save-document.test.ts` I5 covers a different case, a fingerprint mismatch of the path-A placeholder (mocked), not in-place saves.
A candidate for a separate, explicitly approved check: change only the mtime of the open demo file (`touch`), then call `save_document` on that document. Expected: `name_collision` / `fingerprint_mismatch` before any script runs and no change to the file. Risk not measured: InDesign's reaction to a file whose mtime changed on disk.

## Live evidence gathered earlier in the session (before P2)
All on demo files. Two different server processes were involved:

- **PID 80603 (started 15:16, from the build of 15:11, before the P1 fix):** `get_app_version` (21.6.0.57), `create_document`, `list_pages`, `list_paragraph_styles`, `get_page_state`. The first `save_document` (save-as of the new document) also ran here and failed with `Unsaved documents have no full name.`; that failure is the P1 finding.
- **PID 84365 (started 16:01, after the P1 fix was built):** save-as of the same document (succeeded); refusal to overwrite a foreign INDD (`name_collision`, `not_owned`, file untouched); `export_pdf` (valid PDF-1.4); refusal to overwrite an existing PDF; `define_paragraph_style`, `define_character_style`, `create_text_frame`; `apply_paragraph_style` (one paragraph, 14 pt) and `apply_character_style_to_range` (characters 16–20 only, 5 characters, 18 pt, the rest unchanged; read back for every character). The read-only calls `list_pages`, `list_paragraph_styles` and `get_page_state` were also repeated against this server during the baseline checks.
- Before the test styles and the frame were added, a read-only baseline showed no frames and no test styles on that document (the paragraph styles were the two built-in ones and the character styles only `[None]`).

## What is still not verified
- Placeholder clean-up after a failure before `doc.save` (unit tests F5/F6 only).
- `fingerprint_mismatch` in a live run.
- G16 (race between the check of the temporary name and its removal), G19 window A (a foreign registry record of the same shape), G20 (`sendWriteScript` can record `owned` for a competitor's file). All three are open and pinned as known limits in unit tests.
- Rejection of an unauthorised mutate token in a live run: the tools always issue the token themselves, so it cannot be tested without bypassing the guard. Unit tests and mutations only.
- Hebrew text and RTL behaviour. `define_paragraph_style` still maps `justify` to `LEFT_JUSTIFIED`; nothing sets paragraph direction, composer, digits or binding.
- G5 (21 mutating tools without a token), G6 (`document_id` optional in 27 tool files, bound to the value the tool passes), G7 (direct `runScriptWithResultFile` callers bypass the guards).
- The integration suite stays blocked (`closeAllDocuments()` is disabled and 35 files call it in `afterEach`); the "79 live tests" figure is historical.
- Behaviour on other InDesign versions or UI languages (the "never saved" detection rests on one observation).

## State of the repository when this record was written
Branch `main`, HEAD `3189cd8987ab3c1e50be3308a9fda87a608fd6a7`. `docs/PROJECT_STATE.md` has local changes that are not part of P1–P3 and are not committed. Test count after P2: 824 tests in 54 files (last run before the P2 commit and again at the P3 build). README and `PROJECT_STATE.md` still say 796 and need a separate update.
