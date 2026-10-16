# indesign-mcp

MCP server bridging Claude to Adobe InDesign 2026. v1 dispatches ExtendScript
via macOS `osascript`. UXP plugin upgrade deferred to v2.

29 tools live across document lifecycle, text + paragraph styles, visuals &
geometry, parent pages & page numbers, inline character styling, frame
refinements, and read/utility helpers. Verified by 719 unit tests + 79 live
integration tests against InDesign 2026 (21.3.0.60).

See `docs/PROJECT_STATE.md` for current status, conventions, and what's not
yet shipped. See `docs/superpowers/specs/` and `docs/superpowers/plans/` for
the design specs and implementation plans behind each iteration.

## Requirements

- macOS
- Node 20+
- Adobe InDesign 2026 (installed; running when tools are called)

## Install & build

```bash
npm install
npm run build
```

## Test

Unit tests (no InDesign required):

```bash
npm test
```

Integration tests (requires InDesign 2026 running):

```bash
npm run test:integration
```

## Wiring up Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "indesign-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/indesign-mcp/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop. Confirm the server appears as connected in the MCP
status panel.

## Wiring up Claude Code

Add to `~/.claude/settings.json` (or your project's `.claude/settings.json`):

```json
{
  "mcpServers": {
    "indesign-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/indesign-mcp/dist/index.js"]
    }
  }
}
```

## Smoke test

1. Launch InDesign 2026. Wait until the app is idle (no startup dialogs).
2. In Claude (Desktop or Code), ask: *"Use the indesign-mcp tool `get_app_version` and tell me the result."*
3. Expected: Claude reports a version string like `21.0` (or higher).

If Claude reports `app_not_available`, InDesign isn't fully launched. Wait
and retry. For other errors, check `~/Library/Logs/indesign-mcp/server.log`.

## Logging

The server appends one JSON line per event to:

```
~/Library/Logs/indesign-mcp/server.log
```

Useful for diagnosing "Claude said it did X, but X didn't happen" cases —
the log captures the composed ExtendScript and the raw return.

## Status

All seven implementation plans (B1 through B7) are merged. See
`docs/PROJECT_STATE.md` for the tool inventory and what isn't shipped yet.
