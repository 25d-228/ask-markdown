# ask-markdown Development Plan

## What this project is

**ask-markdown** is a VS Code / Cursor extension that renders a markdown file in a custom webview with LaTeX support, lets the user select text inside that preview, maps the selection back to the exact line range in the source file, and sends it to Claude Code via a WebSocket server that speaks the same MCP protocol as the official Claude Code IDE integration. The user reads a long markdown document, selects a passage in the rendered preview, clicks "Claude", and Claude CLI receives the file reference with line numbers — no manual copying, no source editor required. The audience is anyone who reads markdown documents in VS Code or Cursor and wants to ask Claude questions about specific passages.

## Repository layout

```text
ask-markdown/                          <- repo root = npm root
+-- ask-markdown-development-plan.md
+-- package.json
+-- tsconfig.json
+-- esbuild.js
+-- eslint.config.mjs
+-- README.md
+-- CHANGELOG.md
+-- .vscode/
|   +-- launch.json
+-- src/
|   +-- extension.ts                   <- entry point, starts server + registers commands
|   +-- previewProvider.ts             <- webview panel, markdown-it + KaTeX rendering
|   +-- sourceMapper.ts                <- line-number-to-range helper
|   +-- claudeServer.ts               <- WebSocket server, MCP protocol, lock file
|   +-- test/
|       +-- extension.test.ts          <- scaffold only
+-- media/
|   +-- preview.css                    <- theme-aware preview styles
|   +-- preview.js                     <- webview selection, floating bar, scroll sync
+-- dist/                              <- build output (generated)
+-- node_modules/
```

All `npm` commands run from the repo root.

---

## Phase 1 — Bootstrap

**Goal:** A buildable extension package exists with all dependencies installed.

**What gets built in this phase:**

- [package.json](package.json) — Declares the extension, its command, settings, and dependencies.
- [src/extension.ts](src/extension.ts) — The entry point VS Code loads when the extension activates.
- `dist/extension.js` — The bundled output that VS Code actually runs.

### 1.1 Re-verify from scratch

```bash
node --version
npm --version
npm install
npm run compile
ls dist/extension.js
```

**Result:** `dist/extension.js` exists and `npm run compile` exits with `0`.

**Verify:** `dist/extension.js` exists and its mtime is recent.

### Test method

**What to test:** The project builds without errors.

**How to test:**

```bash
npm run compile
echo $?
```

**Expected result:** Exit code `0`, no TypeScript or lint errors.

---

## Phase 2 — First run in the Extension Development Host

**Goal:** Pressing F5 opens a second VS Code window where the extension command appears in the Command Palette.

**What gets built in this phase:** Nothing new. This phase proves Phase 1's package is loadable.

### 2.1 Launch the dev host

1. Open the repo root in VS Code or Cursor.
2. Press **F5**. A second window opens with `[Extension Development Host]` in its title bar.
3. In that window, open any `.md` file.
4. Command Palette (`Cmd+Shift+P`) -> type `Ask Markdown`.

**Result:** `Ask Markdown: Open Preview` appears in the palette.

**Verify:**

1. Title bar of the second window contains `[Extension Development Host]`.
2. `Ask Markdown: Open Preview` appears in the palette.
3. `Developer: Show Running Extensions` lists `ask-markdown`.

### Test method

**What to test:** The extension activates on a markdown file without errors.

**How to test:** Press F5, open a `.md` file, check the command palette and running extensions list.

**Expected result:** The extension appears in both the palette and the running extensions list.

---

## Phase 3 — Markdown preview with source mapping

**Goal:** Running `Ask Markdown: Open Preview` opens a webview beside the editor that renders the active markdown file, with every block element tagged with its source line numbers.

**What gets built in this phase:**

- [src/previewProvider.ts](src/previewProvider.ts) — Owns the preview window.
  - `createMarkdownIt` — Sets up the markdown renderer and stamps every block element with the line numbers it came from in the source.
  - `openPreview` — Opens a side panel and shows the rendered markdown for the current file.
  - `buildHtml` — Assembles the webview HTML with security headers, stylesheets, and scripts.
  - The change listener — Re-renders the preview whenever the source file changes.
- [src/sourceMapper.ts](src/sourceMapper.ts) — Turns a pair of line numbers into something the editor can highlight, and clips them so they never run off the end of the file.
  - `toRange` — Converts zero-based start/end lines to a full editor range, clamped to the document bounds.
- [media/preview.css](media/preview.css) — Makes the preview match the editor's light, dark, or high-contrast theme.
- [media/preview.js](media/preview.js) — Watches for text selections in the preview and tells the extension host which lines were picked.

### 3.1 Create the source files

```bash
mkdir -p media
touch src/previewProvider.ts src/sourceMapper.ts media/preview.css media/preview.js
```

**Result:** Four empty files exist.

**Verify:** `ls src/previewProvider.ts src/sourceMapper.ts media/preview.css media/preview.js` prints all paths.

### 3.2 Implement the source mapper

Edit [src/sourceMapper.ts](src/sourceMapper.ts). Export `toRange(doc, startLine, endLine)` which clamps both line numbers to `[0, doc.lineCount - 1]`, swaps if reversed, and uses the end-of-line column on `endLine` so the full last line is included.

**Result:** A pure function with no UI dependencies — easy to unit-test later.

**Verify:** `npm run compile` exits with `0`.

### 3.3 Implement the preview provider

Edit [src/previewProvider.ts](src/previewProvider.ts):

- Configure `markdown-it` with `{ html: false, linkify: true }`.
- Add render rules that wrap every block-level opening tag with `data-source-line` and `data-source-line-end` attributes derived from `token.map`.
- Export `openPreview(context, document)` which creates a webview panel beside the editor.
- Build the HTML with a CSP `<meta>` tag carrying a per-load nonce, and inject `media/preview.css` and `media/preview.js`.
- Subscribe to `vscode.workspace.onDidChangeTextDocument` to re-render on change.

**Result:** Clean build with `npm run compile`.

**Verify:** `npm run compile` exits with `0`.

### 3.4 Implement preview.css

Edit [media/preview.css](media/preview.css). Use VS Code theme CSS variables (`--vscode-editor-background`, `--vscode-editor-foreground`, etc.) so the preview tracks the current theme.

**Result:** Preview inherits the editor theme.

**Verify:** Checked visually in 3.6.

### 3.5 Implement preview.js

Edit [media/preview.js](media/preview.js). On `mouseup`, read the DOM selection, walk up to the nearest `[data-source-line]` element, and post a message to the extension host with the selected text and source line range.

**Result:** Any selection in the webview posts a message with the text and source line range.

**Verify:** Checked in 3.6.

### 3.6 Wire extension.ts to the preview provider and run end-to-end

In [src/extension.ts](src/extension.ts), import `openPreview` and wire it to the `ask-markdown.openPreview` command. Temporarily `console.log` incoming messages in the Debug Console.

1. Press **F5** (or `Cmd+R` if the dev host is open).
2. Open a `.md` file with a heading, paragraph, list, and fenced code block.
3. Command Palette -> **`Ask Markdown: Open Preview`**.

**Result:** Preview opens beside the editor, theme-matched, and selection messages appear in the Debug Console.

**Verify:**

1. A panel titled **Ask Markdown Preview** opens beside the editor.
2. Right-click -> **Inspect** in the webview shows block elements carrying `data-source-line` attributes.
3. Editing the source `.md` re-renders the preview within ~1 second.
4. Selecting a paragraph in the preview prints an `[ask-markdown]` log line in the Debug Console with `startLine` / `endLine` matching the editor gutter.

### Test method

**What to test:** Preview renders markdown, source-line attributes are present on block elements, live re-rendering works, selection messages reach the host.

**How to test:** Manual smoke test in the Extension Development Host. Inspect the webview DOM for `data-source-line` attributes. Select text and check Debug Console output.

**Expected result:** All four verify checks in 3.6 pass.

---

## Phase 4 — LaTeX rendering

**Goal:** Inline (`$...$`) and display (`$$...$$`) LaTeX renders as properly typeset math in the preview.

**What gets built in this phase:**

- Updated [src/previewProvider.ts](src/previewProvider.ts):
  - `markdown-it-texmath` plugin added with KaTeX engine for `$...$` and `$$...$$` delimiters.
  - `math_block` token gets a wrapper `<div>` with `data-source-line` attributes so display math blocks are clickable and selectable.
  - KaTeX CSS served from `node_modules/katex/dist/katex.min.css` with fonts.
  - CSP updated to allow `'unsafe-inline'` styles (required by KaTeX's inline `style` attributes).
- Updated [package.json](package.json):
  - `katex` and `markdown-it-texmath` added to `dependencies`.

### 4.1 Install dependencies

```bash
npm install katex markdown-it-texmath
```

**Result:** Both packages appear in `package.json` `dependencies`.

**Verify:** `ls node_modules/katex/dist/katex.min.css` prints the path.

### 4.2 Add KaTeX to the renderer

Edit [src/previewProvider.ts](src/previewProvider.ts):

- Require `markdown-it-texmath` and `katex`.
- Call `md.use(texmath, { engine: katex, delimiters: 'dollars' })`.
- Add `node_modules/katex/dist` to `localResourceRoots`.
- Add a `<link>` for `katex.min.css` in `buildHtml`.
- Add `'unsafe-inline'` to the `style-src` CSP directive.
- Add a custom renderer for `math_block` that wraps the output in a `<div>` with `data-source-line` attributes (texmath ignores token attributes set via `attrJoin`).

```bash
npm run compile
```

**Result:** Clean build.

**Verify:** `npm run compile` exits with `0`.

### 4.3 Run end-to-end

Open a markdown file containing inline math (`$E = mc^2$`) and display math (`$$\int_0^1 x^2\,dx$$`). Run `Ask Markdown: Open Preview`.

**Result:** Math renders as typeset equations, not raw LaTeX source.

**Verify:**

1. Inline math renders inline with surrounding text.
2. Display math renders centered on its own line.
3. `\begin{aligned}` and `\begin{bmatrix}` environments render correctly.
4. Double-clicking a display math block jumps to the correct source line.

### Test method

**What to test:** KaTeX renders inline and display math; source mapping works on math blocks.

**How to test:** Open a file with the LaTeX constructs listed above. Visually confirm rendering. Double-click a math block and verify the editor jumps to the right line.

**Expected result:** All math renders as typeset output. Source mapping works for `math_block` tokens.

---

## Phase 5 — Selection bridge and floating action bar

**Goal:** Selecting text in the preview shows a floating toolbar. Clicking "Find in source" jumps to the matching lines in the editor. The source editor selection syncs with the webview selection in real time.

**What gets built in this phase:**

- Updated [media/preview.js](media/preview.js):
  - A floating action bar with **Claude** and **Find in source** buttons appears above any text selection.
  - On selection change, a `syncSelection` message is posted to the host so the source editor highlights the matching lines without stealing focus.
  - Double-click on any block jumps to its source line via a `revealSource` message.
- Updated [src/previewProvider.ts](src/previewProvider.ts):
  - `revealSource` handler — Opens the source editor and highlights the matching line range.
  - `syncSelection` handler — Highlights matching lines in the source editor without stealing focus from the webview.
- Updated [media/preview.css](media/preview.css):
  - Styles for the floating action bar and hover outlines on source-mapped elements.

### 5.1 Build the floating action bar

Edit [media/preview.js](media/preview.js). Create a `<div id="ask-bar">` with buttons. Show it above the selection on `selectionchange` (debounced) and `mouseup`. Hide it when the selection collapses.

**Result:** Selecting text in the preview shows a floating toolbar.

**Verify:** Select text; bar appears above selection; click outside; bar hides.

### 5.2 Wire the message handlers

Edit [src/previewProvider.ts](src/previewProvider.ts). Handle `revealSource` (show the source editor and set the selection) and `syncSelection` (highlight matching lines without stealing focus).

```bash
npm run compile
```

**Result:** Clean build.

**Verify:** Select text in the preview; the source editor highlights the matching lines.

### 5.3 Add scroll sync and click-to-jump

In [src/previewProvider.ts](src/previewProvider.ts), subscribe to `vscode.window.onDidChangeTextEditorVisibleRanges` and post `scrollTo` messages to the webview. In [media/preview.js](media/preview.js), handle `scrollTo` by scrolling the nearest `[data-source-line]` element into view. Add a `dblclick` handler that posts `revealSource`.

**Result:** Scrolling the editor scrolls the preview. Double-clicking a block jumps to its source.

**Verify:** Scroll a long markdown file; preview keeps pace. Double-click a heading; editor cursor lands on it.

### Test method

**What to test:** Floating bar appears/hides correctly, Find in source jumps to the right line, sync selection highlights without focus change, scroll sync tracks editor position, double-click jumps work.

**How to test:** Manual smoke test in the Extension Development Host with a markdown file containing headings, paragraphs, lists, code fences, blockquotes, and math blocks.

**Expected result:** All interactions work for every block type. The floating bar does not flicker.

---

## Phase 6 — Claude Code WebSocket server

**Goal:** The extension runs its own MCP-compatible WebSocket server. Claude CLI connects to it automatically. Clicking "Claude" in the preview sends the file and line range directly to Claude CLI over the WebSocket — no source editor needed.

**What gets built in this phase:**

- [src/claudeServer.ts](src/claudeServer.ts) — The WebSocket server that Claude CLI connects to.
  - `startServer` — Starts a WebSocket server on a random port, writes a lock file to `~/.claude/ide/{port}.lock`, and begins accepting authenticated connections.
  - `stopServer` — Closes all connections, removes the lock file, and shuts down the server.
  - `broadcast` — Sends a JSON-RPC notification (like `at_mentioned`) to all connected Claude CLI clients.
  - `isConnected` — Returns whether any Claude CLI client is currently connected.
  - `handleMessage` — Responds to MCP protocol messages: `initialize`, `tools/list`, `tools/call`.
  - MCP tools exposed: `getCurrentSelection`, `getOpenEditors`, `getWorkspaceFolders`.
- Updated [src/extension.ts](src/extension.ts):
  - Starts the server on activation, stops it on deactivation.
- Updated [src/previewProvider.ts](src/previewProvider.ts):
  - `askClaude` handler — Broadcasts `at_mentioned` with the file path and line range to all connected Claude CLI clients. Shows a warning if no client is connected.
- Updated [media/preview.js](media/preview.js):
  - "Claude" button posts an `askClaude` message with `startLine` and `endLine`.

### 6.1 Install ws

```bash
npm install ws
npm install -D @types/ws
```

**Result:** `ws` in `dependencies`, `@types/ws` in `devDependencies`.

**Verify:** `npm ls ws` shows the installed version.

### 6.2 Implement the WebSocket server

Edit [src/claudeServer.ts](src/claudeServer.ts):

- Generate a UUID auth token on startup.
- Create an HTTP server and a `WebSocketServer` in `noServer` mode.
- On `upgrade`, validate the `x-claude-code-ide-authorization` header against the auth token. Reject with 401 if it does not match.
- On `connection`, add the client to a set and listen for JSON-RPC messages.
- Handle `initialize` (respond with protocol version `2024-11-05` and capabilities), `tools/list`, and `tools/call`.
- Write a lock file to `~/.claude/ide/{port}.lock` containing `pid`, `workspaceFolders`, `ideName`, `transport`, `authToken`.
- On shutdown, remove the lock file and close all connections.
- Export `broadcast(method, params)` to send JSON-RPC notifications to all clients.

```bash
npm run compile
```

**Result:** Clean build.

**Verify:** `npm run compile` exits with `0`.

### 6.3 Wire the server into extension lifecycle

Edit [src/extension.ts](src/extension.ts). Call `startServer()` in `activate` and `stopServer()` in `deactivate`.

```bash
npm run compile
```

**Result:** Clean build.

**Verify:** Reload the dev host. Check the Debug Console for `[ask-markdown] WebSocket server listening on port XXXXX`. Verify `ls ~/.claude/ide/*.lock` shows a new lock file.

### 6.4 Wire the Claude button

Edit [src/previewProvider.ts](src/previewProvider.ts). Handle the `askClaude` message type by calling `broadcast('at_mentioned', { filePath, lineStart, lineEnd })`. Show a warning if `isConnected()` is false.

Edit [media/preview.js](media/preview.js). The "Claude" button posts `{ type: 'askClaude', startLine, endLine }`.

```bash
npm run compile
```

**Result:** Clean build.

### 6.5 Run end-to-end

1. Reload the dev host with `Cmd+R`.
2. Open a terminal and run `claude` in the workspace directory.
3. Open a markdown file and run `Ask Markdown: Open Preview`.
4. Select text in the preview and click "Claude".

**Result:** Claude CLI receives the file reference with the line range. The source editor does not need to be open.

**Verify:**

1. Debug Console shows `[ask-markdown] Claude CLI connected` when `claude` starts.
2. Clicking "Claude" does not open or focus the source editor.
3. Claude CLI shows the `@file.md#L10-L20` reference in its context.
4. With no `claude` running, clicking "Claude" shows a warning message.

### Test method

**What to test:** Server starts and creates a lock file. Claude CLI connects via the lock file. `at_mentioned` broadcast reaches Claude CLI. Warning appears when disconnected.

**How to test:** Reload the dev host, run `claude` in a terminal, select text in the preview, click "Claude". Also test with no `claude` running.

**Expected result:** Claude CLI receives the reference. Warning appears when disconnected.

---

## Phase 7 — Settings and auto-open

**Goal:** The extension opens the preview automatically for markdown files and lets the user toggle features via settings.

**What gets built in this phase:**

- Updated [src/extension.ts](src/extension.ts):
  - Auto-open logic — Opens the preview when a markdown file becomes active, respecting the `autoOpen` setting and remembering dismissed previews.
- Updated [src/previewProvider.ts](src/previewProvider.ts):
  - Tracks dismissed previews so auto-open does not reopen a preview the user closed.
  - Sets the editor layout to a 1:3 ratio (source : preview) when the preview opens.
- Updated [package.json](package.json):
  - `ask-markdown.autoOpen` setting — Automatically open the preview when a markdown file is opened (default: true).
  - `ask-markdown.showFloatingButton` setting — Show or hide the floating action bar (default: true).

### 7.1 Add the settings

Edit [package.json](package.json). Add `autoOpen` (boolean, default true) and `showFloatingButton` (boolean, default true) under `contributes.configuration.properties`.

**Result:** Settings appear in the Settings UI.

**Verify:** Open Settings and search for "Ask Markdown". Both settings appear.

### 7.2 Implement auto-open

Edit [src/extension.ts](src/extension.ts). Subscribe to `vscode.window.onDidChangeActiveTextEditor`. When a markdown file becomes active and `autoOpen` is true, call `openPreview` unless the preview was previously dismissed or already open.

Track dismissed previews in [src/previewProvider.ts](src/previewProvider.ts) using a `Set`. Clear the dismissed state when the document is closed so reopening the file auto-opens the preview again.

```bash
npm run compile
```

**Result:** Clean build.

**Verify:** Open a markdown file; the preview opens automatically. Close the preview; it does not reopen until the file is closed and reopened.

### 7.3 Wire the floating button setting

Post `updateShowFloatingButton` messages from the host when the setting changes. In [media/preview.js](media/preview.js), respect the `data-enabled` attribute on the bar.

```bash
npm run compile
```

**Result:** Toggling the setting shows/hides the floating bar.

### Test method

**What to test:** Auto-open respects the setting and the dismissed state. Floating button setting toggles the bar. Settings take effect without reloading.

**How to test:** Toggle each setting in the Settings UI and verify behavior.

**Expected result:** All settings work as described.

---

## Phase 8 — Testing

**Goal:** Catch mapping bugs and protocol issues before users do.

**What gets built in this phase:**

- [src/test/sourceMapper.test.ts](src/test/sourceMapper.test.ts) — Proves the line-number helper handles single lines, multi-line ranges, the last line of the file, out-of-range numbers, and NaN.
- [src/test/renderRule.test.ts](src/test/renderRule.test.ts) — Proves the markdown render rule stamps the right `data-source-line` values on paragraphs, headings, lists, fences, blockquotes, and math blocks.

### 8.1 Unit tests for the source mapper

Cover: single line, multi-line, last line of file, line numbers past EOF (should clamp), negative line numbers, NaN (should default to 0), reversed start/end (should swap).

```bash
npm test
```

**Result:** All source mapper tests pass.

**Verify:** Test runner reports all tests green.

### 8.2 Unit tests for the render rule

Feed known markdown strings into the configured `markdown-it` instance. Assert the output HTML contains `data-source-line="N"` on the right elements for paragraphs, headings, lists, fences, blockquotes, and `math_block` tokens.

```bash
npm test
```

**Result:** All render rule tests pass.

**Verify:** Assertions cover at least six block types including math.

### Test method

**What to test:** Line clamping edge cases, source-line attribute injection for all block types.

**How to test:**

```bash
npm test
```

**Expected result:** Exit code `0`. All tests pass.

---

## Phase 9 — Ship

**Goal:** Build a `.vsix` and (optionally) publish it.

**What gets built in this phase:**

- A production bundle of `dist/extension.js` — Minified, no sourcemaps.
- A `.vsix` package — A single file someone can install in VS Code or Cursor.
- A real [README.md](README.md) — Replaces any leftover template text.

### 9.1 Production build

```bash
npm run package
```

**Result:** `dist/extension.js` rebuilt with `--production`.

**Verify:** `dist/extension.js` mtime is recent and file is smaller than the dev build.

### 9.2 Install vsce

```bash
npm install -D @vscode/vsce
```

**Result:** `@vscode/vsce` is in `devDependencies`.

**Verify:** `npx vsce --version` prints a version.

### 9.3 Edit the README

Open [README.md](README.md). Replace any leftover template text with a real description and usage section.

**Result:** README has real content.

**Verify:** `grep "This is the README" README.md` returns no matches.

### 9.4 Build the .vsix

```bash
npx vsce package
```

**Result:** A file like `ask-markdown-0.0.1.vsix` appears at the repo root.

**Verify:** `ls *.vsix` shows the file.

### 9.5 Smoke-test the packaged extension

In a clean (non-dev-host) editor window:

1. **Extensions view -> ... menu -> Install from VSIX...** -> pick the `.vsix`.
2. Open a `.md` file.
3. Run `Ask Markdown: Open Preview` and verify rendering, selection, Claude button, and scroll sync all work.

**Result:** Packaged behavior matches the dev host.

### Test method

**What to test:** The packaged extension installs and works end-to-end.

**How to test:** Install the `.vsix` in a clean window. Open a markdown file with math. Test preview rendering, floating bar, Claude button (with `claude` running in a terminal), and scroll sync.

**Expected result:** All features work identically to the dev host.

---

## Daily workflow

| Action                        | How                                                        |
|-------------------------------|------------------------------------------------------------|
| Edit code                     | Edit files under `src/` or `media/`                        |
| Rebuild                       | `npm run compile` (or `npm run watch` for auto-rebuild)    |
| Reload extension after edits  | `Cmd+R` in the dev host window                             |
| Stop debugging                | Close the dev host, or hit the red stop button             |
| Run tests                     | `npm test`                                                 |
| Lint                          | `npm run lint`                                             |

---

## Risks and mitigations

| Risk                                                        | Mitigation                                                                                            |
|-------------------------------------------------------------|-------------------------------------------------------------------------------------------------------|
| Claude CLI changes the MCP protocol or lock file format     | Pin to protocol version `2024-11-05`; monitor `claudecode.nvim` for upstream changes.                 |
| KaTeX inline styles blocked by stricter CSP in future       | `'unsafe-inline'` is required; document this in the README.                                           |
| Tricky selections (tables, nested lists) span wrong ranges  | Source-map injection covers all block types; add test cases for each.                                  |
| Lock file conflicts with Claude Code VS Code extension      | Use `ideName: 'AskMarkdown'` to distinguish; Claude CLI connects to all advertised servers.           |
| Webview security                                            | CSP with per-load nonce; never inject user content as raw HTML; treat markdown as untrusted.           |
| Activation never fires                                      | `onLanguage:markdown` in `activationEvents` ensures activation on any markdown file.                  |
