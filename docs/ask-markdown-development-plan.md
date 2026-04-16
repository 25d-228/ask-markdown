# ask-markdown Development Plan

## What this project is

ask-markdown is a VS Code / Cursor extension that opens `.md` files in a rendered custom editor with LaTeX support, syntax-highlighted code blocks, and a toggleable inline source editor. Users can select text in the rendered preview, and a floating action bar appears with buttons to send the selection to Claude Code or jump to the corresponding source lines. The extension runs a local MCP WebSocket server that Claude Code CLI connects to, and it **proactively broadcasts the current selection** to Claude Code whenever it changes — so when the user Tab-switches to their `claude` terminal and asks "explain this", Claude already knows exactly which passage they're looking at. It is the founding member of the "ask-*" extension family, with ask-svg and ask-pdf following the same architecture and UX patterns.



Markdown files are already text, so Claude Code can read them directly — no sidecar is needed. Every MCP message references the real `.md` file path with line numbers derived from `data-source-line` attributes injected into the rendered HTML. An inline editor lets users edit the raw markdown without leaving the extension tab, with changes syncing back in real time.


## Repository layout

Current state (as of v0.3.1):

```text
ask-markdown/
├── .gitignore
├── .vscode/
│   ├── extensions.json
│   ├── launch.json
│   ├── settings.json
│   └── tasks.json
├── .vscode-test.mjs              (test runner config)
├── .vscodeignore
├── ask-markdown-development-plan.md  (this file)
├── LICENSE
├── README.md
├── dist/
│   └── extension.js              (esbuild output)
├── esbuild.js
├── eslint.config.mjs
├── media/
│   ├── icon.png
│   ├── preview.css
│   └── preview.js
├── package.json
├── package-lock.json
├── releases/
│   ├── ask-markdown-0.0.1.vsix
│   ├── ...
│   └── ask-markdown-0.3.1.vsix
├── src/
│   ├── claudeServer.ts           (MCP WebSocket server + JSON-RPC router + tools)
│   ├── extension.ts              (activation, commands, tab management, server lifecycle)
│   ├── previewProvider.ts        (CustomTextEditorProvider, markdown-it, webview HTML, message handling)
│   ├── sourceMapper.ts           (toRange utility)
│   └── test/
│       ├── extension.test.ts     (scaffold)
│       ├── renderRule.test.ts    (data-source-line injection tests)
│       └── sourceMapper.test.ts  (toRange edge case tests)
└── tsconfig.json
```

All commands run from the repo root `/Users/ip33/Documents/GitHub/ask-markdown`.

---

## Phase 1 — Project setup [DONE]

**Goal:** The project compiles, lints, and produces a bundled extension that activates on markdown files.

**What was built:** [.gitignore](.gitignore), [package.json](package.json) (v0.0.1, `activationEvents: ["onLanguage:markdown"]`, `customEditors` contribution), [tsconfig.json](tsconfig.json) (`module: "Node16"`, `target: "ES2022"`, `strict: true`), [eslint.config.mjs](eslint.config.mjs), [esbuild.js](esbuild.js) (bundles `src/extension.ts` to `dist/extension.js`, CJS format, external `vscode`), [src/extension.ts](src/extension.ts) (logs `[ask-markdown] activated`), [.vscodeignore](.vscodeignore), [.vscode-test.mjs](.vscode-test.mjs).

**Commit:** `292aff7`.

---

## Phase 2 — Rendered markdown preview [DONE]

**Goal:** Opening a `.md` file with "Open With → Ask Markdown" shows a tab with the rendered markdown on a theme-aware background, with syntax-highlighted code blocks and LaTeX math.

**What was built:** [src/previewProvider.ts](src/previewProvider.ts) (`AskMarkdownEditorProvider` implementing `CustomTextEditorProvider`, `buildHtml` with CSP, `createMarkdownIt` factory), [media/preview.css](media/preview.css) (theme-aware styles using VS Code CSS variables, typography, code blocks, tables), [media/preview.js](media/preview.js) (basic preview rendering).

**Dependencies:** `markdown-it` (core renderer), `highlight.js` (fenced code block syntax highlighting), `katex` + `markdown-it-texmath` (LaTeX math: inline `$...$` and display `$$...$$`).

**Commit:** `f398dc1`.

---

## Phase 3 — Source map injection and click-to-jump [DONE]

**Goal:** Every block-level element in the rendered markdown carries `data-source-line` and `data-source-line-end` attributes computed from `token.map`. Double-clicking any block jumps to its source line in a side-by-side text editor.

**What was built:** [src/sourceMapper.ts](src/sourceMapper.ts) (`toRange` — converts zero-based line range to `vscode.Range`, clamped to document bounds, handles NaN/negative/reversed/overflow), [src/previewProvider.ts](src/previewProvider.ts) (render rule overrides for `paragraph_open`, `heading_open`, `bullet_list_open`, `ordered_list_open`, `list_item_open`, `blockquote_open`, `table_open`, `hr`, `fence`, `code_block`, and `math_block`; `revealInSourceEditor` that opens the file in `ViewColumn.Beside` and selects the range), [media/preview.js](media/preview.js) (`findSourceElement` walker, `dblclick` handler posting `revealSource` messages).

### 3.1 Create src/sourceMapper.ts

Create [src/sourceMapper.ts](src/sourceMapper.ts) with a `toRange` function that converts a zero-based inclusive line range into a `vscode.Range` covering the full text of those lines.

Edge cases handled:
1. Out-of-range values clamped to `[0, doc.lineCount - 1]`.
2. `endLine < startLine` after clamping → swap.
3. `NaN` defaults to 0.
4. End position uses end-of-line column so the entire last line is selected.

**Result:** Utility for safe line-range-to-Range conversion.

**Verify:**
```bash
npm run check-types
```

### 3.2 Inject source map attributes into rendered HTML

Update [src/previewProvider.ts](src/previewProvider.ts).

Override markdown-it render rules for all block-level token types. For each token with a `map`, inject `data-source-line` (1-based start) and `data-source-line-end` (end) as HTML attributes. The `math_block` rule from texmath needs special handling — wrap the rendered output in a `<div>` with the attributes since the plugin doesn't use standard opening tokens.

The `createMarkdownIt` factory is exported so tests can access it.

**Result:** Every block in the rendered HTML carries line metadata.

**Verify:** Open a markdown file, inspect the DOM — every `<p>`, `<h1>`, `<ul>`, `<table>`, etc. has `data-source-line` attributes.

### 3.3 Add double-click-to-jump handler

Update [media/preview.js](media/preview.js).

Add a `findSourceElement(node)` function that walks up the DOM from any node to the nearest ancestor with `data-source-line`. On `dblclick` in preview mode (excluding toolbar and action bar), find the source element and post `{ type: 'revealSource', line, endLine }` to the extension host.

In [src/previewProvider.ts](src/previewProvider.ts), handle `revealSource` by calling `revealInSourceEditor`, which opens the file with the default editor in `ViewColumn.Beside` and selects the corresponding range.

**Result:** Double-clicking any rendered block opens the source with that block highlighted.

**Verify:** Open a markdown file in the preview. Double-click a paragraph. The text editor opens beside the preview with the paragraph's lines selected.

### Test method

**What to test:** Source line attributes are present on all block types. Double-click navigates to the correct source lines.

**How to test:** Open a markdown file with headings, paragraphs, lists, code blocks, tables, and math. Inspect DOM for `data-source-line` attributes. Double-click each block type and verify the source editor highlights the correct lines.

**Expected result:** All block types carry line attributes. Double-click opens source at the correct position.

### What was implemented

After completing this phase, tell the user:

- Which files were created or changed.
- What the system can now do that it could not do before this phase.
- How to verify it works (repeat the key verify command).

---

## Phase 4 — Floating action bar and selection detection [DONE]

**Goal:** When text is selected in the rendered preview, a floating bar appears near the selection with `Claude` and `Find in source` buttons. Clicking `Find in source` toggles to the source view with the selected lines highlighted.

**What was built:** [media/preview.js](media/preview.js) (`showBar`, `hideBar`, `previewSelectionRange`, selection detection via `selectionchange`/`mouseup`/`select` events), [media/preview.css](media/preview.css) (`#ask-bar` styles, `[data-source-line]:hover` dashed outline), [src/previewProvider.ts](src/previewProvider.ts) (`updateShowFloatingButton` message), [package.json](package.json) (`askMarkdown.showFloatingButton` setting).

### 4.1 Build the floating action bar in the webview

Add to [media/preview.js](media/preview.js):

The `#ask-bar` is pre-built in the HTML (not dynamically created) with two buttons: `<button data-action="claude">Claude</button>` and `<button data-action="find">Find in source</button>`, separated by a `<span class="ask-bar-sep">`. The bar is `display: none` by default.

`showBar()` reads the current selection via `previewSelectionRange()`. If non-empty, it positions the bar above the selection's bounding rectangle (`position: fixed`, `rect.top - bar.offsetHeight - 6`). Also posts `{ type: 'syncSelection', text, startLine, endLine }` to the extension host so the selection state is always current.

`hideBar()` hides the bar and posts `{ type: 'previewSelectionCleared' }` to clear the selection state.

**Result:** Selecting text shows the bar near it.

**Verify:** Select text in the preview. A small two-button bar appears just above the selection.

### 4.2 Wire selection detection events

Add to [media/preview.js](media/preview.js):

Listen for `selectionchange` (debounced 200ms), `mouseup` (50ms delay), and `select` on the textarea. On each, call `showBar()` if there's a non-empty selection, `hideBar()` otherwise. Guard against the toolbar and bar itself receiving clicks.

`previewSelectionRange()` walks `window.getSelection()`, finds the `data-source-line` ancestor for both anchor and focus nodes, and returns `{ text, startLine, endLine }` spanning the full line range.

**Result:** The bar appears and disappears reliably as the user selects and deselects text.

**Verify:** Select text — bar appears. Click elsewhere — bar disappears. Select across multiple blocks — bar covers the full range.

### 4.3 Add the showFloatingButton setting

Add to [package.json](package.json) `contributes.configuration`:

```json
{
  "title": "Ask Markdown",
  "properties": {
    "ask-markdown.showFloatingButton": {
      "type": "boolean",
      "default": true,
      "description": "Show the floating action bar (Claude / Find in source) when text is selected in the preview."
    }
  }
}
```

In the provider, post `{ type: 'updateShowFloatingButton', enabled }` on activate and on `onDidChangeConfiguration`. In `preview.js`, honour the flag via `bar.dataset.enabled` — when `'false'`, `showBar()` returns immediately.

**Result:** Setting toggles bar visibility.

**Verify:** `Ctrl+,` → search `ask-markdown.showFloatingButton` → uncheck. Select text; no bar appears. Re-enable; it returns.

### 4.4 Style the action bar

Update [media/preview.css](media/preview.css).

Style `#ask-bar` with `position: fixed`, `z-index: 100`, VS Code widget background/border colours, rounded corners, subtle shadow. Buttons are transparent with hover highlight. Add a `.ask-bar-sep` vertical divider between them. Add `[data-source-line]:hover` with a dashed outline to give hover feedback on clickable blocks.

**Result:** Bar and hover outlines match the VS Code widget aesthetic.

**Verify:** Visual inspection across light and dark themes.

### Test method

**What to test:** Bar shows/hides correctly, Find in source navigates, setting toggle works.

**How to test:** Select text — bar appears. Click Find in source — source view opens with selection. Toggle the setting off — bar stops appearing.

**Expected result:** Bar positions correctly near the selection. Setting toggles visibility without reload.

### What was implemented

After completing this phase, tell the user:

- Which files were created or changed.
- What the system can now do that it could not do before this phase.
- How to verify it works (repeat the key verify command).

---

## Phase 5 — MCP server foundation [DONE]

**Goal:** Claude Code CLI can find and connect to ask-markdown, complete the MCP handshake, and receive an `at_mentioned` notification when the user clicks the "Claude" button.

**What was built:** [src/claudeServer.ts](src/claudeServer.ts) (lock file at `~/.claude/ide/{port}.lock`, HTTP server on `127.0.0.1:0`, WebSocket upgrade with auth token, JSON-RPC dispatcher for `initialize`/`notifications/initialized`/`prompts/list`/`tools/list`/`tools/call`, `broadcast`/`isConnected`/`startServer`/`stopServer`), [src/extension.ts](src/extension.ts) (server lifecycle), [src/previewProvider.ts](src/previewProvider.ts) (`at_mentioned` broadcast on Claude button click).

**Dependency:** `ws@^8.20.0`, `@types/ws@^8.18.1`.

### 5.1 Write claudeServer.ts

Create [src/claudeServer.ts](src/claudeServer.ts) with a `startServer`/`stopServer` pair that owns all WebSocket + lock-file state. The preview provider only imports `broadcast`, `isConnected`, and `updateLatestSelection` from this module.

`startServer` must:

1. Generate an auth token via `crypto.randomUUID()`.
2. Create an `http.createServer()` and a `WebSocketServer({ noServer: true })`.
3. On `upgrade`, reject any connection whose `x-claude-code-ide-authorization` header does not match the token (`401 Unauthorized` + destroy).
4. Listen on port `0` on `127.0.0.1` so the OS picks a free port.
5. Once listening, write `~/.claude/ide/<port>.lock` with JSON fields `pid`, `workspaceFolders`, `ideName: 'Ask Markdown'`, `transport: 'ws'`, `runningInWindows: process.platform === 'win32'`, and `authToken`.
6. Track connected clients in a `Set<WebSocket>` so `broadcast(method, params)` can fan out JSON-RPC notifications.

`handleMessage(ws, data)` parses each incoming line as JSON-RPC and dispatches:

- `initialize` — Reply with `protocolVersion: '2024-11-05'`, `capabilities: { tools: { listChanged: true } }`, `serverInfo: { name: 'ask-markdown', version: '0.0.1' }`.
- `notifications/initialized` — No response.
- `prompts/list` — Reply with `{ prompts: [] }`.
- `tools/list` — Reply with the tool list (Phase 6).
- `tools/call` — Dispatch to tool handlers (Phase 6).
- Any other method with an `id` — Reply with error `-32601 Method not found`.

`stopServer` removes the lock file, closes every client, and shuts down the server.

**Result:** A functional MCP server module.

**Verify:**
```bash
npm run check-types
```

### 5.2 Start/stop the server from extension.ts

Edit [src/extension.ts](src/extension.ts) to import `startServer`/`stopServer` and call them in `activate`/`deactivate`. Fire-and-forget the start:

```ts
startServer().then((port) => {
  console.log(`[ask-markdown] Claude server ready on port ${port}`);
}).catch((err) => {
  console.error('[ask-markdown] Failed to start Claude server:', err);
});
```

`deactivate` calls `stopServer()` synchronously.

**Result:** Lock file is written on activation and removed on deactivation.

**Verify:** Launch dev host, then:
```bash
ls ~/.claude/ide/*.lock | xargs cat | grep '"ideName"'
```
Prints a line including `"ideName":"Ask Markdown"`.

### 5.3 Wire the Claude button to at_mentioned

Update [src/previewProvider.ts](src/previewProvider.ts).

In the message handler, on `askClaude`:

```ts
if (!isConnected()) {
  vscode.window.showWarningMessage(
    'Ask Markdown: No Claude CLI connected. Run "claude" in a terminal first.',
  );
  return;
}
broadcast('at_mentioned', {
  filePath: document.uri.fsPath,
  lineStart: startLine,
  lineEnd: endLine,
});
vscode.commands.executeCommand('workbench.action.terminal.focus');
```

**Result:** Clicking the Claude button broadcasts the selection and focuses the terminal.

**Verify:** Connect Claude Code via `/ide`. Select text, click Claude. The terminal focuses and Claude Code receives `@file.md:10-20`.

### 5.4 End-to-end /ide handshake

In the dev host's integrated terminal:

```bash
claude
```

Inside Claude Code:

```
/ide
```

Select `Ask Markdown`. Ask Claude: `what file am I in?`. Claude calls `getOpenEditors` and gets the markdown path.

**Result:** Claude Code is connected to the extension's MCP server.

**Verify:** Claude's response mentions the markdown file path.

### Test method

**What to test:** The lock file is well-formed; MCP handshake completes; `at_mentioned` fires on Claude button click.

**How to test:** Launch dev host, verify lock file exists, connect Claude Code via `/ide`, click Claude button, confirm the terminal receives the file reference.

**Expected result:** `initialize` returns `serverInfo.name === 'ask-markdown'`. Claude button sends `at_mentioned` with file path and line range.

### What was implemented

After completing this phase, tell the user:

- Which files were created or changed.
- What the system can now do that it could not do before this phase.
- How to verify it works (repeat the key verify command).

---

## Phase 6 — MCP tools and proactive selection broadcasting [DONE]

**Goal:** Claude Code gets live selection context without polling. The user selects text in the preview, `selection_changed` fires over WebSocket, and Claude Code can call seven MCP tools to query state on demand.

**What was built:** [src/claudeServer.ts](src/claudeServer.ts) (`LatestSelection` interface, `latestSelection` state, `updateLatestSelection`, seven tools: `getCurrentSelection`, `getLatestSelection`, `getOpenEditors`, `getWorkspaceFolders`, `getDiagnostics`, `openFile`, `openDiff`), [src/previewProvider.ts](src/previewProvider.ts) (`syncSelection` handler calling `updateLatestSelection` and broadcasting `selection_changed`, `previewSelectionCleared` handler broadcasting empty selection).

### 6.1 Implement the tool set

Inside [src/claudeServer.ts](src/claudeServer.ts), register these tools in `handleToolsList` and implement handlers in `handleToolCall`:

| Tool                    | Description                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| `getCurrentSelection`   | Returns the active text editor's selection. Falls back to nothing if no text editor is active.       |
| `getLatestSelection`    | Returns the most recent non-empty selection even after focus moves to the terminal.                  |
| `getDiagnostics`        | Returns an empty list (markdown has no language diagnostics).                                        |
| `getOpenEditors`        | Returns every open tab's `fsPath` by walking `vscode.window.tabGroups.all`.                         |
| `getWorkspaceFolders`   | Returns `workspace.workspaceFolders.map(f => f.uri.fsPath)`.                                        |
| `openFile`              | Opens a file; `.md`/`.mdx` files open in the Ask Markdown preview, others in the default editor.    |
| `openDiff`              | Writes proposed contents to a temp file, opens `vscode.diff`, resolves on save or close.            |

**Result:** Tool handlers wired into the JSON-RPC dispatcher.

**Verify:** `npm run check-types` exits 0.

### 6.2 Broadcast selection changes

On every text selection in the preview, `preview.js` posts `{ type: 'syncSelection', text, startLine, endLine }`. In the provider, handle it by:

1. Resolving the selection to a `vscode.Range` via `toRange`.
2. Moving the cursor in any visible source editor to match.
3. Building a `LatestSelection` payload with `text`, `filePath`, `fileUrl`, and `selection` (LSP-style start/end positions).
4. Calling `updateLatestSelection(payload)` to save the latest selection.
5. If connected, calling `broadcast('selection_changed', payload)`.

On `previewSelectionCleared`, broadcast an empty selection payload.

**Result:** Claude Code's `getLatestSelection` tool returns the last selection even after focus moves.

**Verify:** Select text in the preview. Focus the terminal. Ask Claude "what did I just select?". Claude calls `getLatestSelection` and reports the passage.

### Test method

**What to test:** `tools/list` returns all seven tools. `getCurrentSelection` returns `success: false` when nothing is selected. `selection_changed` fires on preview selection. `getLatestSelection` persists after focus moves.

**How to test:** Connect via `/ide`. Select text in the preview. Ask Claude about the selection. Clear the selection. Ask again — `getLatestSelection` still returns the previous selection.

**Expected result:** Tools return expected data. Selection broadcasting works. `getLatestSelection` persists.

### What was implemented

After completing this phase, tell the user:

- Which files were created or changed.
- What the system can now do that it could not do before this phase.
- How to verify it works (repeat the key verify command).

---

## Phase 7 — Live reload and bidirectional scroll sync [DONE]

**Goal:** Editing the `.md` file in a text editor updates the preview within ~150 ms without losing scroll position. Scrolling either the source editor or the preview keeps the other in sync.

**What was built:** [src/previewProvider.ts](src/previewProvider.ts) (`onDidChangeTextDocument` subscription with 150ms debounce, `onDidChangeTextEditorVisibleRanges` subscription, `scrollFromPreview` handler, anti-echo guards), [media/preview.js](media/preview.js) (`scrollTo` handler, `emitScrollLine`, `smartScroll`).

### 7.1 Live reload on source change

Update [src/previewProvider.ts](src/previewProvider.ts).

Subscribe to `vscode.workspace.onDidChangeTextDocument` with a 150ms debounce timer. When the changed document matches the editor's document, re-render via markdown-it and post both `{ type: 'updateContent', body }` (the rendered HTML) and `{ type: 'updateSource', text }` (the raw markdown) to the webview.

The webview handles `updateContent` by replacing `contentEl.innerHTML`. It handles `updateSource` by updating the `rawSource` variable and, if the source editor is visible and the user is not actively typing (`!textareaEditing`), updating the textarea value while preserving cursor position and scroll offset.

**Result:** Edits in the text editor reflect in the preview within 150ms.

**Verify:** Open a markdown file side-by-side (text editor + preview). Type in the text editor. The preview updates in real time.

### 7.2 Scroll sync: host → webview

Update [src/previewProvider.ts](src/previewProvider.ts) and [media/preview.js](media/preview.js).

Subscribe to `vscode.window.onDidChangeTextEditorVisibleRanges`. When the text editor's visible range changes and the document matches, post `{ type: 'scrollTo', line }` (1-based) to the webview.

In the webview, handle `scrollTo` by finding the `[data-source-line]` element closest to the target line and scrolling it into view. In source mode, scroll the textarea to the corresponding line instead.

`smartScroll` chooses between instant jump (for large distances > 3x viewport height) and `behavior: 'smooth'` for close scrolls.

**Result:** Scrolling the text editor scrolls the preview.

**Verify:** Open a long markdown file with the text editor visible. Scroll the text editor. The preview follows.

### 7.3 Scroll sync: webview → host

Update [media/preview.js](media/preview.js) and [src/previewProvider.ts](src/previewProvider.ts).

In the webview, listen for `scroll` on both `contentScroll` and `sourceTextarea`. On each (debounced 50ms), determine the top visible line and post `{ type: 'scrollFromPreview', line }`.

In the provider, handle `scrollFromPreview` by finding the text editor and revealing the target line at the top of the viewport via `editor.revealRange(..., TextEditorRevealType.AtTop)`.

### 7.4 Anti-echo guards

Both directions set a flag (`scrollingFromHost` in the webview, `scrollingFromPreview` in the provider) with a timeout (300ms and 100ms respectively) to prevent the scroll event from echoing back and creating an infinite ping-pong loop.

**Result:** Scrolling either view scrolls the other, without looping.

**Verify:** Scroll the preview. The text editor follows. Scroll the text editor. The preview follows. No jitter or looping.

### Test method

**What to test:** Live reload works. Scroll sync works in both directions. No infinite loop.

**How to test:** Open a long markdown file side-by-side. Edit in the text editor — preview updates. Scroll the preview — text editor follows. Scroll the text editor — preview follows.

**Expected result:** Edits reflect within 150ms. Scroll sync works without jitter.

### What was implemented

After completing this phase, tell the user:

- Which files were created or changed.
- What the system can now do that it could not do before this phase.
- How to verify it works (repeat the key verify command).

---

## Phase 8 — Inline source editor with syntax highlighting [DONE]

**Goal:** The `</>` button toggles an editable source view with line numbers and markdown syntax highlighting. Edits sync back to the file in real time. The floating action bar works in both preview and source modes, with the Find button toggling between them.

**What was built:** [src/previewProvider.ts](src/previewProvider.ts) (toolbar HTML with Edit and `</>` buttons, `#source-view` with textarea + highlight overlay + line numbers, `editSource` handler, `openExternalEditor` handler), [media/preview.js](media/preview.js) (mode switching, `renderHighlight`, `highlightLine`/`highlightInline`, `updateLineNumbers`, `syncGutterScroll`, `selectInTextarea`/`selectInPreview`, Tab key handling, scroll position memory), [media/preview.css](media/preview.css) (source editor layout, gutter, syntax colours for dark/light/high-contrast themes).

**Commit:** `88829b1`.

### 8.1 Add source view HTML structure

Update `buildHtml` in [src/previewProvider.ts](src/previewProvider.ts).

Add a toolbar with `Edit` and `</>` buttons. Add a `#source-view` (initially hidden) containing three layers:
- `#line-numbers` — a `<div>` for the gutter (line numbers, `pointer-events: none`).
- `#source-highlight` — a `<div>` overlaying the textarea with syntax-highlighted HTML (`pointer-events: none`).
- `#source-editor` — a `<textarea>` with `background: transparent`, `color: transparent`, `caret-color` visible. The textarea captures input while the highlight div renders the visible text.

**Result:** HTML structure ready for the source editor.

**Verify:** Preview still renders correctly.

### 8.2 Implement syntax highlighting

Add to [media/preview.js](media/preview.js):

`renderHighlight(text)` splits text into lines and applies markdown-specific syntax colouring:
- Headings (`#` through `######`) — `md-heading` class (blue).
- Fenced code blocks (``` delimiters) — `md-fence` class (grey), content in `md-code-content` (orange).
- Blockquotes (`>`) — `md-blockquote` class (green).
- List bullets (`-`, `*`, `+`, `1.`) — `md-bullet` class (gold).
- Horizontal rules (`---`, `***`, `___`) — `md-hr` class (grey).
- Inline: backtick code, bold `**`, italic `*`, links `[text](url)`, images `![alt](url)`.

`updateHighlight()` renders the textarea value through `renderHighlight` and sets `sourceHighlight.innerHTML`.

`updateLineNumbers()` counts newlines, computes gutter width from digit count, and fills `lineNumbers.textContent`.

**Result:** Source view shows syntax-highlighted markdown.

**Verify:** Toggle to source view. Headings are blue, code fences are grey, links are teal.

### 8.3 Implement mode switching

Add to [media/preview.js](media/preview.js):

`switchToSource(scrollToLine, center, selectRange)`:
1. Flush any pending edit.
2. Save `previewScrollTop = contentScroll.scrollTop`.
3. Hide `#content-scroll`, show `#source-view`.
4. Set textarea value to `rawSource`, update highlight and line numbers.
5. If `scrollToLine`, scroll the textarea to that line (optionally centered). If `selectRange`, call `selectInTextarea`.
6. Otherwise restore saved `sourceScrollTop`.

`switchToPreview(scrollToLine, center, selectRange)`:
1. Flush any pending edit.
2. Save `sourceScrollTop = sourceTextarea.scrollTop`.
3. Hide `#source-view`, show `#content-scroll`.
4. If `scrollToLine`, find the closest `[data-source-line]` element and scroll to it. If `selectRange`, call `selectInPreview`.
5. Otherwise restore saved `previewScrollTop`.

The `</>` button click handler calls `topVisibleLine()` to determine the current scroll position, then switches to the other mode at the same line.

The Find button in the action bar toggles modes: in preview mode it switches to source (centered on the selection), in source mode it switches to preview.

**Result:** Seamless mode switching with scroll and selection preservation.

**Verify:** Scroll to the middle of a long document. Click `</>`. The source view opens at the same position. Click `</>` again. The preview returns to the same position.

### 8.4 Wire source editing back to the document

In [media/preview.js](media/preview.js), listen for `input` on the textarea:
1. Set `textareaEditing = true` with a 500ms timeout guard (prevents `updateSource` from overwriting while typing).
2. Update `rawSource`, highlight, and line numbers.
3. After a 150ms debounce, post `{ type: 'editSource', text }` to the extension host.

In [src/previewProvider.ts](src/previewProvider.ts), handle `editSource` by applying a `WorkspaceEdit` that replaces the entire document content.

Handle Tab key in the textarea: `e.preventDefault()`, insert a tab character at the cursor position, dispatch an `input` event.

**Result:** Edits in the source view sync back to the file.

**Verify:** Toggle to source view. Type some text. Toggle back to preview. The changes are reflected. Save the file — the edits persist.

### 8.5 Add Edit button to open external editor

Add an `Edit` button to the toolbar. On click, post `{ type: 'openExternalEditor' }`. The provider tries `vscode.openWith` with `vscode.markdown.preview.editor` first, falling back to the `default` editor. Then disposes the webview panel.

**Result:** One click escapes to the user's preferred editor.

**Verify:** Click Edit. The file opens in the default text editor and the Ask Markdown tab closes.

### 8.6 Style the source editor

Update [media/preview.css](media/preview.css).

Style `#source-view` with `position: absolute; inset: 0`. The gutter uses `--gutter-width` CSS variable (computed from digit count). The highlight div and textarea are positioned identically (`left: var(--gutter-width)`, same font/size/padding/line-height) so they overlap perfectly. The textarea is transparent with a visible caret.

Add syntax highlighting classes for dark, light, and high-contrast themes (`.md-heading`, `.md-fence`, `.md-code-content`, `.md-inline-code`, `.md-link`, `.md-image`, `.md-blockquote`, `.md-bullet`, `.md-hr`, `.md-bold`, `.md-italic`).

Add highlight.js theme colours for dark (`.vscode-dark .hljs-*`), light (`.vscode-light .hljs-*`), and high-contrast (`.vscode-high-contrast .hljs-*`) matching VS Code's built-in colour scheme.

**Result:** Source editor looks native across all themes.

**Verify:** Toggle to source view in light and dark themes. Colours match the VS Code aesthetic.

### Test method

**What to test:** Mode switching preserves scroll position. Source editing syncs to the document. Tab key inserts a tab. Syntax highlighting renders correctly. Selection works in both modes.

**How to test:** Open a long markdown file. Toggle between modes, verifying scroll position is preserved. Edit in source mode, verify changes appear in preview. Select text in source mode, verify action bar appears.

**Expected result:** Seamless editing experience with consistent syntax highlighting across themes.

### What was implemented

After completing this phase, tell the user:

- Which files were created or changed.
- What the system can now do that it could not do before this phase.
- How to verify it works (repeat the key verify command).

---

## Phase 9 — Tab management and Cursor compatibility [DONE]

**Goal:** The `showPreview` command robustly detects markdown tabs across VS Code and Cursor, the `flipToPreview` command toggles in-place between the rendered preview and the source/text editor, and a workspace-wide file picker provides fallback when no markdown tab is open.

**What was built:** [src/extension.ts](src/extension.ts) (complete rewrite of tab management: `MarkdownTabRef` type union, `readUriFromInput` duck-typed URI extraction, `tabRefMatches` matching, `collectMarkdownTargets`, `pickMarkdownTarget`, `pickMarkdownFromWorkspace`, `resolveUriFromLabel`, `readGitignoreFolders`, `resolveTargetMarkdown`, `flipToPreview` command, `openIfDefault` handler).

**Commits:** `405e077`, `fe29c40`, `bd393e2`, `6479705`, `6838eee`.

### 9.1 Duck-typed tab URI extraction

A critical compatibility challenge: Cursor's built-in markdown editor (`workbench.editor.markdown`) doesn't use standard `TabInputText` or `TabInputCustom` classes. `instanceof` checks fail because the class isn't a public API entry.

Implement `readUriFromInput(input)` that sniffs `.uri` and `.viewType` directly from the input object via duck-typing, returning `{ uri, viewType? }` if the input has a `vscode.Uri` at `.uri`. This works regardless of the input's actual class.

**Result:** URI extraction works for all editor types including Cursor's non-standard ones.

### 9.2 Tab ref matching system

Define a `MarkdownTabRef` type union with four variants:
- `{ kind: 'text'; uriKey }` — standard text editor tab.
- `{ kind: 'custom'; uriKey; viewType }` — custom editor (duck-typed).
- `{ kind: 'webview'; viewType; label }` — webview tab (built-in markdown preview).
- `{ kind: 'label'; label }` — fallback for exotic tab classes identified only by label.

`tabRefMatches(tab, ref)` re-matches a stored ref against a live tab. This is necessary because VS Code's `tabGroups.all` can construct fresh Tab objects on each access, making identity comparison (`Set.has(tab)`) unreliable after round trips like `vscode.openWith`.

### 9.3 Collect markdown targets

`collectMarkdownTargets()` walks every tab in every tab group and builds a `URI → MarkdownTarget` map. A markdown file can surface as:
1. A text editor tab (`TabInputText` with `.md` extension).
2. A custom editor tab (duck-typed, `.md` URI, not our own viewType).
3. A webview tab (built-in markdown preview — URI resolved from label).
4. A label-only tab (Cursor's preview mode — URI resolved from label).

`resolveUriFromLabel(label)` does best-effort URI resolution: first searches in-memory text documents for a filename or stem match, then falls back to `workspace.findFiles` with glob patterns.

Unmatched tabs are logged to an output channel (`[unmatched tab]`) for diagnostic purposes.

### 9.4 Implement showPreview command

`resolveTargetMarkdown()` returns the single target to open:
- Zero targets → check active text editor → fall back to `pickMarkdownFromWorkspace()`.
- One target → return it.
- Multiple targets → show a QuickPick.

`pickMarkdownFromWorkspace()` searches the workspace for `.md` files, excluding `node_modules` and directories listed in `.gitignore` (parsed via `readGitignoreFolders` — only simple bare directory entries, no globs).

The `showPreview` command calls `resolveTargetMarkdown`, opens the file with `vscode.openWith`, then closes the original tabs by re-matching each stored `MarkdownTabRef` against live tabs.

### 9.5 Implement flipToPreview command

The `flipToPreview` command provides in-place toggling between the rendered preview and the text/source editor, shown as `</>` in the editor title bar.

1. Try `activeTextEditor` first (plain markdown source editing).
2. Fallback: read the URI from the active tab's input via `readUriFromInput` (covers Cursor's markdown editor).
3. Don't flip if already in our own preview.
4. Locate the current tab before opening the preview (the tab list may change once the custom editor activates).
5. Open with `vscode.openWith` in the same `viewColumn`.
6. Close the original tab.

Registered in the editor title bar menu for `.md` files via `menus.editor/title` in `package.json`, hidden from the command palette.

### 9.6 Default editor auto-open

Add `openIfDefault(editor)` called from `onDidChangeActiveTextEditor` and once during `activate`. Reads `ask-markdown.defaultEditor` setting. If enabled and the active editor is markdown in a regular text tab, opens it with our custom editor.

**Result:** Opt-in default routing.

**Verify:** Toggle the setting on; open any `.md` from the Explorer — it opens in the preview.

### Test method

**What to test:** `showPreview` works with zero, one, and multiple markdown tabs. `flipToPreview` toggles in-place. Cursor's non-standard tab types are detected. Workspace file picker works. Default editor setting routes correctly.

**How to test:** Open multiple markdown files, run "Ask Markdown: Show Preview" — QuickPick appears. Open a single file — it opens directly. Close all markdown tabs, run the command — workspace picker appears. Test in both VS Code and Cursor.

**Expected result:** All tab types are detected. Commands work in both editors. No errors on exotic tab classes.

### What was implemented

After completing this phase, tell the user:

- Which files were created or changed.
- What the system can now do that it could not do before this phase.
- How to verify it works (repeat the key verify command).

---

## Phase 10 — openFile and openDiff tools [DONE]

**Goal:** Claude Code can open files in the editor and propose diffs through two MCP tools.

**What was built:** [src/claudeServer.ts](src/claudeServer.ts) (`handleOpenFile` with markdown detection and text-based selection, `handleOpenDiff` with temp file creation and save/close resolution).

### 10.1 Implement openFile tool

Add `handleOpenFile` to [src/claudeServer.ts](src/claudeServer.ts).

The tool accepts `filePath` (required), `startText` (optional — select starting at the first match), `endText` (optional — extend the selection), and `makeFrontmost` (boolean, default true).

If the file is markdown (`.md` or `.mdx`), open with `vscode.openWith` using the `askMarkdown.preview` viewType. Otherwise open with `vscode.open`.

If `startText` is provided and the file is not markdown (text selection in a webview isn't feasible from the extension side), find the text in the document, optionally extend to `endText`, and set the editor's selection and reveal range.

**Result:** Claude Code can open any file; markdown files open in the preview.

**Verify:** From Claude Code, ask: "open README.md". Confirm it opens in the Ask Markdown preview.

### 10.2 Implement openDiff tool

Add `handleOpenDiff` to [src/claudeServer.ts](src/claudeServer.ts).

The tool accepts `old_file_path` (required), `new_file_path` (optional, defaults to `old_file_path`), `new_file_contents` (required), and `tab_name` (optional, defaults to "Claude Edit").

1. Ensure the old file exists — create empty if missing so diff can open.
2. Write proposed contents to a temp file (`$TMPDIR/ask-markdown-diff-{timestamp}-{basename}`).
3. Open `vscode.diff` with the old file on the left and the temp file on the right.
4. Return a promise that resolves when the user acts:
   - On save (`onDidSaveTextDocument` matching the temp URI): write the saved content to the old file path, resolve with `FILE_SAVED`.
   - On tab close (`onDidChangeTabs` with a matching `modified` URI): resolve with `DIFF_REJECTED`.
5. Clean up the temp file in both cases.

**Result:** Claude Code can propose edits and the user reviews them in a diff view.

**Verify:** From Claude Code, ask it to modify a file. A diff tab opens. Save accepts the change; closing rejects it.

### Test method

**What to test:** `openFile` opens markdown in preview and other files in the default editor. `openDiff` blocks until save or close.

**How to test:** Use Claude Code to call both tools. Verify the correct editor opens. For `openDiff`, verify saving writes the file and closing rejects.

**Expected result:** Both tools work end-to-end through Claude Code.

### What was implemented

After completing this phase, tell the user:

- Which files were created or changed.
- What the system can now do that it could not do before this phase.
- How to verify it works (repeat the key verify command).

---

## Phase 11 — Tests and documentation [DONE]

**Goal:** The extension has a test suite covering the source mapper and render rules, and complete user-facing documentation.

**What was built:** [src/test/sourceMapper.test.ts](src/test/sourceMapper.test.ts), [src/test/renderRule.test.ts](src/test/renderRule.test.ts), [src/test/extension.test.ts](src/test/extension.test.ts) (scaffold), [README.md](README.md).

### 11.1 sourceMapper tests

Write [src/test/sourceMapper.test.ts](src/test/sourceMapper.test.ts).

Create a 5-line markdown document (`line0\nline1\nline2\nline3\nline4`) and test `toRange` for:
- Single line.
- Multi-line range.
- Last line of file.
- Line numbers past EOF are clamped.
- Negative line numbers are clamped to 0.
- NaN defaults to 0.
- Reversed start/end are swapped.
- Start past EOF with end in range — clamps and swaps.

**Result:** Edge cases covered.

**Verify:**
```bash
npm run test
```

### 11.2 Render rule tests

Write [src/test/renderRule.test.ts](src/test/renderRule.test.ts).

Import `createMarkdownIt` from the provider. Test that `data-source-line` attributes are injected for: paragraphs, headings, bullet lists, ordered lists, fenced code blocks, blockquotes, tables, math blocks (`$$`). Verify correct line numbers for the second block in a two-block document. Verify `data-source-line-end` is present.

**Result:** Source map injection is verified for all block types.

**Verify:**
```bash
npm run test
```

### 11.3 README

Write [README.md](README.md) covering: one-line description, features list (rendered preview, inline source editor, LaTeX, syntax highlighting, selection action bar, click-to-jump, bidirectional scroll sync, theme-aware), Claude Code integration instructions (install, run `claude`, `/ide`, select Ask Markdown), Cursor workaround (`TERM_PROGRAM=` prefix for fish and zsh/bash), requirements (VS Code 1.85+, Claude Code CLI), extension settings (`ask-markdown.defaultEditor`, `ask-markdown.showFloatingButton`), known issues.

**Result:** Marketplace-ready docs.

**Verify:** Preview the README — all sections render correctly.

### Test method

**What to test:** Tests pass. README is complete.

**How to test:**
```bash
npm run check-types && npm run lint && npm run test
```

**Expected result:** All commands exit 0, tests report passing.

### What was implemented

After completing this phase, tell the user:

- Which files were created or changed.
- What the system can now do that it could not do before this phase.
- How to verify it works (repeat the key verify command).

---

## Phase 12 — Ship [DONE]

**Goal:** The extension is packaged as a `.vsix` file with a complete icon, license, and is installable in VS Code and Cursor.

**What was built:** [LICENSE](LICENSE) (MIT), [media/icon.png](media/icon.png), version bumps through 0.3.1 in [package.json](package.json), packaged `.vsix` files in [releases/](releases/).

### 12.1 Package the extension

Bump the version in [package.json](package.json), then package:

```bash
npx @vscode/vsce package --out releases/ask-markdown-0.3.1.vsix
```

**Result:** New `.vsix` file is created.

**Verify:**
```bash
ls releases/ask-markdown-0.3.1.vsix
```

### 12.2 Install and smoke test

```bash
code --install-extension releases/ask-markdown-0.3.1.vsix
```

1. Open VS Code (not in dev mode).
2. Open a markdown file. Run "Ask Markdown: Show Preview". Confirm it renders with syntax highlighting and LaTeX.
3. Select text, confirm action bar appears with Claude and Find in source buttons.
4. Click `</>`, confirm source editor opens with syntax highlighting and line numbers.
5. Edit in source mode, confirm changes sync to the file and back to preview.
6. Test bidirectional scroll sync.
7. Run `claude`, connect via `/ide`, select text, click "Claude" — confirm Claude receives the selection.
8. Ask Claude "what did I just select?" — confirm `getLatestSelection` works.
9. Ask Claude to use `openFile` to open a markdown file — confirm it opens in the preview.
10. Double-click a block — confirm source editor opens at the correct line.
11. Test in Cursor with `TERM_PROGRAM= claude` workaround.

**Result:** Extension works when installed from the `.vsix`.

**Verify:** All checks above pass.

### Test method

**What to test:** The packaged extension installs and works end-to-end.

**How to test:** Install the `.vsix` in a clean VS Code window. Open a markdown file with headings, code blocks, LaTeX, tables. Verify preview rendering, source editor, Claude integration, and scroll sync.

**Expected result:** Preview renders correctly with LaTeX and syntax highlighting. Source editor works with syntax colouring. Action bar appears on selection. Claude Code connects and receives selections. Scroll sync works bidirectionally. All tools function correctly.

### What was implemented

After completing this phase, tell the user:

- Which files were created or changed.
- The final version number and VSIX file name.
- How to install: `code --install-extension releases/ask-markdown-0.3.1.vsix`.
