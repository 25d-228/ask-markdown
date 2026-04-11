# Claude Code IDE Integration — Reference for ask-markdown

Distilled notes from [coder/claudecode.nvim](https://github.com/coder/claudecode.nvim) — the wire protocol, the subtle behaviors, and a punch list of what ask-markdown still needs to catch up on.

This extension already speaks the same protocol (WebSocket + JSON-RPC 2.0 + MCP) as claudecode.nvim. This doc is for understanding the corners we haven't polished yet.

---

## Contents

1. [How the integration actually works](#1-how-the-integration-actually-works)
2. [Discovery — lock file + env vars](#2-discovery--lock-file--env-vars)
3. [JSON-RPC router](#3-json-rpc-router)
4. [The MCP tools](#4-the-mcp-tools)
5. [selection_changed — proactive context](#5-selection_changed--proactive-context)
6. [Keepalive + wake-from-sleep](#6-keepalive--wake-from-sleep)
7. [What ask-markdown already has](#7-what-ask-markdown-already-has)
8. [Improvements worth making](#8-improvements-worth-making)
9. [Wire format reference](#9-wire-format-reference)

---

## 1. How the integration actually works

The `claude` CLI is the brain. This extension is a **tool server** it calls into. Data flows in two independent directions:

```
                ┌──────────────────────┐
                │   Claude Code CLI    │   ← runs in a terminal
                │   (the LLM)          │
                └──────────────────────┘
                   ▲                ▲
                   │                │
          requests │                │ notifications
          (has id) │                │ (no id, fire-and-forget)
                   │                │
                   ▼                │
         ┌───────────────────────────────┐
         │   ask-markdown extension      │
         │   WebSocket MCP server        │
         │   127.0.0.1:{random}          │
         └───────────────────────────────┘
```

- **Claude → Extension** (requests, carry `id`): `initialize`, `tools/list`, `tools/call`, `prompts/list`. Extension must respond.
- **Extension → Claude** (notifications, no `id`): `selection_changed`, `at_mentioned`. Fire and forget.

The extension **never asks Claude to do anything over the WebSocket**. When the user hits the Claude button, we send `at_mentioned` and focus the terminal — the user types the question themselves.

---

## 2. Discovery — lock file + env vars

### 2.1 Lock file location

```
$CLAUDE_CONFIG_DIR/ide/{port}.lock   (if CLAUDE_CONFIG_DIR is set and non-empty)
~/.claude/ide/{port}.lock            (otherwise)
```

ask-markdown currently hardcodes `~/.claude/ide` in `src/claudeServer.ts` — it should also honor `$CLAUDE_CONFIG_DIR`.

### 2.2 Lock file JSON

```json
{
  "pid": 12345,
  "workspaceFolders": ["/abs/path/to/project"],
  "ideName": "Ask Markdown",
  "transport": "ws",
  "runningInWindows": false,
  "authToken": "550e8400-e29b-41d4-a716-446655440000"
}
```

| Field              | Notes                                                                |
|--------------------|----------------------------------------------------------------------|
| `pid`              | Process id. Claude Code uses it to detect stale locks from crashes.  |
| `workspaceFolders` | Absolute paths. The roots Claude considers "inside the workspace."   |
| `ideName`          | Shown in Claude's `/ide` picker.                                     |
| `transport`        | Always `"ws"` for this integration.                                  |
| `runningInWindows` | Boolean; `process.platform === 'win32'`.                             |
| `authToken`        | UUID v4. Validated on WS handshake. Length must be 10–500 chars.     |

### 2.3 Env vars that matter

Claude Code, when launched from an IDE-controlled terminal, reads:

| Variable                 | Purpose                                                           |
|--------------------------|-------------------------------------------------------------------|
| `CLAUDE_CODE_SSE_PORT`   | Tells Claude exactly which lock file to pick.                     |
| `ENABLE_IDE_INTEGRATION` | Turns on IDE mode.                                                |
| `FORCE_CODE_TERMINAL`    | Tells Claude it's inside an IDE-managed terminal.                 |

ask-markdown is not a terminal launcher — the user runs `claude` in their own terminal. Claude falls back to scanning `~/.claude/ide/` and picks a lock file whose workspace matches the terminal's cwd.

### 2.4 TERM_PROGRAM filter (Cursor gotcha)

Inside Cursor's integrated terminal, `TERM_PROGRAM=vscode` and Claude Code filters its lock-file scan to IDEs that match that env. Ask Markdown's lock file gets hidden. Workaround: `env TERM_PROGRAM= claude`. This is already documented in the README.

---

## 3. JSON-RPC router

All WebSocket messages are UTF-8 JSON conforming to JSON-RPC 2.0. Presence of `id` is the sole signal for "request vs notification" — notifications get zero response, even on error.

### 3.1 Methods to handle

| Method                      | Direction    | Response required                                        |
|-----------------------------|--------------|----------------------------------------------------------|
| `initialize`                | Claude → Ext | Yes — protocol version + capabilities.                   |
| `notifications/initialized` | Claude → Ext | No (notification).                                       |
| `prompts/list`              | Claude → Ext | Yes — return `{ "prompts": [] }` to avoid errors.        |
| `tools/list`                | Claude → Ext | Yes — schema for every exposed tool.                     |
| `tools/call`                | Claude → Ext | Yes — invokes a named tool.                              |
| `selection_changed`         | Ext → Claude | Notification, no response.                               |
| `at_mentioned`              | Ext → Claude | Notification, no response.                               |

**ask-markdown currently does not handle `prompts/list`** — it falls through to the "unknown method" error path. Claude Code tolerates this but cleaner to return `{ prompts: [] }`.

### 3.2 Error codes

```
-32700  PARSE_ERROR        bad JSON
-32600  INVALID_REQUEST    not JSON-RPC 2.0
-32601  METHOD_NOT_FOUND   unknown method or tool
-32602  INVALID_PARAMS     missing/bad params
-32603  INTERNAL_ERROR     pcall-style server failure
-32000  tool-level error   generic tool execution failure
-32001  file not open      specific to getDiagnostics
```

### 3.3 Initialize response (full form)

```json
{
  "protocolVersion": "2024-11-05",
  "capabilities": {
    "logging": {},
    "prompts":   { "listChanged": true },
    "resources": { "subscribe": true, "listChanged": true },
    "tools":     { "listChanged": true }
  },
  "serverInfo": { "name": "ask-markdown", "version": "0.2.0" }
}
```

Subtleties:

- **Empty objects must be objects, not arrays** in the JSON encoder (JavaScript has no ambiguity here — we're fine).
- **`resources.subscribe = true` is a lie** — claudecode.nvim declares the capability but never implements it. Claude Code accepts it. We can do the same.
- **`protocolVersion` is `"2024-11-05"`** even though `"2025-03-26"` exists. Claude Code accepts the older one.

ask-markdown currently returns a minimal `{ tools: { listChanged: true } }`. Broadening to the full set above is free and aligns with what Claude expects.

### 3.4 Tool response shape

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [
      { "type": "text", "text": "{\"success\":true,\"text\":\"...\"}" }
    ]
  }
}
```

**The inner payload is a JSON-stringified JSON object inside a `type: "text"` item.** Double-encoded — not pretty, but that's MCP convention. Claude parses the inner JSON back out.

### 3.5 Deferred (blocking) responses

Tools like `openDiff` don't return until the user accepts or rejects. claudecode.nvim handles this with Lua coroutines + a global `_G.claude_deferred_responses` table. In TypeScript this is trivial — just `return new Promise(resolve => ...)` from the handler, which is exactly how `handleOpenDiff` already works in `src/claudeServer.ts`.

---

## 4. The MCP tools

claudecode.nvim registers 11 user-facing tools. Here's the rundown plus what ask-markdown currently implements.

| Tool                    | In ask-markdown   | Notes                                          |
|-------------------------|-------------------|------------------------------------------------|
| `getCurrentSelection`   | ✅ Implemented    | Shape is non-standard (see 4.1).               |
| `getLatestSelection`    | ❌ Missing        | **Important** — covered in 8.2.                |
| `getOpenEditors`        | ✅ Implemented    | Shape is minimal (see 4.3).                    |
| `getWorkspaceFolders`   | ✅ Implemented    | Shape is minimal (see 4.4).                    |
| `getDiagnostics`        | ❌ Missing        | Return empty; covered in 8.3.                  |
| `openFile`              | ✅ Implemented    | Markdown routes to preview, everything else default. |
| `openDiff`              | ✅ Implemented    | Blocks on save/close via tab lifecycle.        |
| `saveDocument`          | ❌ Not needed     | Read-only viewer; editor has its own save.     |
| `checkDocumentDirty`    | ❌ Not needed     | Same.                                          |
| `closeAllDiffTabs`      | ❌ Not needed     | Polish for `openDiff`; skip.                   |
| `close_tab`             | ❌ Internal only  | Not schema-exposed even in nvim.               |

### 4.1 `getCurrentSelection` — expected response shape

Success:

```json
{
  "success": true,
  "text": "the selected text",
  "filePath": "/abs/path/to/doc.md",
  "fileUrl": "file:///abs/path/to/doc.md",
  "selection": {
    "start": { "line": 10, "character": 0 },
    "end":   { "line": 15, "character": 42 },
    "isEmpty": false
  }
}
```

**Positions are 0-indexed LSP positions.** Both `line` and `character` are zero-based.

Current ask-markdown response uses `{ text, filePath, startLine, endLine }` with **1-indexed** lines and no `fileUrl` or nested `selection` object. This works but is non-standard — an upgrade is listed in section 8.

### 4.2 `getLatestSelection` — why we need it

Same shape as `getCurrentSelection`, but returns the **last non-empty selection** even if the user has since clicked away (e.g. to the terminal). This is how Claude can answer "explain what I just highlighted" after Tab-switching.

**This is critical for ask-markdown's flow**: user selects text → clicks **Claude** button → focus moves to terminal. By the time the user finishes typing their question and Claude fires `getCurrentSelection`, the preview's selection may already be cleared. `getLatestSelection` solves that cleanly.

### 4.3 `getOpenEditors` — expected shape

```json
{
  "tabs": [
    {
      "uri": "file:///abs/path/to/file.md",
      "isActive": true,
      "isPinned": false,
      "isPreview": false,
      "isDirty": false,
      "label": "file.md",
      "groupIndex": 0,
      "viewColumn": 1,
      "isGroupActive": true,
      "fileName": "/abs/path/to/file.md",
      "languageId": "markdown",
      "lineCount": 420,
      "isUntitled": false,
      "selection": {
        "start": { "line": 10, "character": 0 },
        "end":   { "line": 15, "character": 42 },
        "isReversed": false
      }
    }
  ]
}
```

ask-markdown currently returns a bare `string[]` of paths — functional, but Claude can't tell which is active or what language it is. Upgrading to the tab shape above is a small lift.

### 4.4 `getWorkspaceFolders` — expected shape

```json
{
  "success": true,
  "folders": [
    { "name": "my-project", "uri": "file:///abs/path", "path": "/abs/path" }
  ],
  "rootPath": "/abs/path"
}
```

ask-markdown returns a bare `string[]` of fsPaths today.

### 4.5 `getDiagnostics` — stub it

claudecode.nvim returns LSP diagnostics. ask-markdown has none (markdown doesn't produce them). **But we should still register the tool** because Claude may call it during context-gathering, and returning "method not found" is noisier than returning an empty array.

Stub return:

```json
{ "content": [] }
```

---

## 5. `selection_changed` — proactive context

Every time the user changes the selection in the preview, the extension sends:

```json
{
  "jsonrpc": "2.0",
  "method": "selection_changed",
  "params": {
    "text": "the selected text",
    "filePath": "/abs/path/to/doc.md",
    "fileUrl": "file:///abs/path/to/doc.md",
    "selection": {
      "start": { "line": 10, "character": 0 },
      "end":   { "line": 15, "character": 42 },
      "isEmpty": false
    }
  }
}
```

No `id` → no response. Already wired up in `previewProvider.ts`.

### 5.1 Debouncing

claudecode.nvim debounces updates by **100ms**. Every cursor or selection change starts/resets a timer; only the last event in a quiet window actually fires the broadcast.

ask-markdown's `syncSelection` runs on every mouseup/selectionchange in the webview — already lightly debounced on the webview side (200ms in `preview.js`). Good enough in practice.

### 5.2 Visual demotion delay

claudecode.nvim delays "selection is now empty" by **50ms**. If during those 50ms the user focuses the Claude terminal, the demotion is **canceled** and the last visual selection is preserved. Without this, selecting → clicking into the terminal would immediately null out the selection.

**ask-markdown does not do this.** We blast `previewSelectionCleared` → `isEmpty: true` the instant the DOM selection collapses. Combined with implementing `getLatestSelection` (see 8.2), this is a non-issue — Claude can always retrieve the last non-empty selection. The demotion delay is a nicety, not a must.

---

## 6. Keepalive + wake-from-sleep

### 6.1 Ping every 30s

claudecode.nvim's server pings every connected client every 30s. If a client hasn't responded with a pong in `interval * 2` (60s), the server closes the connection with code 1006.

`ws` (the Node library this extension uses) supports this with the `pingInterval` option and manual `ws.ping()` calls. ask-markdown currently has **no keepalive**.

### 6.2 The wake-from-sleep trick

Laptops sleep. When they wake, the ping timer callback fires "late" — maybe hours late. Naive keepalive code will see every client as timed out and close them all, even though nothing is actually wrong.

claudecode.nvim's fix:

```lua
local is_wake_from_sleep = elapsed > (interval * 1.5)
if is_wake_from_sleep then
  -- Reset everyone's last_pong to "now"
  for _, client in pairs(server.clients) do
    client.last_pong = now
  end
end
```

If the interval fires >45s late, assume it's a wake event and forgive everyone. Worth copying if we add keepalive.

---

## 7. What ask-markdown already has

Already in `src/claudeServer.ts` and `src/previewProvider.ts`:

- ✅ Lock file write to `~/.claude/ide/{port}.lock` with auth token
- ✅ Lock file removal on deactivate
- ✅ WebSocket server bound to `127.0.0.1` on a random port
- ✅ Auth via `x-claude-code-ide-authorization` header
- ✅ JSON-RPC 2.0 handler for `initialize`, `tools/list`, `tools/call`
- ✅ Tools: `getCurrentSelection`, `getOpenEditors`, `getWorkspaceFolders`, `openFile`, `openDiff`
- ✅ Notifications: `selection_changed` on selection, `previewSelectionCleared` → empty broadcast, `at_mentioned` on Claude-button click
- ✅ Terminal focus after `at_mentioned`
- ✅ Markdown files opened via `openFile` route to the rendered preview
- ✅ `openDiff` with temp file + save/reject detection via `onDidChangeTabs`

---

## 8. Improvements worth making

In rough priority order. Items 1–4 are small, high-value. Items 5+ are polish.

### 8.1 Handle `prompts/list`

Add a branch that returns `{ prompts: [] }`. Three lines in `handleMessage`. Quiets one category of errors on the Claude side.

### 8.2 Implement `getLatestSelection`

Store the last non-empty selection in a module-scope variable, updated whenever `syncSelection` arrives with non-empty text. `getLatestSelection` returns it even after the preview's current selection has been cleared.

This is the **single most valuable addition** for the user flow: select text → click Claude → type question → Claude's first `tools/call` will now succeed regardless of whether the selection was cleared during the focus transition.

### 8.3 Stub `getDiagnostics`

Register it in `handleToolsList` with the `uri?` schema. Handler returns `{ content: [] }`. Prevents Claude from logging unknown-tool errors during context-gathering.

### 8.4 Align `getCurrentSelection` response shape

Switch to the 0-indexed LSP format used by claudecode.nvim (section 4.1). Include `success`, `fileUrl`, nested `selection: { start, end, isEmpty }`. Preserves compatibility with Claude's assumptions about position indexing.

This applies to **`selection_changed` broadcasts too** — currently `previewProvider.ts` already uses 0-indexed positions for the selection object, so the `selection_changed` shape is already close to correct; `getCurrentSelection` in `claudeServer.ts` is the outlier.

### 8.5 Richer `getOpenEditors` + `getWorkspaceFolders`

Return the tab-object shape from section 4.3 and the folders shape from section 4.4. Lets Claude reason about which document is active, what language it is, and what's selected.

### 8.6 Broaden `initialize` capabilities

Return the full capability set from section 3.3 (`logging`, `prompts`, `resources`, `tools`) instead of just `tools`. No implementation needed — declaring is enough.

### 8.7 Honor `$CLAUDE_CONFIG_DIR`

In `claudeServer.ts`:

```ts
const LOCK_DIR = process.env.CLAUDE_CONFIG_DIR
  ? path.join(process.env.CLAUDE_CONFIG_DIR, 'ide')
  : path.join(os.homedir(), '.claude', 'ide');
```

One-line fix.

### 8.8 Atomic lock file write

Write to `{port}.lock.tmp`, then `fs.renameSync` to `{port}.lock`. Avoids a half-written file being read by a racing Claude Code process. Low risk today but cheap insurance.

### 8.9 Stale lock file cleanup

On startup, scan the lock dir. For each `*.lock`, try `process.kill(pid, 0)` — if it throws `ESRCH`, the owning IDE is gone; delete the file. Keeps the dir tidy for users who've crashed VS Code a few times.

### 8.10 Keepalive with wake-from-sleep

Use the `ws` library's built-in ping support (`ws.ping()` on an interval, track `pong` events, close stale clients). Add the 1.5× interval heuristic from section 6.2 so laptop sleep doesn't kill connections.

Optional — Claude Code will reconnect anyway — but nicer for long-running sessions.

### 8.11 Constant-time auth comparison

`req.headers['x-claude-code-ide-authorization'] === authToken` → `crypto.timingSafeEqual(...)`. Not a real threat model (localhost only, process isolation is the real boundary), but zero downside.

### 8.12 Validate auth header length bounds

claudecode.nvim rejects tokens <10 or >500 chars before the compare. Prevents weird edge cases and matches the reference implementation.

### 8.13 Demotion delay for `previewSelectionCleared`

Delay the empty-state broadcast by ~50ms; if a new non-empty selection arrives within the window, skip the broadcast. Prevents UI flicker in the "reselect quickly" case. Mostly moot once `getLatestSelection` exists.

### 8.14 Source-line-aware `openFile` ranges for markdown

Today `openFile`'s `startText`/`endText` only apply when the file is opened as plain text (markdown files get routed straight to the rendered preview and ignore the fields). We could:

1. Run the text-search against the document
2. Compute a source line range
3. Postmessage the webview to scroll + highlight that range

This would let Claude say "open `notes.md` and jump to the section starting with `## API design`" and actually have the preview scroll there.

### 8.15 `saveDocument` + `checkDocumentDirty`

If we ever allow direct edits from chat (not just diffs), both become necessary. Not needed today.

---

## 9. Wire format reference

### 9.1 Handshake (client → server)

```
GET / HTTP/1.1
Host: 127.0.0.1:12345
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13
x-claude-code-ide-authorization: 550e8400-e29b-41d4-a716-446655440000
```

### 9.2 Initialize request / response

```json
{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2024-11-05",
    "capabilities": {
      "logging": {},
      "prompts":   { "listChanged": true },
      "resources": { "subscribe": true, "listChanged": true },
      "tools":     { "listChanged": true }
    },
    "serverInfo": { "name": "ask-markdown", "version": "0.2.0" }
  }
}
```

### 9.3 `notifications/initialized` (no response)

```json
{ "jsonrpc": "2.0", "method": "notifications/initialized", "params": {} }
```

### 9.4 `tools/list` response

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "tools": [
      {
        "name": "getCurrentSelection",
        "description": "Get the current text selection in the document",
        "inputSchema": {
          "type": "object",
          "additionalProperties": false,
          "$schema": "http://json-schema.org/draft-07/schema#"
        }
      }
    ]
  }
}
```

Including `$schema` is optional but claudecode.nvim does it. Safer to include than omit.

### 9.5 `tools/call` request / response

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": { "name": "getCurrentSelection", "arguments": {} }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"success\":true,\"text\":\"...\",\"filePath\":\"/abs/doc.md\",\"fileUrl\":\"file:///abs/doc.md\",\"selection\":{\"start\":{\"line\":10,\"character\":0},\"end\":{\"line\":15,\"character\":42},\"isEmpty\":false}}"
      }
    ]
  }
}
```

The inner text is double-encoded JSON. That's MCP convention, not a bug.

### 9.6 `selection_changed` notification

```json
{
  "jsonrpc": "2.0",
  "method": "selection_changed",
  "params": {
    "text": "the selected text",
    "filePath": "/abs/path/to/doc.md",
    "fileUrl": "file:///abs/path/to/doc.md",
    "selection": {
      "start": { "line": 10, "character": 0 },
      "end":   { "line": 15, "character": 42 },
      "isEmpty": false
    }
  }
}
```

No `id` → no response.

### 9.7 Error response

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "error": { "code": -32601, "message": "Tool not found: foo" }
}
```
