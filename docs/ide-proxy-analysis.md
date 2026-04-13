# Claude Code IDE Proxy — Unified Cursor + Ask Markdown

Analysis of merging Cursor's and Ask Markdown's IDE integrations into a single server that Claude Code connects to, so the user doesn't have to choose between them.

Based on probing the live WebSocket servers on this machine (Cursor port 22663, Ask Markdown port 52353, both for the `ask-markdown` workspace) and the discovery protocol documented in `claudecode-nvim-analysis.md`.

---

## Contents

1. [The idea in one paragraph](#1-the-idea-in-one-paragraph)
2. [How Claude Code picks an IDE](#2-how-claude-code-picks-an-ide)
3. [What each server provides today](#3-what-each-server-provides-today)
4. [The proxy architecture](#4-the-proxy-architecture)
5. [Tool routing table](#5-tool-routing-table)
6. [Impact on Cursor's existing functionality](#6-impact-on-cursors-existing-functionality)
7. [The CLAUDE_CODE_SSE_PORT gap](#7-the-claude_code_sse_port-gap)
8. [Lifecycle and failure modes](#8-lifecycle-and-failure-modes)
9. [JSON-RPC forwarding mechanics](#9-json-rpc-forwarding-mechanics)
10. [Implementation punch list](#10-implementation-punch-list)
11. [Alternatives considered](#11-alternatives-considered)
12. [Open questions](#12-open-questions)

---

## 1. The idea in one paragraph

Claude Code connects to **one** IDE server per workspace. Today both Cursor and Ask Markdown write lock files to `~/.claude/ide/`, but Claude picks one and ignores the other. The proxy approach makes Ask Markdown the single server Claude sees, while Ask Markdown maintains a background WebSocket client connection to Cursor. When Claude calls a tool, Ask Markdown handles its own tools locally (preview-aware selections, markdown-specific `openFile`) and forwards everything else to Cursor. From Claude's perspective there's one IDE with the superset of both tool sets. From Cursor's perspective there's one extra WebSocket client connected — no different from a second Claude session.

---

## 2. How Claude Code picks an IDE

Three discovery paths, in priority order:

### 2.1 `CLAUDE_CODE_SSE_PORT` (Cursor's integrated terminal)

When Cursor spawns its built-in terminal, it injects:

```
CLAUDE_CODE_SSE_PORT=22663
ENABLE_IDE_INTEGRATION=true
FORCE_CODE_TERMINAL=true
```

Claude reads `CLAUDE_CODE_SSE_PORT`, goes straight to `~/.claude/ide/22663.lock`, reads the auth token, connects. **No scanning, no filtering, no ambiguity.** This is the fast path for IDE-managed terminals.

Lock file manipulation has **zero effect** on this path. Claude doesn't even look at other lock files.

### 2.2 Lock file scan (external terminal)

When `CLAUDE_CODE_SSE_PORT` is not set, Claude scans `~/.claude/ide/*.lock` (or `$CLAUDE_CONFIG_DIR/ide/` if set). For each file it:

1. Parses the JSON
2. Checks if any entry in `workspaceFolders` is a prefix of the terminal's `cwd`
3. Checks the `pid` is still alive (`kill(pid, 0)`)
4. Applies the `TERM_PROGRAM` filter (see 2.3)
5. Picks **one** matching server

The selection heuristic when multiple lock files match is opaque — we don't know if Claude prefers a specific `ideName`, most-recent file, lowest port, or something else. The observable fact is that it picks one and ignores the rest.

### 2.3 `TERM_PROGRAM` filtering

Inside Cursor's integrated terminal, `TERM_PROGRAM=vscode`. Claude uses this to filter candidate lock files — only servers from "vscode-family" IDEs pass the filter. Ask Markdown's lock file (`ideName: "Ask Markdown"`) is hidden.

In an external terminal (`TERM_PROGRAM=Apple_Terminal`, `iTerm2.app`, etc.), this filter doesn't apply. All matching lock files are candidates.

### 2.4 The constraint

Between conversations, Claude picks one server and stays with it. This is confirmed behavior. Two lock files for the same workspace = one gets ignored. That's the problem we're solving.

---

## 3. What each server provides today

Probed from the live servers on this machine (2026-04-12).

### 3.1 Full tool comparison

| Tool | Cursor | Ask Markdown | Notes |
|------|--------|-------------|-------|
| `getCurrentSelection` | Editor selection (code) | Preview selection (rendered markdown) | Different domains — both useful |
| `getLatestSelection` | Last editor selection | Last preview selection | Same — different domains |
| `getDiagnostics` | Real LSP diagnostics | Empty stub `{ content: [] }` | Cursor's is the real one |
| `getOpenEditors` | Rich tab objects (active, dirty, language, selection) | Bare `string[]` of file paths | Cursor's is far richer |
| `getWorkspaceFolders` | Structured `{ folders, rootPath }` | Bare `string[]` of paths | Cursor's is richer |
| `openFile` | Standard editor, supports `preview`, `selectToEndOfLine` | Routes `.md` to rendered preview | Ask Markdown adds markdown awareness |
| `openDiff` | VS Code diff view, all params required | Diff view, flexible params, save/reject detection | Implementations differ slightly |
| `close_tab` | Closes a named tab | Not implemented | Cursor only |
| `closeAllDiffTabs` | Closes all diff tabs | Not implemented | Cursor only |
| `checkDocumentDirty` | Checks unsaved changes | Not implemented | Cursor only |
| `saveDocument` | Saves a file | Not implemented | Cursor only |
| `executeCode` | Runs Python in Jupyter kernel | Not implemented | Cursor only |

### 3.2 Schema differences for overlapping tools

**`openFile`** — Cursor requires `startText` + `endText` (not optional), adds `preview` and `selectToEndOfLine` params. Ask Markdown makes `startText`/`endText` optional, adds markdown-preview routing.

**`openDiff`** — Cursor requires all four params. Ask Markdown makes `new_file_path` and `tab_name` optional and has slightly different error paths.

**All Cursor tools** include `execution: { taskSupport: "forbidden" }` and some include `annotations: { readOnlyHint: true }`. Ask Markdown's tools include neither.

### 3.3 What each server is better at

**Cursor is better at**: real diagnostics, rich editor state, document management (`save`, `dirty`, `close`), code execution, `openFile` with selection for non-markdown files.

**Ask Markdown is better at**: markdown-rendered-preview-aware selections, markdown-specific `openFile` routing, the "select rendered text → Claude" workflow.

---

## 4. The proxy architecture

### 4.1 Overview

```
                                        ┌──────────────────────────┐
                                        │ ~/.claude/ide/           │
                                        │                          │
                                        │ 22663.lock  DELETED      │
                                        │ 52353.lock  Ask Markdown │ ← only lock file for this workspace
                                        └──────────────────────────┘
                                                     │
                                                     │ lock file scan
                                                     ▼
┌──────────────┐    ws://127.0.0.1:52353    ┌──────────────────────────────────────┐
│              │ ◄─────────────────────────► │  Ask Markdown (proxy server)         │
│  Claude CLI  │   auth: Ask Markdown token  │                                      │
│  (terminal)  │                             │  tools/list → merged:                │
│              │                             │    own: getCurrentSelection (preview) │
└──────────────┘                             │    own: getLatestSelection (preview)  │
                                             │    own: openFile (.md → preview)      │
                                             │    fwd: getDiagnostics → Cursor       │
                                             │    fwd: executeCode → Cursor          │
                                             │    fwd: saveDocument → Cursor         │
                                             │    ... etc                            │
                                             │                                      │
                                             │  notifications:                       │
                                             │    own: selection_changed (preview)    │
                                             │    fwd: selection_changed (editor)     │
                                             │                                      │
                                             └──────────────┬───────────────────────┘
                                                            │
                                                            │ ws://127.0.0.1:22663
                                                            │ auth: Cursor's token
                                                            ▼
                                             ┌──────────────────────────────────────┐
                                             │  Cursor (upstream server)             │
                                             │  port 22663, still running            │
                                             │  no lock file, but doesn't care       │
                                             │  serves all 12 tools to any client    │
                                             └──────────────────────────────────────┘
```

### 4.2 Startup sequence

1. Ask Markdown activates, starts its own WebSocket server on a random port (as today).
2. Scans `~/.claude/ide/*.lock` for files where `ideName !== "Ask Markdown"` and `workspaceFolders` overlaps with the current workspace.
3. If a Cursor lock file is found:
   a. Reads `port` (from filename) and `authToken` from the JSON.
   b. Opens a WebSocket client to `ws://127.0.0.1:{port}` with the auth header.
   c. Sends `initialize` + `tools/list` to discover Cursor's tool set.
   d. Caches the tool list.
   e. Deletes (or renames to `.lock.proxied`) Cursor's lock file.
4. Writes Ask Markdown's own lock file (as today).
5. Sets up `fs.watch` on the lock directory for Cursor lock file reappearance (window reloads, crashes, etc.).

### 4.3 What Ask Markdown's lock file looks like

Unchanged from today:

```json
{
  "pid": 58447,
  "workspaceFolders": ["/Users/ip33/Documents/GitHub/ask-markdown"],
  "ideName": "Ask Markdown",
  "transport": "ws",
  "runningInWindows": false,
  "authToken": "7045570a-2a31-40cf-a280-90cc194d00ce"
}
```

`ideName` stays `"Ask Markdown"`. It does not need to pretend to be Cursor — with Cursor's lock file removed, Ask Markdown is the only candidate for external terminals. And for Cursor's integrated terminal, `CLAUDE_CODE_SSE_PORT` bypasses lock files entirely (see section 7).

---

## 5. Tool routing table

### 5.1 Cursor-only tools — forward as-is

These tools don't exist in Ask Markdown. The proxy registers them in its `tools/list` and forwards `tools/call` requests to Cursor's WebSocket.

| Tool | Why forward |
|------|-------------|
| `close_tab` | Ask Markdown has no tab management |
| `closeAllDiffTabs` | Same |
| `checkDocumentDirty` | Ask Markdown doesn't track dirty state |
| `saveDocument` | Ask Markdown doesn't save files directly |
| `executeCode` | Jupyter kernel lives in Cursor |

### 5.2 Ask Markdown wins — handle locally

These tools exist in both servers but Ask Markdown's implementation is better for the use case, or Cursor's is a strict subset.

| Tool | Why local |
|------|-----------|
| `openFile` | Ask Markdown routes `.md` to the rendered preview. For non-`.md` files, forward to Cursor instead (Cursor has richer params: `preview`, `selectToEndOfLine`). |
| `openDiff` | Ask Markdown's implementation is already feature-complete. No benefit from forwarding. |

### 5.3 Cursor wins — forward to Cursor

| Tool | Why forward |
|------|-------------|
| `getDiagnostics` | Ask Markdown returns empty; Cursor returns real LSP diagnostics |
| `getOpenEditors` | Cursor returns rich tab objects; Ask Markdown returns bare paths |
| `getWorkspaceFolders` | Cursor returns structured `{ folders, rootPath }`; Ask Markdown returns bare paths |

### 5.4 Selection tools — unified state with pin window

This is the most important routing decision. Both servers expose `getCurrentSelection` and `getLatestSelection`, but they see different domains:

- **Cursor** sees code editor selections (the user clicks in a `.ts` file and selects some code)
- **Ask Markdown** sees rendered-preview selections (the user highlights a paragraph in the markdown preview)

Ask Markdown **only** knows about `.md` preview selections. For any non-markdown file, it has nothing — those selections live entirely in Cursor's domain. The proxy must forward selection tool calls to Cursor whenever the last interaction was outside the preview.

**The proxy maintains unified selection state:**

```
    Cursor ─── selection_changed ──► ┌──────────────────────────────────┐
                                     │  Proxy selection state           │
                                     │                                  │
    Ask Markdown preview ───────────►│  previewSelection: {...}         │
    (already tracked locally)        │  lastSource: 'cursor'|'preview'  │
                                     │  pinnedSelection: {...} | null   │
                                     │  pinnedAt: timestamp | null      │
                                     │                                  │
                                     │  getCurrentSelection →           │
                                     │    pinned? return pinned         │
                                     │    lastSource 'preview'? local   │
                                     │    lastSource 'cursor'? → Cursor │
                                     │                                  │
                                     │  getLatestSelection →            │
                                     │    same logic                    │
                                     └──────────────────────────────────┘
```

### 5.5 The pin window — why it's needed

There is a timing hazard during the "click Claude" → "type question" → "Claude calls tool" transition:

```
User selects text in .md preview          lastSource = 'preview'
User clicks "Claude" button               at_mentioned sent to Claude
User clicks into terminal
  ── focus leaves the preview ──
  ── Cursor may fire selection_changed    lastSource flips to 'cursor' !!
     (stale/empty selection in code editor)
User types question
Claude calls getLatestSelection
  lastSource == 'cursor' → forward to Cursor → WRONG ANSWER
```

The same hazard exists in reverse: user selects in a `.ts` file, triggers Cursor's `@`-mention, moves to terminal, and the preview fires a stale `selection_changed` during the focus transition.

**Fix:** When `at_mentioned` fires (from either source), the proxy **pins** the selection for a short window (~5 seconds). During this window, `selection_changed` from the other source is ignored.

```
  Notification source         │ Proxy action
  ────────────────────────────┼──────────────────────────────────────────
  selection_changed (Cursor)   │ if not in pin window: lastSource = 'cursor'
  selection_changed (preview)  │ if not in pin window: lastSource = 'preview'
  at_mentioned (own/preview)   │ pin previewSelection for 5s, lastSource = 'preview'
  at_mentioned (from Cursor)   │ pin lastSource = 'cursor' for 5s
```

After the pin window expires, normal tracking resumes.

### 5.6 Notification forwarding

Both sources produce notifications that Claude should receive:

| Source | Notification | Proxy action |
|--------|-------------|--------------|
| Ask Markdown preview | `selection_changed` | Send to Claude directly (already wired) |
| Ask Markdown preview | `at_mentioned` | Send to Claude directly + pin preview selection |
| Cursor | `selection_changed` | Forward to Claude + update lastSource (if not pinned) |
| Cursor | `at_mentioned` | Forward to Claude + pin lastSource = 'cursor' |

Notifications have no `id` — they are fire-and-forget in both directions. No ID remapping needed.

This is the key payoff of the proxy: Claude always sees the right selection regardless of which surface the user interacted with.

### 5.5 Schema merging for `tools/list`

The proxy's `tools/list` response must present a single schema per tool name. For forwarded-to-Cursor tools, use Cursor's schema verbatim (including `execution` and `annotations` fields). For locally-handled tools, use Ask Markdown's schema. For `openFile` (hybrid routing), present a merged schema that includes both Ask Markdown's optional params and Cursor's extra params.

---

## 6. Impact on Cursor's existing functionality

This is the critical section. Will the proxy break anything Cursor is already doing?

### 6.1 Cursor's integrated terminal — NOT affected

When the user runs `claude` inside Cursor's built-in terminal, `CLAUDE_CODE_SSE_PORT` is set to Cursor's port (e.g., 22663). Claude connects directly to Cursor's server. **It never looks at lock files.** Deleting Cursor's lock file has zero effect on this path.

Cursor's own Claude integration works exactly as before.

### 6.2 Cursor's WebSocket server — gains one client

The proxy connects to Cursor as a WebSocket client. Cursor's server already handles multiple concurrent connections (multiple Claude sessions, `/ide` pickers, etc.). One more client is indistinguishable from another Claude session. Cursor doesn't behave differently.

### 6.3 Cursor's lock file — deleted, but Cursor doesn't read it

The lock file is written by Cursor for Claude to discover. **Cursor itself never reads its own lock file after writing it.** Deleting it removes the discovery path for external-terminal Claude — which is intentional, because the proxy is taking over that role.

Cursor may recreate the lock file on:
- Window reload (`Developer: Reload Window`)
- Extension host restart
- Crash recovery

The proxy watches the directory with `fs.watch` and handles reappearance (reconnect, re-delete). See section 8 for lifecycle details.

### 6.4 Cursor's features — no degradation

| Cursor feature | Impact |
|----------------|--------|
| Inline editing | Unaffected — runs inside Cursor's process |
| Tab management | Unaffected |
| Terminal integration | Unaffected — uses `CLAUDE_CODE_SSE_PORT` |
| LSP / diagnostics | Unaffected — Cursor still serves them |
| File watching | Unaffected |
| Jupyter / executeCode | Unaffected — kernel lives in Cursor's process |

### 6.5 What actually changes

1. **External-terminal `claude` connects to Ask Markdown instead of Cursor.** This is the goal, not a side effect. Claude gets merged tools.
2. **Cursor's lock file is absent.** If Ask Markdown is disabled/uninstalled without cleanup, the user must restart Cursor to regenerate the lock file. This is the main risk and should be handled gracefully (see 8.3).
3. **Slightly higher resource use.** One extra WebSocket connection and JSON-RPC message forwarding. Negligible.

### 6.6 Summary

The proxy adds a client to Cursor's server and removes its lock file. Cursor's own behavior is fully determined by its internal state (the extension host, the editor, the terminal env vars), none of which depend on the lock file existing. **Nothing breaks.**

---

## 7. The CLAUDE_CODE_SSE_PORT gap

### 7.1 The problem

When the user runs `claude` inside Cursor's integrated terminal, `CLAUDE_CODE_SSE_PORT=22663` points Claude directly at Cursor's server. The proxy's lock file manipulation has no effect. Claude gets only Cursor's tools — no preview-aware selections.

This means:
- **User selects text in Ask Markdown preview → clicks "Claude" → types question in Cursor's terminal → Claude calls `getCurrentSelection` → gets Cursor's code editor selection, not the preview selection.**

The preview selection is lost.

### 7.2 Option A: `EnvironmentVariableCollection` override

VS Code extensions can modify terminal environment variables:

```ts
const env = context.environmentVariableCollection;
env.replace('CLAUDE_CODE_SSE_PORT', String(proxyPort));
```

This would make all new terminals (including Cursor's) set `CLAUDE_CODE_SSE_PORT` to Ask Markdown's port. Claude started in any terminal connects to the proxy.

**Pros:** Covers both external and Cursor terminals. Complete solution.

**Cons:**
- Aggressive — hijacks Cursor's env var for all terminals in this workspace.
- If Ask Markdown extension is disabled, `CLAUDE_CODE_SSE_PORT` points to a dead port. New terminals can't connect to anything until Cursor reloads.
- Multiple workspaces with different proxy ports would conflict (env var is process-wide, not per-workspace).
- May interact unpredictably with Cursor's own setting of this variable.

### 7.3 Option B: Accept the limitation

The proxy only covers the external-terminal path. Inside Cursor's terminal, Claude connects to Cursor directly. The user must use the `TERM_PROGRAM= claude` workaround in Cursor's terminal if they want the merged server.

This matches the current behavior — the workaround already exists and is documented in the README. The proxy improves the external-terminal case (no more `/ide` manual picker) without regressing the Cursor-terminal case.

### 7.4 Option C: Selective override

Only set `CLAUDE_CODE_SSE_PORT` when the proxy has a healthy upstream connection to Cursor. Clear it if the connection drops. This narrows the blast radius of Option A.

```ts
if (cursorUpstreamConnected) {
  env.replace('CLAUDE_CODE_SSE_PORT', String(proxyPort));
} else {
  env.delete('CLAUDE_CODE_SSE_PORT');
  // Cursor's next terminal spawn will use its own default
}
```

**Pros:** Claude in Cursor's terminal gets merged tools when the proxy is healthy.

**Cons:** Env changes only apply to **newly opened** terminals. Existing terminals keep their old env. The user might need to open a new terminal after the proxy starts.

### 7.5 Recommendation

Start with **Option B**. The proxy already solves the primary annoyance (external-terminal users having to manually `/ide` pick). The Cursor-terminal path works as-is with the existing workaround. Option C is a nice follow-up if the manual workaround proves too annoying, but it adds complexity and needs careful testing against Cursor's own env-var behavior.

---

## 8. Lifecycle and failure modes

### 8.1 Normal startup

```
Time 0    Cursor is running. Lock file exists: 22663.lock (Cursor)
Time 1    Ask Markdown activates. Starts server on port 52353.
Time 2    Scans lock dir. Finds 22663.lock → ideName: "Cursor", same workspace.
Time 3    Connects to ws://127.0.0.1:22663. Sends initialize + tools/list.
Time 4    Cursor responds with 12 tools. Proxy caches them.
Time 5    Proxy renames 22663.lock → 22663.lock.proxied (preserves for restore).
Time 6    Proxy writes 52353.lock (as today).
Time 7    Next `claude` session in an external terminal finds only 52353.lock.
          Connects to Ask Markdown proxy. Gets merged tools. Done.
```

### 8.2 Cursor restarts or reloads window

```
Time 0    Proxy is running, connected to Cursor on port 22663.
Time 1    User reloads Cursor window (Cmd+Shift+P → Reload Window).
Time 2    Cursor's WS server shuts down. Proxy detects disconnect.
Time 3    Proxy marks upstream as disconnected. Falls back to own tools only.
          Claude sessions in progress lose forwarded tools gracefully
          (proxy returns "IDE not connected" errors for forwarded tools).
Time 4    Cursor restarts. May get a new port (e.g., 33100).
          Writes 33100.lock.
Time 5    Proxy's fs.watch fires. Finds new Cursor lock file.
Time 6    Proxy connects to ws://127.0.0.1:33100. Re-fetches tools/list.
Time 7    Proxy renames 33100.lock → 33100.lock.proxied.
Time 8    Merged serving resumes. In-progress Claude sessions that are still
          connected to the proxy now get forwarded tools again.
```

Key: the proxy must handle port changes gracefully. Cursor doesn't guarantee the same port across restarts.

### 8.3 Ask Markdown crashes (or is disabled)

```
Time 0    Proxy is running. 22663.lock.proxied exists. 52353.lock exists.
Time 1    Ask Markdown crashes. Port 52353 goes dead.
Time 2    52353.lock becomes stale. Claude's pid-liveness check will detect this.
Time 3    22663.lock.proxied still exists — Cursor's original lock file.
```

**Problem:** Claude in an external terminal finds 52353.lock (stale) and no Cursor lock file. Connection fails.

**Mitigation:** On `deactivate()` (which VS Code calls for graceful shutdown, disable, and uninstall):
1. Remove the proxy's own lock file (already done today).
2. Restore Cursor's lock file: rename `.lock.proxied` back to `.lock`.
3. Close the upstream WebSocket connection.

For hard crashes (SIGKILL, extension host crash), `deactivate()` doesn't run. Claude will detect the stale lock file via pid check and ignore it. Eventually Cursor will recreate its own lock file (on next window focus/reload). Gap window: Claude can't connect to any IDE from an external terminal until either:
- Cursor recreates its lock file, or
- The user reloads the VS Code window (which restarts Ask Markdown, which cleans up).

This gap is acceptable — it's the same situation as if Ask Markdown wasn't installed at all and Cursor happened to crash.

### 8.4 Cursor not running (Ask Markdown in standalone VS Code)

No Cursor lock file found. Proxy mode doesn't activate. Ask Markdown serves its own tools only, exactly as today. Zero change in behavior.

### 8.5 Lock file race condition

Cursor may recreate its lock file at any time (extension host restart, settings change, etc.). The proxy watches the directory and re-proxies new lock files. But there's a window between Cursor writing the file and the proxy deleting it where Claude could discover both. Since Claude picks one per conversation, the worst case is that a single new conversation connects to Cursor directly instead of the proxy — it still works, just without merged tools for that session.

### 8.6 Multiple IDE instances

If the user has multiple Cursor windows for the same workspace (unusual but possible), each writes its own lock file. The proxy should pick the one that matches and has a live pid. If multiple match, pick the first — the user likely only has one meaningful Cursor window per workspace.

---

## 9. JSON-RPC forwarding mechanics

### 9.1 ID remapping

Claude sends requests with its own `id` values. The proxy forwards to Cursor with remapped IDs to avoid collisions with the proxy's own requests to Cursor (e.g., `tools/list` during startup).

```
Claude → Proxy:  { "id": 7,  "method": "tools/call", "params": { "name": "getDiagnostics" } }
Proxy → Cursor:  { "id": "p-7", "method": "tools/call", "params": { "name": "getDiagnostics" } }
Cursor → Proxy:  { "id": "p-7", "result": { ... } }
Proxy → Claude:  { "id": 7,  "result": { ... } }
```

A `Map<string, number|string>` of proxy-id → original-id handles the mapping. Entries are deleted after the response arrives.

### 9.2 Blocking tools (`openDiff`)

Cursor's `openDiff` blocks until the user saves or closes the diff tab. The proxy must keep the forwarded request's promise open for the entire duration:

```
Claude → Proxy:  tools/call openDiff (id: 7)
Proxy → Cursor:  tools/call openDiff (id: "p-7")
         ... user reviews diff for 30 seconds ...
Cursor → Proxy:  { id: "p-7", result: { content: [{ text: "FILE_SAVED" }] } }
Proxy → Claude:  { id: 7, result: { content: [{ text: "FILE_SAVED" }] } }
```

No timeout on the proxy's side — the response comes when Cursor sends it. The proxy just holds the mapping entry open.

### 9.3 Error propagation

If Cursor returns a JSON-RPC error, the proxy relays it unchanged (after remapping the `id`). If the upstream WebSocket is disconnected when a forwarded tool is called, the proxy returns:

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "result": {
    "content": [{ "type": "text", "text": "Error: upstream IDE (Cursor) is not connected" }],
    "isError": true
  }
}
```

This is a tool-level error, not a JSON-RPC error — Claude handles it gracefully.

### 9.4 Notification forwarding

Notifications (no `id`) from Cursor are forwarded to all connected Claude clients. Each notification also updates the unified selection state (section 5.4):

```
Cursor → Proxy:  { "method": "selection_changed", "params": { ... } }
  Proxy: if not in pin window → lastSource = 'cursor'
  Proxy → Claude:  forward as-is

Cursor → Proxy:  { "method": "at_mentioned", "params": { ... } }
  Proxy: pin lastSource = 'cursor' for 5s
  Proxy → Claude:  forward as-is

Ask Markdown preview → Proxy (internal):  at_mentioned
  Proxy: pin previewSelection for 5s, pinnedSource = 'preview'
  Proxy → Claude:  send at_mentioned (already wired in previewProvider.ts)
```

The pin window (section 5.5) prevents stale `selection_changed` events from the other source from flipping the state during the "click Claude → type question → Claude calls tool" transition.

---

## 10. Implementation punch list

### 10.1 New file: `src/cursorProxy.ts`

The proxy layer. Responsibilities:

- **`discoverCursor()`** — Scan lock dir for Cursor lock files matching the workspace. Return `{ port, authToken }` or `null`.
- **`connectUpstream(port, authToken)`** — Open WebSocket client to Cursor. Send `initialize` + `tools/list`. Cache the tool list. Set up message forwarding.
- **`disconnectUpstream()`** — Close the client WebSocket. Mark upstream as disconnected.
- **`mergedToolsList(ownTools, cursorTools)`** — Produce the union of tool schemas, applying the routing table from section 5.
- **`routeToolCall(name, args)`** — Given a `tools/call`, decide: handle locally (return to `handleToolCall`) or forward to Cursor (send over upstream WS, return a promise that resolves when Cursor responds).
- **`forwardNotification(method, params)`** — Forward a notification from Cursor to all connected Claude clients.

### 10.2 Changes to `src/claudeServer.ts`

- Import and initialize the proxy on `startServer()`.
- In `handleToolsList()`: if proxy is active, return `mergedToolsList()` instead of the static list.
- In `handleMessage()` for `tools/call`: call `routeToolCall()` first. If it returns "forward," send to Cursor; if "local," handle as today.
- In `stopServer()`: call `disconnectUpstream()` and restore Cursor's lock file.

### 10.3 Lock file management

- After connecting to Cursor: rename `{cursor_port}.lock` to `{cursor_port}.lock.proxied`.
- On deactivate: rename back.
- `fs.watch` on lock dir: detect new Cursor lock files (port changes after reload).

### 10.4 Unified selection state with pin window

Module-scope state in `cursorProxy.ts`:

```ts
interface SelectionState {
  preview: LatestSelection | null;       // from Ask Markdown's preview
  lastSource: 'cursor' | 'preview';
  pinnedSelection: LatestSelection | null;  // snapshot at at_mentioned time
  pinnedSource: 'cursor' | 'preview' | null;
  pinnedAt: number;                      // timestamp, 0 = no pin
}

const PIN_WINDOW_MS = 5000;
```

Updated by:
- Cursor's `selection_changed` → if not in pin window: `lastSource = 'cursor'`
- Ask Markdown's `syncSelection` → if not in pin window: `lastSource = 'preview'`, update `preview`
- Own `at_mentioned` (preview Claude button) → pin `preview` selection, `pinnedSource = 'preview'`
- Cursor's `at_mentioned` (forwarded) → pin `lastSource = 'cursor'`, `pinnedSource = 'cursor'`

Read by:
- `getCurrentSelection` / `getLatestSelection`:
  1. If pinned and within window → if `pinnedSource == 'preview'` return local, else forward to Cursor
  2. Else if `lastSource == 'preview'` → return local preview selection
  3. Else → forward to Cursor (it handles `.ts`, `.py`, everything non-preview)

### 10.5 Estimated scope

| Component | Lines (est.) | Complexity |
|-----------|-------------|-----------|
| `cursorProxy.ts` (discovery + WS client + routing) | ~250 | Medium — WebSocket client, async reconnect, fs.watch |
| `claudeServer.ts` changes | ~50 | Low — wiring proxy into existing handlers |
| Lock file management | ~40 | Low — rename + watch |
| Selection state | ~30 | Low — two slots + timestamp |
| **Total** | **~370** | |

No new dependencies — `ws` (already used for the server) works as a client too.

---

## 11. Alternatives considered

### 11.1 Change `ideName` to `"Cursor"`

Make Ask Markdown pretend to be Cursor by setting `ideName: "Cursor"` in the lock file. Claude might then select Ask Markdown when it would have selected Cursor.

**Why not:** This doesn't merge the tools — it just changes which single tool set Claude sees. And if Claude's selection heuristic uses port or pid, it won't help.

### 11.2 Keep both lock files, let Claude pick

Accept the current situation. Use `/ide` to manually select Ask Markdown when needed.

**Why not:** The user must run `/ide` at the start of every conversation. And they can never have both tool sets simultaneously.

### 11.3 Patch Claude Code to support multiple IDEs

The cleanest solution: Claude connects to all matching lock files and unions their tools.

**Why not:** We don't control Claude Code. The one-server constraint is Claude's decision.

### 11.4 Ask Markdown embeds Cursor's tools natively

Re-implement `getDiagnostics`, `executeCode`, etc. inside Ask Markdown, calling VS Code APIs directly.

**Why not:** Massive duplication. Cursor's IDE integration is hundreds of lines of battle-tested code. And Ask Markdown would need to stay in sync with Cursor's updates. The proxy approach delegates to Cursor and gets updates for free.

### 11.5 Reverse proxy: make Cursor forward to Ask Markdown

Instead of Ask Markdown proxying Cursor, have Cursor proxy Ask Markdown. This would require modifying Cursor's behavior, which we can't do (closed-source extension).

**Why not:** We can't modify Cursor's IDE server.

---

## 12. Open questions

### 12.1 Claude's lock file selection heuristic

When multiple lock files match the same workspace, how does Claude pick? Options: alphabetical port, newest file mtime, `ideName` priority, first match. We've confirmed it picks one — but not which one or why. This matters because if Claude always prefers `ideName: "Cursor"`, then simply renaming our lock file to `ideName: "Cursor"` (without proxying) might steal the slot. But we'd lose Cursor's tools.

**How to test:** Create two dummy lock files for the same workspace with different `ideName` values and different ports. Run `claude` and see which one `/ide` selects by default.

### 12.2 `CLAUDE_CODE_SSE_PORT` interaction with `EnvironmentVariableCollection`

If Ask Markdown sets `CLAUDE_CODE_SSE_PORT` via `EnvironmentVariableCollection`, does Cursor's own setting override it, or vice versa? The precedence of extension-set env vars vs Cursor-set env vars is not documented. This must be tested before attempting Option C from section 7.

### 12.3 `tools/list` changes mid-conversation

If the proxy connects to Cursor mid-conversation (e.g., Cursor starts after Claude is already connected), the tool set changes. The MCP protocol supports `tools: { listChanged: true }` — the proxy could send a `notifications/tools/list_changed` notification to Claude. But does Claude Code actually re-fetch `tools/list` in response? If not, newly discovered Cursor tools won't be available until the next conversation.

### 12.4 What happens to in-flight requests when Cursor disconnects?

If Cursor's WebSocket drops while a `tools/call` is being forwarded, the proxy holds an unresolved promise. It should detect the disconnect and resolve with an error: `{ isError: true, content: [{ text: "upstream disconnected" }] }`. But the timing is tricky — `ws` emits `close` after the TCP teardown, which may lag behind the actual failure.

### 12.5 Thread safety of lock file operations

`fs.watch` callbacks and the proxy's startup scan can race. If `fs.watch` fires while startup is already handling the same file, the proxy might try to connect twice. A simple boolean lock (`isConnecting`) prevents this, but the sequencing needs care.
