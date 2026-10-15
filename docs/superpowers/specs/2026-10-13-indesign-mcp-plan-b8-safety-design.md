# InDesign MCP — Plan B8 Design Spec (Write Safety)

**Date:** 2026-10-13 (revised 2026-10-15, plan version 3.7)
**Status:** Plan only. Version 3.7 is approved in principle as documentation. **Not approved for implementation.** No code, dependency, `CLAUDE.md`, `dist/` or integration-test change is authorized by this document.
**Parent specs:**
- `docs/superpowers/specs/2026-05-05-indesign-mcp-design.md`
- `docs/superpowers/specs/2026-05-06-indesign-mcp-plan-b7-design.md`
**Implementation plan:** `docs/superpowers/plans/2026-10-13-indesign-mcp-plan-b8.md`

## Goal

B8 protects exactly two things:

1. The user's own InDesign documents, from the integration-test suite.
2. Existing files on disk, from being overwritten by `save_document` and `export_pdf`.

**In B8:** a write guard, script classes, a safe integration-test infrastructure, documentation.
**Not in B8:** any mechanism that lets the server overwrite a file it does not own.

## Out of scope

- **Dependencies.** The existing local change to `package-lock.json` stays undecided: not restored, not committed, no `npm ci` / `npm install`. Every B8 commit adds files by explicit path (never `git add -A` or `git add .`).
- Tests run on what is currently installed (SDK 1.32.1). Every test report records the installed version (`npm ls @modelcontextprotocol/sdk`, read-only). B8 does not touch `src/server.ts` and uses no SDK API the project does not already use.
- **`CLAUDE.md` and the `indesign-art-director` skill** are not edited in B8. A separate plan follows the merge.
- The tools' reliance on `activeDocument` (B9), RTL, visual page checks, new tools.
- **Recursive cleanup in 12 existing test files** — a separate follow-up task (see "Limitations", item 17).

## Principles

1. When the state is uncertain — refuse. A refusal never sends a write script to InDesign.
2. No parameter sent by the model counts as user approval.
3. Tests close only documents they created and labelled, and never start automatically.
4. The active `dist/` is not changed until after the merge and the user's approval.
5. Every stage ends with a stop. The maintainer runs every command in Terminal and returns the output.

## Installed dependency versions (read-only check, 2026-10-14)

Sources: `package.json`, `git show HEAD:package-lock.json`, the working-tree `package-lock.json`, `node_modules/*/package.json`. B8 changes none of these values.

| Package | Range in `package.json` | Lock in Git | Lock in working tree | Installed |
| --- | --- | --- | --- | --- |
| `@modelcontextprotocol/sdk` | ^1.0.0 | 1.29.0 | **1.32.1** | 1.32.1 |
| `@hono/node-server` (transitive) | — | 1.19.14 | **2.1.5** | 2.1.5 |
| `hono` (transitive) | — | 4.12.16 | **4.13.13** | 4.13.13 |
| `express` (transitive) | — | 5.2.1 | 5.2.1 | 5.2.1 |
| `zod` | ^3.23.0 | 3.25.76 | 3.25.76 | 3.25.76 |
| `zod-to-json-schema` | ^3.23.0 | 3.25.2 | 3.25.2 | 3.25.2 |
| `typescript` (dev) | ^5.6.0 | 5.9.3 | 5.9.3 | 5.9.3 |
| `vitest` (dev) | ^2.0.0 | 2.1.9 | 2.1.9 | 2.1.9 |
| `@types/node` (dev) | ^20.14.0 | 20.19.39 | 20.19.39 | 20.19.39 |

18 lock entries differ from Git in total. Everything installed matches the working-tree lock, not the Git lock. B8 code uses only API that also exists in SDK 1.29.0.

## 1. Script classes and test documents

Every script sent to InDesign belongs to exactly one of three classes. Only production tools pass through the foreign-document guard, so tests can create a real foreign document and still close only their own.

| Class | Used by | Foreign-document guard | Labels new documents | Allowed |
| --- | --- | --- | --- | --- |
| `tool` (default) | the 29 tools in `src/tools` | yes, only when `INDESIGN_MCP_TEST_RUN_TOKEN` is set | yes, in the same run | everything the tool does today |
| `test-probe` | test helpers only | no | no | the closed list below |
| `test-cleanup` | the cleanup helper only | no | no | fixed body: close by id list + label, never `activeDocument` |

**Allowed `test-probe` operations (closed list):** read-only queries; creating a simulated foreign document (`createSimulatedForeignDocument`); reopening a file the test saved (L-R-INDD), immediately labelled and registered as a test document; relabelling a test document (C2); saving a test document to a **new fixture file** (L4, L4b, the L-R-INDD control file). No `test-probe` operation closes or exports a document, or saves anything except the fixture. No `test-probe` script goes through the tools or changes the ownership registry.

### Runtime enforcement of `test-probe`

The closed list is enforced at runtime, not only by a code scan. Any deviation is rejected before any write, the test fails, and there is no retry.

1. **`runToken`:** created in `global-setup` (random UUID) and passed to the worker. Every `test-probe` and `test-cleanup` helper checks that it exists, has the expected format, and equals the run's value. Otherwise: stop without sending.
2. **Run directory:** `global-setup` creates one `mkdtemp` directory whose name includes the `runToken`, and records its `realpath`, `dev` and `ino` in the run manifest. A helper given any other directory, or one whose `dev`/`ino` changed, is rejected.
3. **Fixture save — Node checks before sending:**
   - the path passes the same normalization as the tools (§2);
   - `realpath(dirname)` is the run directory or a subdirectory of it (prefix comparison with a trailing `/`, after `realpath`, so `..` and directory symlinks cannot escape);
   - `lstat` of the final path returns `ENOENT` — fixtures are saved only to new names, even inside the run directory;
   - extension `.indd`, and the document with the given `id` is registered with the helper as a test document of this run.
4. **Fixture save — checks inside the script, before `save`:** locate the document by `id`; `extractLabel("indesign-mcp-test") === runToken`; `File(path).exists === false`; the path starts with the run directory (via `lit()`). Any mismatch → `throw` before `save`.
5. **After the save:** `lstat` — a regular file inside the run directory. Path, `dev` and `ino` are recorded in the manifest as "created by this run".
6. **Cleanup — only resources this run created and verified as its own:**
   - **Documents:** as today — `id` in the run's list **and** a label carrying the `runToken`.
   - **Files:** `unlink` (never recursive) only a file recorded in the manifest that is still at the same path inside the run directory, is a regular file (not a symlink), and has the same `dev`/`ino`. Anything else stays and its name is printed.
   - **Directory:** `rmdir` (never recursive) only if it is empty afterwards. If anything unrecognised remains, the directory stays and its path is printed.
   - No `fs.rm` / `rmSync` with `recursive` in **new** B8 test code.

**Unchanged in B8:** 12 existing test files (found by a read-only grep on 2026-10-14) delete their `mkdtemp` directory with `rmSync(tmpDir, { recursive: true, force: true })`. See "Limitations", item 17, and the follow-up task.

### Separation in code

- `wrapExtendScript(body, opts?)` takes `opts.scriptClass`; the default is `"tool"`. Without the environment variable, `tool` output is byte-identical to today (existing snapshot).
- A new unit test (`tests/unit/test-infra-policy.test.ts`) reads every file in `src/` and fails if `scriptClass` appears anywhere except `compose.ts`, so a production tool cannot bypass the guard.
- In production (variable unset) there is no guard at all, so the other classes grant no extra capability.

### Two labels

| Label key | Value | Meaning |
| --- | --- | --- |
| `indesign-mcp-test` | `runToken` | A document the test created in this run. The guard accepts it |
| `indesign-mcp-test-foreign` | `runToken` | A **simulated** foreign document the test created. Foreign to the guard in every respect |

The user's documents carry neither label. A test document from an earlier run carries a different `runToken` and is therefore foreign.

### Test flow

1. **`global-setup`:** a `test-probe` query — if any document is open, the whole run stops. Otherwise a `runToken` is created and the variable is set.
2. **`beforeAll` in every file (`integrationGate`):** the same check, so a file run on its own is also protected. It also checks that the variable actually reached the worker; if not — stop.
3. **`createTestDocument(args)`:** calls `create_document` (class `tool`, which labels the new document itself); then `test-probe` verifies exactly one new document, equal to the returned `document_id`, carrying the label. The id is registered.
4. **`beforeEach`:** `test-probe` — every open document must be registered and labelled. A foreign document fails the test before any tool call, and a per-file flag fails all remaining tests without sending a script.
5. **Inside every `tool` script:** a document without the run label → `foreign_document_open` before the tool body runs.
6. **`afterEach`:** `closeTestDocuments()` in class `test-cleanup`.

### Narrow cleanup

- `closeTestDocuments()` iterates `app.documents` and closes with `SaveOptions.NO` only a document whose id is in the list passed through `lit()` **and** whose `extractLabel("indesign-mcp-test") === runToken`. Returns closed / remaining lists.
- `closeSimulatedForeignDocument(id)` closes one document only if the id matches **and** `indesign-mcp-test-foreign === runToken`.
- A document that fails the conditions stays open, unsaved and unchanged, and its name is printed. There is no "close all" anywhere.
- **Never close a document solely because its filename contains `_cod`.** Cleanup is based on id and label only.

`Document.id`, `insertLabel` and `extractLabel` on a document: UNVERIFIED until L0.

## 2. Paths, file naming, and ownership

Every write request passes through three layers in order: (a) name computation, (b) path gate, (c) ownership decision. A failure at any layer is a refusal before anything is sent to InDesign.

### Agent file-naming convention (`_cod`)

Every file created by the agent — whether from scratch or as a working copy of an existing file — receives the `_cod` suffix before the extension. This is a **naming convention only**, not proof of ownership. Ownership is always tracked by verified canonical paths and runtime/session metadata (§ Ownership registry).

**Rules (applied in name computation, before the path gate):**

1. **New document from scratch:** the caller supplies the desired base name (e.g. `Wedding_Album`). The agent computes `Wedding_Album_cod.indd` as the working file and passes this name to the path gate.
2. **Working copy of an existing user file:** the caller supplies the source path (e.g. `~/Desktop/Wedding_Album.indd`). The agent derives `Wedding_Album_cod.indd` in the **same directory** as the source. The source file is never touched. The working copy is treated as a new INDD at a free name (path A) — it requires the source-path directory to be writable and `Wedding_Album_cod.indd` to be absent.
3. **`_cod` is applied exactly once:** a file already ending in `_cod` (e.g. `Wedding_Album_cod.indd`) is not renamed to `Wedding_Album_cod_cod.indd`. The idempotence check strips any existing `_cod` suffix before appending, so the canonical form is always `<base>_cod.<ext>`.
4. **Versioned snapshots:** when a snapshot is requested (explicitly by the user, or at a defined checkpoint), the agent computes `<base>_cod_v1.indd`, `<base>_cod_v2.indd`, … — never overwriting an existing versioned snapshot. The next free `vN` is found by sequential `lstat` from `v1` upwards; the agent stops after `v99` and returns `version_limit_reached`. Version numbers have no leading zeros.
5. **PDF exports:** the same convention applies. An export from `Wedding_Album_cod.indd` produces `Wedding_Album_cod.pdf`; a versioned export produces `Wedding_Album_cod_v1.pdf`, etc. The PDF name is derived from the INDD working-file name, not from the source.
6. **File name length:** the computed name (including `_cod` or `_cod_vN`) must be at most 255 UTF-8 bytes. If adding the suffix would exceed this, the base name is truncated before appending, and a warning `name_truncated` is included in the response.
7. **Ownership is never inferred from `_cod`:** a file named `Foo_cod.indd` that the server did not create in the current session is treated as path C (not owned) — exactly like any other file. The suffix conveys intent to a human reader; it does not change the registry.

**`_cod` suffix is a naming convention — not a safety mechanism.** The write guard, ownership registry, and fingerprint checks are the safety mechanisms. A file with a `_cod` name receives exactly the same gate and registry treatment as any other file.

### Path gate (save-as and export)

| Check | Rule | Result on failure |
| --- | --- | --- |
| Form | Starts with `/`, or with `~/` (expanded to the home directory). Rejected: relative path, `~user`, `..` segment, null byte | `invalid_args`, `reason: path_not_absolute` |
| Extension | `.indd` for save, `.pdf` for export (case-insensitive) | `invalid_args`, `reason: wrong_extension` |
| Parent directory | Exists and is a directory. `realpath` is allowed on the directory only (`/tmp`, `/var` are symlinks on macOS) | `io_error`, `reason: parent_missing` |
| File name | `lstat` (no symlink following): if it exists it must be a regular file | symlink: `reason: symlink_target`; directory or other: `reason: not_regular_file` |
| System error | `EACCES`, `ELOOP`, etc. at any step | `reason: uncertain` |

- Registry key: `realpath(directory) + "/" + NFC(file name)`. InDesign receives the path in its original form after `~/` expansion.
- In-place save (no `path`) passes the same gate on `doc.fullName`, read by the read-only query.

### Path normalization — exact specification

Every rule is covered by a unit test.

1. **Input:** a non-empty string, no null byte, at most 1024 UTF-8 bytes.
2. **Prefix:** starts with `/`, or exactly with `~/`. Rejected (`path_not_absolute`): bare `~`, `~user/…`, relative paths. No environment-variable expansion (`$HOME` stays literal).
3. **`~/` expansion:** `os.homedir()` must be absolute and non-empty, otherwise `uncertain`. Result: home directory + `/` + the rest.
4. **Segments:** split on `/`. Rejected: empty segments (`//`, trailing `/`), `.` and `..`. No silent normalization — a path that would need normalizing is rejected.
5. **File name** (last segment): at most 255 bytes; must not start with `.indesign-mcp-` (reserved for temporary files); extension `.indd` or `.pdf` per tool, case-insensitive.
6. **Parent directory:** `realpath(dirname)` must succeed and return a directory. Symlinks **in directories** are allowed and resolved (`/tmp` → `/private/tmp`).
7. **Final path** = the directory after `realpath` + `/` + the file name as given. This is the path checked with `lstat`, sent to InDesign, and returned. Registry key = same directory + `/` + NFC(file name).
8. **`lstat` of the final path:** missing → new; regular file → existing; symlink (including broken) → `symlink_target`; any other type → `not_regular_file`; error → `uncertain`.
9. **Unit-test examples:** `~/Desktop/a_cod.indd` accepted; `~/../x.indd`, `./a.indd`, `/Users/x//a.indd`, `~daniel/a.indd`, `/tmp/a.indd/` rejected; `/tmp/אלבום/הזמנה_cod.indd` becomes `/private/tmp/אלבום/הזמנה_cod.indd`; NFD and NFC names give the same key.

### Name computation — exact specification

Name computation runs **before** the path gate and produces the `path` argument passed to the gate. It is a pure function of the caller's intent, the source path (if any), and the filesystem state (lstat calls only, no writes).

**New document from scratch:**
- Input: desired base name (string, no path separator, no extension) and target directory.
- Output: `<target_dir>/<base>_cod.indd` (with `_cod` idempotence: if `<base>` already ends with `_cod`, do not append again).
- Passes to the path gate; the gate decides whether the name is free or taken.

**Working copy of an existing file:**
- Input: source path (an existing `.indd` file, validated by `lstat`).
- Source base: strip the `.indd` extension from the file name; strip any trailing `_cod` (idempotence); append `_cod`.
- Output: `<source_dir>/<source_base_without_ext>_cod.indd`.
- The source file is read-only from the agent's perspective. The agent never passes the source path to `save_document`.

**Versioned snapshot:**
- Input: the current working-file path (`<base>_cod.indd`).
- Base for snapshot: strip `_cod.indd`; compute `<base>_cod_v<N>.indd` for N = 1, 2, … 99 until `lstat` returns `ENOENT`.
- If N reaches 99 and all exist: `version_limit_reached`, no write.
- The snapshot is always a save-as (path A) to a new name; the working file (`_cod.indd`) is unchanged.

**PDF export name:**
- Input: the current working-file path or the versioned snapshot path.
- Output: replace `.indd` extension with `.pdf` (same `_cod` or `_cod_vN` suffix already present).
- Passes to the path gate for `export_pdf`.

**Idempotence rule (applied in all cases):**
- Strip trailing `_cod` from the stem before appending `_cod`. This means computing the agent name twice from the same source produces the same output.
- Does not strip `_cod_vN` — a versioned snapshot is never the input to working-copy derivation.

### Ownership registry (`src/write-guard.ts`)

- In memory only, for the lifetime of the server process.
- Record: `{state, documentId, tool, dev, ino, size, mtimeMs, ctimeMs}`.
- States: `owned` (written and recorded), `pending` (write in progress), `uncertain` (outcome unknown).
- **Repeat write without approval** is allowed only in state `owned`, with the same tool, the same `documentId`, and an identical fingerprint in all five fields — i.e. a file created by the server in the same session. INDD only; an existing PDF is never replaced (§4).
- **Every other state = `name_collision`** with `existing_path`, `suggested_path`, `reason`:
  - `not_owned` — no record (including after a restart);
  - `fingerprint_mismatch` — the file was changed or replaced externally;
  - `document_mismatch` — a different document or tool;
  - `path_changed` — the document is now saved at a different path than recorded;
  - `uncertain` — state `pending` / `uncertain`, or an error in the gate.
- **Suggested name:** applies the versioned-snapshot naming rule: `<base>_cod_v1.indd`, `<base>_cod_v2.indd`, … Checked with `lstat` at refusal time only; not stored.
- **`_cod` in the suggested name:** the suggestion always follows the `_cod` convention regardless of whether the conflicting file has a `_cod` name.

### INDD files not registered as ours

Any INDD file not written by the server in the current process: a file that existed before the server started, a file saved manually, or a file from a previous run. Nothing is ever written to it.

| Situation | Result |
| --- | --- |
| `save_document` with `path` to such a file | `name_collision`, `reason: not_owned`, with `suggested_path`. No script sent |
| `save_document` without `path` (in-place) on a document opened from such a file | One read-only query, then `name_collision`, `reason: not_owned`. The file on disk is untouched; the changes stay unsaved in InDesign |
| A file the server saved and the user then saved manually | `fingerprint_mismatch` — same as a foreign file |
| After a server restart | Every existing file is `not_owned` |
| Call with `overwrite`, `overwrite_confirmation_id` or any other approval field | `invalid_args` (fields do not exist in the schema). No script sent |
| Any environment variable in the host configuration | No effect — no tool reads an overwrite-enabling variable |

**Working with `name_collision`:**

1. Claude shows `existing_path` and `suggested_path` (a `_cod_vN` name) and asks.
2. Recommended: save-as to the `_cod_vN` copy (`save_document` with `path: suggested_path`). The original is untouched. From then on the open document points at the copy, the copy is registered as ours, and repeat saves to it work.
3. To update the original itself, the user saves manually in InDesign (Cmd+S). The server does not.
4. Claude never tries to work around the refusal: no deleting, no renaming the existing file, no saving under another name without the user approving that name.

### The three INDD save paths

Every `save_document` call takes exactly one path, decided by the gate. The empty name-reservation placeholder exists only in path A.

| Path | When | Mechanism | Placeholder | Result |
| --- | --- | --- | --- | --- |
| **A. New INDD at a free name** | `path` given and `lstat` returns `ENOENT` | Reserve the name with `wx`, check `length === 0` inside the script, save. Experimental — conditional on L-R-INDD; if rejected, Node check plus `File(path).exists === false` inside the script | **yes — only here** | `owned` |
| **B. Existing INDD owned by the server** | save-as or in-place, record `owned`, same `documentId`, same fingerprint | Full fingerprint in Node; inside the script `File(path).exists` and expected size; save | no | `owned` with a new fingerprint |
| **C. Existing INDD not owned by the server** | save-as to an existing file that fails B, **or in-place save** of a document opened from such a file | **Absolute refusal.** Save-as: zero sends; in-place: one read-only query. No parameter, environment variable or approval changes this | no | `name_collision` with `not_owned` / `fingerprint_mismatch` / `document_mismatch` / `path_changed` / `uncertain`, and `suggested_path`. Overwrite — manual in InDesign only |

**Rules that keep the placeholder away from existing files:**

1. `fs.open(path, "wx")` is called only when `path` is given **and** the gate found `ENOENT`.
2. In-place save never calls `wx`: either a file exists (path B or C), or the document was never saved and `io_error` is returned.
3. An existing file is never "re-prepared" as a placeholder.
4. If the name is taken between the gate and `wx` (`EEXIST`) → path C: `name_collision`, no save.
5. Path B never calls `wx`; path C sends no save script.

## 3. Overwriting a file the server does not own — blocked in B8

B8 has no path that overwrites an INDD or PDF file the server does not own. This is the user's decision (plan version 3.5).

1. **INDD path C, including in-place save:** absolute refusal, `name_collision`, no save script.
2. **Existing PDF:** absolute refusal, `pdf_replace_blocked` (§4) — including a PDF the server created.
3. **No bypass:**
   - The `save_document` and `export_pdf` schemas are `.strict()` and contain neither `overwrite` nor `overwrite_confirmation_id`. A call with either → `invalid_args`, zero sends.
   - No tool and no code in `src/` reads an overwrite-enabling environment variable. Such a variable in the host configuration changes nothing.
   - No elicitation; the server neither requests nor accepts any approval.
4. **The error message** states that the file exists and is not owned by the server, offers `suggested_path` (a `_cod_vN` name), and says overwriting is possible only manually in InDesign.
5. **A repeat write to a server-owned INDD** (path B) is not an "approved overwrite" and needs no approval. It is allowed only when the record is `owned` and the fingerprint matches. Any deviation moves the file to path C.
6. **Future:** any automatic overwrite mechanism will be defined in a separate plan with its own approval and tests. Nothing of it may be implemented before then.

### Enforcement points

The refusal is enforced at every write point in the code, before any write script, through a single gate.

**Fact (read-only grep, 2026-10-14):** `src/` contains exactly three calls that write a document to disk: `doc.save(File(…))` (`save-document.ts:35`), `doc.save()` (`save-document.ts:40`) and `doc.exportFile(…)` (`export-pdf.ts:39`). The extended search found no `saveACopy`, `packageForPrint`, `asynchronousExportFile`, `menuActions`, `eval(` or writes through `File(…)` in the tools. `doScript` appears only in the wrapper at `compose.ts:135`. `.remove()` appears at `create-parent-page.ts:55` on a master page, not a file. Node-side writes exist only in `src/transport/result-file.ts` (an `mkdtemp` directory for the result file, removed by a recursive `rm` of the directory it created itself) and `src/logger.ts` (log). All 28 tool files in `src/tools` use `wrapExtendScript`; only `registry.ts`, which is not a tool, does not.

**Enforcement structure:**

1. **Single gate:** `decideWrite()` in `write-guard.ts`. Both tools call it before building any write script.
2. **Compile-time protection only — `WriteAllowed`:** the functions that build a save or export script accept only a value of the branded type `WriteAllowed`, so a call without a gate decision does not compile. **This is not runtime protection.** The type is erased at compile time and can be bypassed with `as`, `any`, plain JavaScript, or a stale decision reused for another document or path. `WriteAllowed` alone does not count as enforcement.
3. **Runtime verification before every write-script send:**
   - `decideWrite()` returns a frozen object and registers it in a private `WeakSet` in `write-guard.ts`. A value not created there — including a forged object with the same fields — is not in the `WeakSet` and is rejected.
   - A decision is bound to one operation: tool; operation kind (save-as, in-place save, export); `documentId`; final path and registry key; path (A or B); and the expected fingerprint (path B) or "absent" (path A and PDF).
   - A write script is sent only through `sendWriteScript(decision, request)` in `write-guard.ts`, which calls `assertWriteAllowed()` immediately before sending and checks:
     - the decision is in the `WeakSet`;
     - the decision is unused (single use; marked used before sending, even if the send fails);
     - tool, `documentId` and final path match the request exactly;
     - a fresh `lstat` of the path: path B — fingerprint identical in all five fields; path A — the placeholder still has the same inode and length 0; PDF — the `.part` file is ours.
   - Any failure → refusal without sending: `reason: write_not_authorized` (forged, used or mismatched decision), or `name_collision` with `fingerprint_mismatch` (the file changed since the decision). The exact error code is fixed in stage 2 according to `types.ts`.
   - `sendWriteScript` is the only place in `src/` that hands a write script to the sender. It receives the send function as a parameter, so `write-guard.ts` does not import `runScriptWithResultFile`.
4. **Static policy scan** (`test-infra-policy.test.ts`, stage 6) — detects any additional write route outside the approved builders:
   - **InDesign writes:** `.save(`, `exportFile(`, `asynchronousExportFile`, `saveACopy`, `packageForPrint` — allowed only in builders that take `WriteAllowed` and are called only from `sendWriteScript`.
   - **ExtendScript file objects:** `File(…)` or `Folder(…)` with `.open` for writing, `.write(`, `.writeln(`, `.copy(`, `.rename(`, `.remove(`, `.create(` — forbidden in `src/tools`. `.remove()` on a non-file object (such as the page at `create-parent-page.ts:55`) is not a write; every borderline case goes into an explicit, justified exception list.
   - **Indirect routes:** `doScript` allowed only in `src/compose.ts`. Forbidden in `src/`: `menuActions`, `scriptMenuActions`, `eval(`, and bracket access to a write-method name (`["save"]`).
   - **Node writes:** `writeFile`, `appendFile`, `copyFile`, `rename`, `link`, `unlink`, `rm`, `open` with a write flag, and `createWriteStream` are allowed only in `src/write-guard.ts`, `src/transport/result-file.ts` and `src/logger.ts`. Any other file fails the test.
   - **Sending:** using a write builder other than through `sendWriteScript` fails the test.
   - No file in `src/` reads an overwrite environment variable or calls `elicitInput`.
   - **Limit:** the scan is static and pattern-based. It does not prove the absence of writes — for example a method name assembled from strings at runtime. Hence item 5.
5. **Runtime body check in `wrapExtendScript` (stage 6):** every script passing through `compose.ts` is scanned before sending against the write patterns of item 4. If the body contains one of them and did not arrive with a decision that passed `assertWriteAllowed` → refusal without sending. Valid script output is unchanged (the snapshot stays). This is also pattern-based protection, not proof.

| Entry point | What is checked, where | Sends before refusal | Unit test | Live test |
| --- | --- | --- | --- | --- |
| `save_document` with `path` (save-as) | name computation → path gate + `decideWrite()` in Node | 0 | I1–I3, I6, I8, N1–N6 | L3 |
| `save_document` without `path` (in-place) | read-only query (below), then path gate + `decideWrite()` on `fullName` | 1 read-only query | I4, I5, I7, I9a | L4, L4b, L4c |
| Working copy requested | name computation derives `_cod` name → path A (source never touched) | 0 | N3 | L3-wc |
| Versioned snapshot | name computation derives `_cod_vN` → path A | 0 | N4, N5 | L3-vs |
| File changed outside the server | full fingerprint (`dev, ino, size, mtimeMs, ctimeMs`) → `fingerprint_mismatch` → path C | 0 (in-place: 1 query) | stage 2 + I3 | L3 |
| Record `pending` / `uncertain` | → `uncertain` → path C | 0 / 1 | stage 2 | — (internal state) |
| Bypass parameters (`overwrite`, `overwrite_confirmation_id`, any unknown field) | `.strict()` schema → `invalid_args` before the handler | 0 | I6 | L3 |
| Environment variable | never read (scan) | — | I6 + scan | — |
| Path aliases (case, NFC/NFD, symlink as file name, hard link) | `lstat` on the final path + `ino` in the fingerprint. An alias can only lead to a refusal, never to ownership of another file | 0 | stage 2 | L3, L5 |
| `export_pdf` to an existing path | gate → `pdf_replace_blocked` | 0 | P1, P8 | L6 |
| Test scripts (`test-probe`) | closed list (§1); saves only a labelled test document into the run's `mkdtemp` directory | — | C5 + scan | — |

**The read-only query for in-place save:**

- **Identifies the document:** by `document_id` if given, otherwise `app.activeDocument` (B9 limitation). Returns `id`, `name`, `saved`, `modified`, and `fullName` inside `try` (a never-saved document → `null` → `io_error`).
- **Does not change it:** its body contains no `.save(`, `.close(`, `exportFile(`, `insertLabel`, or assignment to a document property. A unit test scans the generated body; L4 verifies that `modified`, the content and the file on disk did not change.
- **Refusal precedes writing:** if the gate decides "path C", no save script is built at all.
- **Document swapped in InDesign between query and save (I9a):** the save script receives the expected `id` and `fullName`, locates the document by `id` (not `activeDocument`), and compares `fullName` before saving. Mismatch → stop without saving, `uncertain`. This catches a swapped active document, a closed document, or a document saved elsewhere in the meantime. **It does not check the file on disk** — see below.

### I9 — what is narrowed and what remains open

Comparing `id` and `fullName` checks the **document object in InDesign**, not the **file on disk**. If another process (Finder, iCloud or Dropbox sync, another app) replaces the file at the same path after the Node fingerprint check and before InDesign writes, `id` and `fullName` still match and `doc.save()` writes over the new file. This applies to path B — both in-place save and save-as to our own path.

| Layer | Catches | Does not catch |
| --- | --- | --- |
| Fingerprint in `decideWrite()` | any change to the file up to the decision | a change after the decision |
| Fresh `lstat` and fingerprint in `assertWriteAllowed()`, immediately before sending (I9b) | a change between decision and send, including the query time of an in-place save | a change after sending — while `osascript` and InDesign run, which can take seconds |
| Inside the script: `id` and `fullName` (I9a) | another document, a closed document, a path changed in InDesign | nothing on disk |
| Inside the script: `File(path).exists` and expected size | a deleted file, or one replaced by a file of a different size | a file replaced by one of the same size |
| `lstat` after saving | that the file was written; fingerprint update | does not restore an overwritten file |

**The remaining race is not solved in B8.** The window between the last in-script check and InDesign's actual write stays open. The existing interfaces cannot close it:

- ExtendScript `File` has no inode and no locking.
- `doc.save()` accepts no "only if unchanged" condition.
- macOS has no mandatory file lock that stops another process; `flock` locks are advisory only.
- Comparing `File.modified` with the Node clock was removed in plan version 3 (two different clocks) and does not return.

The plan does not claim the race is solved, and no test claims to prove it. Possible outcome: a file another process placed at the same path inside that window is overwritten. Recorded as limitation 2.

## 4. Check-to-write races; PDF publishing

An existing PDF is never replaced. For INDD the race is narrowed only — **not solved** — and recorded as a limitation.

| Case | Mechanism | What stays open | Status |
| --- | --- | --- | --- |
| PDF to a free path | temporary file, basic sanity check, publish with `fs.link` (below). No fallback | nothing at the final name | required |
| PDF to an existing path (including a PDF the server created) | refusal `pdf_replace_blocked` with `suggested_path` (`_cod_vN.pdf`). No `rename`, no replacement | — | required |
| New INDD (path A) | experimental name reservation (below) | depends on L-R-INDD | experimental |
| Existing server-owned INDD (path B) | full fingerprint in Node at decision time and again immediately before sending; inside the script `File(path).exists` and `File.length` | replacement by a same-size file after sending is not detected (see §3, I9) | documented, not solved |
| Existing INDD not owned (path C) | absolute refusal before any write | — | required |

### Publishing a PDF to a free path

Principle: the final name is created by one atomic operation that points at a file whose export finished and passed a basic sanity check. If that is not possible — do not publish.

1. **Path gate (§2).** The target must not exist (`lstat` → `ENOENT`). Otherwise `pdf_replace_blocked`.
2. **Temporary name:** `.indesign-mcp-<uuid>.part` in the same directory (after `realpath`). If it happens to exist → `uncertain`, no export.
3. **Export:** InDesign writes only to the temporary file. The final name does not exist yet, so a partial file is never visible under the final name.
4. **Timeout or export error:** do not publish and do not delete the temporary file (InDesign may still be writing). `uncertain`, with the temporary file name in the report.
5. **Basic sanity check:** the script reported success; `lstat` of the temporary file shows a regular file larger than 0 (inode recorded); the first 5 bytes are `%PDF-`; `%%EOF` appears in the last 1024 bytes. Failure → delete the temporary file, `io_error`, `reason: pdf_basic_check_failed`. The target is not created.
6. **Publish:** `fs.link(part, final)` — either the final name points at the checked file, or it is not created.
   - `EEXIST` (target taken meanwhile, including a symlink or broken symlink) → name collision only: `name_collision`, `reason: target_taken_during_export`, with `suggested_path`. Delete the temporary file. No retry, no other route.
   - Any other error (`ENOTSUP`, `EPERM`, `EMLINK`, `EXDEV` — e.g. a volume without hard links) → `io_error`, `reason: pdf_publish_unsupported`. Delete the temporary file; the target is not created. Suggestion to the user: export to a folder on the internal disk. **No fallback.**
7. **After a successful `link` the file is published.** From then on: no republishing, no deleting the final file, and no error meaning "not created".
   - `unlink(part)` fails → `ok` with `published: true`, warning `temp_left_behind` and the temporary file name. Same inode, so the final content is not at risk.
   - Ownership recording fails (e.g. `lstat` on the final file) → `ok` with `published: true`, warning `ownership_not_recorded`, record marked `uncertain`.
   - Both → both warnings. Ownership state does not change behaviour: a PDF is never replaced anyway.
8. **Deleting the temporary file** only if `lstat` shows a regular file with the inode recorded in step 5.
9. **Crash:** before `link` — only a hidden temporary file remains; the target does not exist. After `link`, before `unlink` — the target is published and a temporary file also remains. In no case is the final name created before the export finished and passed the basic check.

**What the basic check proves and what it does not:** `%PDF-` at the start and `%%EOF` at the end detect an empty, truncated or non-PDF file. They do **not** prove the PDF is valid, complete or print-ready. In B8 that is checked by eye only (V3). Real preflight is future work.

### `File.length` limitation

The in-script ExtendScript check compares existence and size only. It sees no inode, ctime or content, so a file replaced by a different file of the same size is overwritten. The full check runs in Node earlier. Recorded as limitation 2, not as a fix.

### INDD name reservation — experimental, conditional on L-R-INDD

**Flow:** path gate (target absent) → `fs.open(path, "wx")` and close; `lstat` = regular file of length 0, inode recorded → the script checks `File(path).exists` and `File(path).length === 0`, otherwise stops without saving → `doc.save(File(path))` → `lstat` afterwards: size greater than 0 → `owned` with a new fingerprint.

**L-R-INDD — setup (a new `mkdtemp` directory per run):**

- A test document via `createTestDocument`: 3 pages, a text frame with "בדיקת שמירה — Save test 123", paragraph style `B8Check`. Recorded: page count, frame count, frame text, style name.
- An identical control document, saved by a normal save to a free path without name reservation.

| # | Check | Pass |
| --- | --- | --- |
| S1 | The save | returns `ok` within `INTEGRATION_TIMEOUT_MS`, no dialog, no hang |
| S2 | The file on disk | regular file, size > 0, first 16 bytes identical to the control file |
| S3 | `doc.fullName` (`test-probe` query) | equals the final path under NFC comparison |
| S4 | Reopen | the document is closed by the narrow cleanup; `test-probe` opens the file without a dialog (`app.open(File(path), false)` — UNVERIFIED), labels and registers it immediately; pages, frames, text and style match the record |
| S5 | Same reopen on the control file | passes — proves the test itself is sound |
| S6 | Registry | state `owned`, fingerprint equals `lstat` after the save |

**Pass:** S1–S6 in 3 of 3 consecutive runs.

| # | Failure | What happens |
| --- | --- | --- |
| K1 | Error or timeout in the save | `uncertain`. The placeholder is deleted only if same inode and length 0; otherwise it stays and is reported. Mechanism rejected |
| K2 | Save "succeeded" but S2–S4 failed | Mechanism rejected. The file stays in the test directory for inspection and is reported |
| K3 | InDesign dialog or hang | Timeout → as K1. The user closes the dialog manually. Mechanism rejected |
| K4 | S5 fails (the control fails) | The test is invalid. Stop without a decision |

**After the test:** passed → kept. Rejected → the name-reservation code is removed before merge, new INDD relies on the Node check and `File(path).exists === false` inside the script, and the limitation stays. No variations are tried without new approval.

### Deletions by the server

The server deletes only files it created in the same call: its own `.part`, and a placeholder with the same inode and length 0. Nothing else.

## 5. Failure and uncertain states

Rule: any state in which the server does not know for certain what was written ends in a refusal of the next write to that path. Before every write the record moves to `pending`, so a failure never leaves a stale fingerprint valid.

### Server and files

| State | Immediately | Record | Next write to the path | On disk |
| --- | --- | --- | --- | --- |
| Write succeeded, stat succeeded | success | `owned` | allowed | the new file |
| Write succeeded, recording failed (stat failed) | success + warning `ownership_not_recorded` | `uncertain` | refused | the new file |
| Timeout talking to InDesign | error: "write state unknown". InDesign may finish later | `uncertain` | refused | unknown |
| InDesign returned an error or crashed | error | `uncertain` | refused | possibly a partial file |
| **Server stopped** (host closed, crash, kill) | registry lost | none | refused `not_owned` | an empty placeholder (0 bytes) at the final name or a `.indesign-mcp-*.part` file may remain. Not deleted automatically after a restart (ownership unknown) |
| **File changed outside the server** (including the user's Cmd+S in InDesign) | found at the next write: one of `dev, ino, size, mtimeMs, ctimeMs` differs | stays `owned` with the old fingerprint | refused `fingerprint_mismatch` | the file in its external state |
| File deleted externally | path is free | record removed | allowed as a new creation | — |
| Error in the gate itself | refusal before sending | unchanged | refused | unchanged |

### PDF — failures before and after publishing

| State | Response | Final file | Registry |
| --- | --- | --- | --- |
| Timeout / export error | `uncertain` + temporary file name | not created | none |
| Temporary file fails the basic check | `pdf_basic_check_failed` | not created | none |
| `link` → `EEXIST` | `target_taken_during_export` | someone else's, untouched | none |
| `link` → other error | `pdf_publish_unsupported` | not created | none |
| `link` succeeded, `unlink` failed | `ok`, `published: true`, `temp_left_behind` | created (published) | `owned` |
| `link` succeeded, recording failed | `ok`, `published: true`, `ownership_not_recorded` | created (published) | `uncertain` |
| Crash after `link` | — | created (published); temporary file remains | lost with the server |

After a successful `link` the server never republishes and never reports "not created".

### Integration tests

| State | What happens |
| --- | --- |
| **Document opened between tests** | `beforeEach` detects it → the test fails without calling any tool, and all remaining tests in the file fail immediately. Later files stop in `beforeAll`. The document is not closed or changed |
| **Document opened during a test, between scripts** | the next `tool` script stops at `foreign_document_open` before the tool body. No further writes in that test |
| **Document opened while a single script runs** | cannot be prevented with the existing interfaces. If it becomes `activeDocument`, the running script may edit it. The next script stops |
| Run interrupted (Ctrl+C, crash) | labelled test documents stay open. The next run stops in `global-setup` and lists them. The user closes them manually |
| Variable did not reach the worker | `beforeAll` stops the file before any send |
| Cleanup failed | the test fails and prints what remained open. No second attempt with a broader rule |

## 6. Build and `dist/`

B8 needs no build until after the merge. The active `dist/` does not change until stage 9, and then only with the user's separate approval.

- **Development and tests need no build.** Unit and integration tests import from `src/`, and `npx tsc --noEmit` writes no files.
- **A separate test build (`.b8-build/dist`)** was needed only for LE, removed in plan version 3.5. It is not part of B8.
- **Before the post-merge build (read-only):** `node -v` (must be 20+ per `engines`), check the server entry in the host configuration, `ps -axo pid,lstart,command | grep "[d]ist/index.js"`. Close Claude Desktop before the build.

## 7. Test types

Three separate types. Only unit tests run without InDesign; all others start only on the user's explicit command.

| Type | How to run | Touches InDesign | Who runs | Protection against accidental runs |
| --- | --- | --- | --- | --- |
| Unit | `npm test`, `npx tsc --noEmit` | no (`runScriptWithResultFile` mocked) | maintainer | `npm test` already excludes `*.int.test.ts` |
| Live integration | `npm run test:integration`, or one file with `--config vitest.integration.config.ts` | yes, only documents it creates | maintainer, after closing all documents | `INDESIGN_MCP_INTEGRATION=1` required; without it files are skipped. An open document = stop |
| Visual | manual checklist | read-only | maintainer looks and reports | — |

### Live integration tests

Before every run: save real work and close all documents. When an open document is needed — a fresh throwaway document only. All files are written to `mkdtemp` directories.

| # | What | Required result |
| --- | --- | --- |
| L0 | One file (`create-document.int.test.ts`), zero documents | passes; zero documents at the end; `Document.id` and labels verified (including persistence after close+reopen) |
| L-R | `safety.int.test.ts`, race part: INDD save over an empty placeholder (L-R-INDD); PDF publish via `fs.link`; `File.length` | decides the conditional rows of §4 |
| L1a | Throwaway document open with unsaved text, full suite | stop before the first test |
| L1b | Same, single file | same result |
| L2 | Zero documents, full suite | all existing tests pass; zero documents at the end |
| L3 | INDD save: save-as (path A, `_cod` name) → repeat (path B, passes) → another document to the same path → `utimes` and external file replacement → symlink → relative path → call with `overwrite` / `overwrite_confirmation_id` | every path-C case and parameter is refused without a save script. On every refusal sha256, mtime and ctime are unchanged, and the symlink target is untouched |
| L3-wc | Working copy: agent derives `source_cod.indd` from a source file, saves path A; source file untouched | `source_cod.indd` registered `owned`; source file sha256, mtime, ctime unchanged |
| L3-vs | Versioned snapshot: `_cod.indd` → `_cod_v1.indd` (path A); second snapshot → `_cod_v2.indd`; attempt to re-snapshot `_cod_v1.indd` → `version_already_exists` | `_cod_v1` and `_cod_v2` registered `owned`; no overwrite |
| L3b | Real foreign document (`test-probe`, foreign label) → tool call | `foreign_document_open`; tool body did not run; page count and content of the foreign document unchanged; `closeTestDocuments` does not close it |
| L4 | In-place save of a test document saved by `test-probe` (unregistered, path C), after the test changed its text | `name_collision`; on disk — sha256, mtime and ctime unchanged; in InDesign — `modified` still `true` and the changed text still there (the query neither changed nor saved) |
| L4b | In-place save of a document previously saved through `save_document` (path B) | success; fingerprint updated; an immediate second save also passes |
| L4c | In-place save of a test document that was never saved | `io_error`; no file created; document unchanged |
| L5 | Hebrew paths: `אלבום בר מצווה/הזמנה_cod.indd` and `הזמנה_cod.pdf` | same as English, versioned suggestion `הזמנה_cod_v1.indd` / `הזמנה_cod_v1.pdf` |
| L6 | `export_pdf`: export to a free `_cod.pdf` path passes; every export to an existing path (including a server-created PDF) → `pdf_replace_blocked`; path taken between check and publish → `EEXIST`; symlink and relative path refused | on every refusal the existing file is untouched |
| L8 | Manual: open a throwaway document during a full run | no write after detection; the document stays open and unchanged |
| L9 | Manual: Ctrl+C mid-run, then another run | the second run stops and lists what remains; no document is closed |
| L7 | After merge and an approved build: restart and save to a previously created `_cod` file | `not_owned` |

LE (verifying an approval dialog in the host) was removed in plan version 3.5 together with the approval mechanism.

### What unit tests prove and what live tests prove

Unit tests run with mocks: they prove the gate's decisions, the order of sends and the content of the generated scripts. They do **not** prove that InDesign 2026 behaves as expected. That is proven only in stage 8, by live tests started manually, on test documents only, without closing foreign documents and without `closeAllDocuments()` (which no longer exists after stage 7).

| Unit test | Path | Live proof |
| --- | --- | --- |
| I1 | A — free path | L3 (first save), L-R-INDD |
| I2 | B — save-as to our own path | L3 (repeat save) |
| I3 | C — save-as to an unregistered file | L3 (other document, external change), L5 |
| I4 | C — in-place save of an unregistered file | L4 |
| I5 | B — in-place save of our document | L4b |
| I6 | C — bypass attempts | L3 (parameters). Environment variable — scan only |
| I7 | never-saved document | L4c |
| I8 | name taken between gate and `wx` | none — a race that cannot be reproduced reliably; unit only, documented |
| I9a / I9b | I9a: document swapped in InDesign; I9b: file changed before sending | none — unit only. The on-disk race after sending has no test that could prove it; documented (§3, limitation 2) |
| N1 | `_cod` idempotence: input already ending in `_cod` | unit only |
| N2 | name truncation at 255 bytes | unit only |
| N3 | working-copy derivation: source path → `_cod` name; source never in the write path | unit only; live: L3-wc |
| N4 | versioned snapshot: N = 1 when none exist; N = 2 when v1 exists | unit only; live: L3-vs |
| N5 | version_limit_reached at N = 99 | unit only |
| N6 | `suggested_path` from `name_collision` always follows `_cod_vN` convention | unit only |

### Targeting cleanup tests

Cleanup closes only identified test documents, and a cleanup failure never leads to a broader close.

- **All documents are created by the test:** test documents via `createTestDocument`; the "foreign document" via `createSimulatedForeignDocument()` — 2 pages, a frame with "מסמך זר — אין לגעת", foreign label. A real user document is never used as the foreign document; the pre-check guarantees there are none.
- **Snapshot of the foreign document before and after:** id, name, page count, frame text, `modified`, `saved`. After cleanup — all identical, and the document is open.
- **Final close** of the foreign document — only via `closeSimulatedForeignDocument(id)` inside `finally`.

| # | Type | What | Required result |
| --- | --- | --- | --- |
| C1 | live | two test documents + a simulated foreign document → `closeTestDocuments()` | exactly the two test documents close. Foreign snapshot identical |
| C2a | live | a test document whose test label was replaced by the foreign label (`test-probe`) | not closed; listed in "remaining". Closed at the end via `closeSimulatedForeignDocument` |
| C2b | live | a document with a valid label whose id was removed from the list (`untrackForTest`) | not closed. After `trackForTest` the cleanup closes it. No other close path |
| C3 | unit | the cleanup script returns an error (mock) | exactly one send; no retry, no other script; the test fails listing the remaining documents |
| C4 | unit | empty id list | no script sent |
| C5 | unit (code scan) | `helpers.ts` and the cleanup script body | no `documents[0]`, `activeDocument` or `closeAllDocuments`; every `close(` inside a condition comparing both id and label; no `close(` triggered solely by a `_cod` filename |
| C6 | unit | `test-probe` or `test-cleanup` helper with a missing, wrong or other-run `runToken` | rejected; 0 sends |
| C7 | unit | fixture save: path outside the run directory; via `..`; via a directory symlink pointing outside; existing file; wrong extension; unregistered document | rejected before sending; 0 sends |
| C8 | unit | fixture script body | label check, `exists === false` and path-prefix check appear before `save` |
| C9 | unit (files in `mkdtemp`) | file cleanup: a manifest file; a replaced file (different inode); a file not in the manifest; a symlink | only the first is deleted; the directory stays because it is not empty; no recursive deletion |
| C10 | live (stage 8) | fixture save of a registered test document whose label was switched to foreign | `throw` inside the script before `save`; no file created |

C3–C9 live in `tests/unit/test-infra-policy.test.ts`.

### PDF publishing unit tests

| # | Case | Required result |
| --- | --- | --- |
| P1 | target exists before export | `pdf_replace_blocked`, zero sends |
| P2 | `link` → `EEXIST` | `target_taken_during_export`; existing file untouched; temporary file deleted; no further filesystem call writes to the target |
| P3 | `link` → `ENOTSUP` / `EPERM` / `EMLINK` / `EXDEV` | `pdf_publish_unsupported`; target absent; temporary file deleted |
| P4 | temporary file without `%PDF-` or without `%%EOF` | `pdf_basic_check_failed`; target absent |
| P5 | `unlink(part)` fails after `link` | `ok`, `published: true`, `temp_left_behind` |
| P6 | recording fails after `link` | `ok`, `published: true`, `ownership_not_recorded`, state `uncertain` |
| P7 | timeout from InDesign | `uncertain`; no `link`, temporary file not deleted |
| P8 | existing target, with `INDESIGN_MCP_ELICITED_OVERWRITE=enabled` set and `overwrite_confirmation_id` in the call | with the field → `invalid_args`, no script; without the field → `pdf_replace_blocked`. The environment variable changes nothing |

P2–P6 belong to stage 2 (the publish function, `write-guard.test.ts`); P1, P7, P8 to stage 4 (the tool, `export-pdf.test.ts`).

### Visual checks (manual)

B8 adds no automatic visual check; the maintainer looks and reports.

| # | What | Required result |
| --- | --- | --- |
| V2 | the throwaway document after L1 and L8 | same name, same text, "unsaved" marker still present |
| V3 | the PDF from L6 | opens, correct page count, not empty |

V1 (the approval dialog) was removed in plan version 3.5.

## 8. Limitations that remain after B8

1. **`activeDocument`.** 27 of the 29 tools (including save and export when no `document_id` is passed) work on the frontmost document. In normal use, a user document that is frontmost will be edited. The foreign-document guard runs in tests only. Fix — B9.
2. **INDD save race (path B) — narrowed, not solved.** The fingerprint is checked at decision time and again immediately before sending (I9b), and the script checks document identity (I9a), existence and size. After sending, another process can replace the file at the same path with a same-size file, and InDesign will save over it. The existing interfaces offer no way to close this window (§3).
3. **INDD name reservation** (path A) is experimental. If L-R-INDD fails, creating a new INDD relies on the in-script existence check only.
4. **An existing PDF is never replaced**, including one the server created. Every further export is a new version (`_cod_vN.pdf`).
5. **An INDD not owned by the server (path C) is never overwritten through the server.** Save a `_cod_vN` copy, or save the original manually in InDesign. B8 has no overwrite-approval mechanism.
6. A stat fingerprint is not a content hash.
7. The registry is in memory only: after a restart every existing file is `not_owned` and goes to path C.
8. After a crash an empty placeholder or a `.part` file may remain; delete manually.
9. A document opened while a single test script runs may be edited.
10. Test documents left after an interruption are closed manually.
11. Only `save_document` and `export_pdf` are protected. InDesign and the user save files without the server too.
12. No automatic visual page check, no PDF preflight, no RTL support.
13. Tests run on the installed dependencies (SDK 1.32.1), not the ones locked in Git. The `package-lock.json` decision stays outside B8.
14. **PDF to a volume without hard links** (e.g. an exFAT external drive — not verified which of the user's drives are like that) is refused with `pdf_publish_unsupported`. Export to the internal disk and copy manually.
15. **`WriteAllowed` is compile-time protection only.** The runtime protection (`WeakSet`, single-use decision, `assertWriteAllowed`) works inside the server process. It protects against coding mistakes, not against malicious code running in the same process.
16. **The static scan and the body check are pattern-based.** They catch known write forms but do not prove the absence of writes (e.g. a method name assembled from strings at runtime).
17. **Unconditional recursive cleanup in existing tests — outside B8.** 12 existing test files (read-only grep, 2026-10-14) delete their `mkdtemp` directory with `rmSync(tmpDir, { recursive: true, force: true })` without verifying its contents. Until the follow-up task is done, a foreign file or symlink that ends up in such a directory is deleted with it. B8 does not change the cleanup code in those files and does not widen its scope because of them. The fix belongs to the follow-up task below.
18. **`_cod` suffix is a naming convention only.** A file named with `_cod` that the server did not create in the current session is path C — refused, not assumed owned. After a server restart all `_cod` files become `not_owned`. There is no way to re-claim a `_cod` file without the user saving manually in InDesign and the agent creating a new working copy.
19. **Version counter starts at v1 per session.** After a restart, version numbers restart from the next free N, not from a global counter. A directory may accumulate `_cod_v1`, `_cod_v2` from multiple sessions.
20. **`version_limit_reached` at v99.** If 99 versioned snapshots exist in the directory, the agent stops and asks the user to clean up.

Limitations 2 (file race after sending), 15 (malicious code in the same process) and 16 (pattern-based scanning) remain open after B8. The plan narrows them and does not claim they are solved.

### Follow-up task — bounded, verified cleanup in the existing tests (outside B8)

**Status:** open, not planned, not approved. Not part of B8 and does not change its scope (19 + 35). Its detailed plan will be presented for review separately, and none of the 12 files changes before explicit approval.

**What changes:** replace the unconditional recursive cleanup (`rmSync(tmpDir, { recursive: true, force: true })`) with bounded, verified cleanup, on the same principle as B8's `test-probe` cleanup (§1):

- **Checking the directory itself:** `lstat` (not `stat`) — a real directory, not a symlink; `realpath`, `dev` and `ino` equal to what was recorded at `mkdtemp` time. `realpath` is used for the directory only, because it follows links.
- **Checking content files:** `lstat` only on each entry, no `realpath`, no link following. Only an entry the test recorded as its own, still a regular file under the same name with the same `dev` and `ino`, is deleted.
- **Narrowing the window between check and delete:** the directory and file checks are repeated immediately before every `unlink`, and the directory check again after every `unlink` and before `rmdir`. Any deviation stops the whole cleanup. The directory is created by `mkdtemp` (mode 0700), so only a process of the same user can swap entries in it.
- **What stays open (to be documented in the task):** Node has no delete relative to an open directory handle (like `unlinkat`), so a short window remains between the check and `unlink`. `unlink` does not follow a symlink in the final component, and `rmdir` fails on a symlink. The remaining risk: the directory itself being swapped for a symlink exactly inside that window, by a process of the same user. The check after `unlink` detects this and stops, but cannot undo the single deletion that already happened. The task will not claim the race is solved.
- **Operations:** `unlink` for files and `rmdir` for the directory, no `recursive`, no `force`.
- **Non-empty directory:** cleanup ends immediately. No recursive deletion, no further attempt to delete what remains, and no change to foreign files (name, permissions or content). The path and the reason for stopping are printed, e.g. `cleanup stopped: <path> — 2 unrecognized entries (a.tmp: file, link1: symlink)`.

**Cases that must be tested:**

| Case | Required result |
| --- | --- |
| Directory not empty after deleting the recorded files (e.g. a helper file InDesign created) | cleanup stops; no repeated `rmdir`, no recursive deletion; path and reason printed |
| Foreign file in the directory (not created by the test) | not deleted or changed; cleanup stops with path and reason |
| Recorded file that was replaced (different inode) | not deleted; cleanup stops with path and reason |
| Symlink inside the directory, to a file or directory outside it | not followed and not deleted; target untouched; cleanup stops with path and reason |
| The directory itself replaced by a symlink, or its `dev`/`ino` changed — before cleanup | nothing deleted; path and reason printed |
| The directory replaced **during** cleanup (simulated in a unit test, between two deletions) | the post-`unlink` check detects it and stops; no further deletion and no `rmdir` |

**Estimated scope:** the 12 files found by grep, plus one shared cleanup helper. The exact list, and whether to reuse B8's cleanup helper (C9), will be decided in the task's own plan.

**Dependency:** starts only after the B8 merge and a separate approval.

## 9. Working decisions (as of plan version 3.7)

No open decisions other than implementation approval.

| # | Decision | Effect on the plan |
| --- | --- | --- |
| 1 | No replacement of an existing PDF, including one from the same server process | always `pdf_replace_blocked` (§4) |
| 2 | Absolute refusal on path C: B8 never writes to an INDD the server does not own, including in-place save | overwrite-approval mechanism removed from B8; overwrite manual only; any future mechanism in a separate plan with its own approval (§3) |
| 3 | `~/` is accepted | per the normalization spec (§2) |
| 4 | `package-lock.json` outside B8 | untouched; versions documented |
| 5 | No fallback for `fs.link` | `pdf_publish_unsupported` |
| 6 | Cleanup in the 12 existing test files stays outside B8 | limitation 17 and a follow-up task (§8); those files and B8's scope do not change |
| 7 | `_cod` is a naming convention only, applied to every agent-created file | naming convention added in plan version 3.7 (§2); ownership always by registry and fingerprint |
| 8 | Versioned snapshots use `_cod_vN` (no leading zeros, cap at v99) | suffix format and version-limit error defined in §2 |
| 9 | Working copy derived from source: same directory, `_cod` suffix, source never in the write path | working-copy derivation defined in §2; source file never passed to `save_document` |
| 10 | Cleanup never closes a document solely because its filename contains `_cod` | explicit rule in §1 narrow cleanup and C5 |
