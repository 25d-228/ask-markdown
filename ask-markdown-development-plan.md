# ask-markdown Development Plan

## What this project is

**ask-markdown** is a VS Code / Cursor extension that:

1. Renders a markdown file in a **custom webview preview**.
2. Lets the user **select text inside that preview**.
3. Maps the selection **back to the exact line range in the markdown source file**.
4. Hands that selection off to **Cursor AI's chat / ask command** so the user can ask questions about it.

The hard part is the **mapping** (preview DOM → source line range) and the **bridging** (webview → extension host → editor selection → AI command).

## Repository layout

Right now the repository contains only this plan:

```text
<repo-root>/
└── ask-markdown-development-plan.md   ← this file
```

After Phase 1 scaffolds the extension, the layout will look like:

```text
<repo-root>/
├── ask-markdown-development-plan.md
└── ask-markdown/                       ← the extension package (npm root, created in Phase 1)
    ├── package.json
    ├── tsconfig.json
    ├── esbuild.js
    ├── .vscode/
    │   ├── launch.json                 ← F5 debug config
    │   └── tasks.json
    ├── src/
    │   └── extension.ts
    └── dist/                           ← build output
```

> **Once it exists, all `npm` / `npx` commands in this plan are run from the inner `ask-markdown/` folder** (the one containing `package.json`). Whenever a command block appears, assume your shell's working directory is that folder.

## Prerequisites (any platform)

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | LTS (20.x or 22.x) | runs `npm`, build scripts |
| npm | bundled with Node | package management |
| Git | any recent | version control |
| VS Code **or** Cursor | recent | editor + extension host |

**Verify** (run anywhere):

```bash
node --version
npm --version
git --version
```

Each should print a version. If any fails, install it before continuing.

---

## Phase 1 — Bootstrap the extension package

**Goal:** A project that compiles and produces `dist/extension.js`.

> **Skip this phase** if `package.json` and `src/extension.ts` already exist in the inner folder. You only need it for a fresh scaffold.

### Steps

1. From the directory **where you want the new extension folder to appear**, scaffold via the official Yeoman generator:

   ```bash
   npx -p yo -p generator-code yo code
   ```

   Choose **New Extension (TypeScript)** → **esbuild** → **npm**. Name the folder `ask-markdown`.

2. Enter the new folder and install dependencies:

   ```bash
   cd ask-markdown
   npm install
   ```

3. Install the markdown rendering libraries used by later phases:

   ```bash
   npm install markdown-it markdown-it-source-map
   npm install -D @types/markdown-it
   ```

4. Edit `package.json`:
   - `"engines": { "vscode": "^1.85.0" }` (or newer)
   - `"activationEvents": ["onLanguage:markdown"]` — **do not** add `onCommand:` entries; VS Code generates them automatically from `contributes.commands`.
   - Under `"contributes": { "commands": [...] }` declare:
     - `ask-markdown.openPreview` — title `Ask Markdown: Open Preview`
     - `ask-markdown.askAboutSelection` — title `Ask Markdown: Ask About Selection`

5. Build:

   ```bash
   npm run compile
   ```

### Verify

```bash
ls dist/extension.js
```

If the file exists, the build succeeded. If `npm run compile` printed errors, fix them before moving on.

---

## Phase 2 — Run the extension in a Development Host

**Goal:** Confirm the extension actually loads and its commands are reachable from the Command Palette. This is the foundation you will rely on for every later phase.

### Steps

1. Make sure the **inner `ask-markdown/` folder** is the open folder in your editor.
2. Press **F5** (or **Run → Start Debugging**).
3. A **second window** opens. Its title bar contains `[Extension Development Host]`. **All testing happens in this second window.**
4. In the second window: **File → Open File** → open any `.md` file (or create a new one and save it as `test.md`). This is required because the extension activates on `onLanguage:markdown`.

### Verify (do all three)

In the **Extension Development Host** window:

1. **Command Palette** (`Ctrl+Shift+P` / `Cmd+Shift+P`) → type `Ask Markdown` → both commands should appear:
   - `Ask Markdown: Open Preview`
   - `Ask Markdown: Ask About Selection`
2. Run **`Ask Markdown: Open Preview`**. The current stub shows an information popup in the bottom-right corner. Seeing the popup = activation works.
3. **Command Palette → `Developer: Show Running Extensions`** → `ask-markdown` (or `undefined_publisher.ask-markdown`) is in the list.

### If verification fails

Work through this checklist in order — stop at the first item that fixes it:

| Symptom | Check |
|---------|-------|
| F5 does nothing / no second window | The folder you opened is wrong. It must contain `package.json` directly. Re-open the inner `ask-markdown/` folder. |
| Second window opens but commands not in palette | Open a `.md` file first (activation event). Then check `Developer: Show Running Extensions`. |
| `ask-markdown` not in running extensions | Open the **Output** panel (`Ctrl+Shift+U`) → dropdown → **Extension Host**. Look for errors mentioning `ask-markdown` or `activate`. |
| Build errors during F5 launch | F5 runs the `npm: compile` preLaunchTask. Check the **Terminal** panel of the *original* window for compile output. Run `npm run compile` manually to see the full error. |
| Stale build | Delete `dist/` and run `npm run compile` again. |

### Daily workflow from here on

| Action | How |
|--------|-----|
| Edit code | edit files under `src/` |
| Rebuild | `npm run compile` (or run `npm run watch` in a terminal for auto-rebuild) |
| Reload extension after edits | In the dev host window: **Ctrl+R** / **Cmd+R** (reloads the window with the new build) |
| Stop debugging | Close the dev host window, or press the red stop button in the original window |
| Run tests | `npm test` |
| Lint | `npm run lint` |

---

## Phase 3 — Custom markdown preview (webview)

**Goal:** A webview panel renders markdown and tags every block with its source line numbers.

### File layout to create

```text
ask-markdown/
├── src/
│   ├── extension.ts          ← register commands, wire to previewProvider
│   ├── previewProvider.ts    ← owns the WebviewPanel + rendering
│   ├── selectionBridge.ts    ← (Phase 4) handles messages from webview
│   ├── sourceMapper.ts       ← (Phase 4) line range → vscode.Range
│   └── commands.ts           ← command registration helpers
└── media/
    ├── preview.css           ← uses var(--vscode-*) theme variables
    └── preview.js            ← runs inside the webview, posts messages
```

### Steps

1. **`previewProvider.ts`:**
   - Configure `markdown-it` so block tokens carry `token.map` (line range).
   - Add a render rule that emits `data-source-line="<start>"` and `data-source-line-end="<end>"` on each block element.
   - Create a `WebviewPanel` with:
     - `viewColumn: vscode.ViewColumn.Beside`
     - `enableScripts: true`
     - `localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]`
   - Build the HTML string with a CSP nonce, and inject `preview.css` + `preview.js` via `webview.asWebviewUri(...)`.
   - Subscribe to `vscode.workspace.onDidChangeTextDocument` and re-render when the active markdown file changes.

2. **`media/preview.js`:**
   - Call `acquireVsCodeApi()` once.
   - On `mouseup` / `selectionchange`, read `window.getSelection()`, walk up to the nearest element with `data-source-line`, then post:
     ```js
     vscode.postMessage({
       type: "askAboutSelection",
       text: selectedText,
       startLine: Number(el.dataset.sourceLine),
       endLine: Number(el.dataset.sourceLineEnd ?? el.dataset.sourceLine)
     });
     ```

3. **`media/preview.css`:** style with `var(--vscode-editor-background)`, `var(--vscode-editor-foreground)`, etc., so it tracks light / dark / high-contrast themes automatically.

4. **`extension.ts`:** make `ask-markdown.openPreview` call into `previewProvider`. Remove the stub popup.

5. Rebuild and reload the dev host (`npm run compile`, then `Ctrl+R` in the dev host window).

### Verify

In the dev host window:

1. Open a markdown file with a few headings, paragraphs, and a list.
2. Run **`Ask Markdown: Open Preview`** → a webview opens beside the editor showing the rendered markdown.
3. **Right-click inside the webview → Inspect** (if Developer Tools are available) and confirm block elements have `data-source-line` attributes. Alternatively, temporarily add a visible debug line in `preview.js` that logs the dataset on selection.
4. Edit the markdown file in the editor → the preview updates within ~1s.
5. Select text in the preview → in `extension.ts`, log the message you receive from the webview to the **Debug Console** of the original window. Confirm `startLine` / `endLine` look correct.

---

## Phase 4 — Bridge: webview selection → editor selection → AI

**Goal:** A selection in the preview becomes a real selection in the source markdown editor, then triggers Cursor AI.

### Steps

1. **`sourceMapper.ts`:** export a function `toRange(doc: vscode.TextDocument, startLine: number, endLine: number): vscode.Range`. Clamp to document bounds. Use line-end column for `endLine` so the full last line is included.

2. **`selectionBridge.ts`:** export a handler for `askAboutSelection` messages that:
   - Resolves the source `TextDocument` (the one currently being previewed).
   - Calls `vscode.window.showTextDocument(doc, { viewColumn: ViewColumn.One, preserveFocus: false })`.
   - Sets `editor.selection = new vscode.Selection(range.start, range.end)`.
   - Calls `editor.revealRange(range)`.
   - Triggers the AI command (see Phase 5) via `vscode.commands.executeCommand(<id>)`.

3. Wire `previewProvider` to forward `webview.onDidReceiveMessage` to the bridge.

### Verify

1. Open a markdown file, open the preview, select a paragraph in the preview.
2. Focus jumps to the editor and the corresponding lines are highlighted (selection visible).
3. The Cursor chat / ask UI opens with the selection (assuming Phase 5 has found a working command ID — until then, just confirm the editor selection is correct and skip the AI step).

### Manual test cases

| Markdown construct | Expected mapping |
|--------------------|------------------|
| Single paragraph | exact line range of that paragraph |
| Heading | the heading line |
| List item | the list item lines |
| Multi-paragraph selection | start of first → end of last |
| Code fence | full fence including ``` lines |
| Blockquote | full quote block |

---

## Phase 5 — Find a stable Cursor "ask about selection" command

**Goal:** Know which `vscode.commands.executeCommand(...)` ID actually opens Cursor's AI chat with the current selection. Cursor's command IDs are not officially documented and can change.

### Steps

1. In `extension.ts`, temporarily add:

   ```ts
   const all = await vscode.commands.getCommands(true);
   console.log(all.filter(c => /chat|ask|cursor|ai/i.test(c)));
   ```

2. Reload the dev host. Read the list in the **Debug Console** of the original window.
3. Pick promising candidates. With a real selection in a markdown file, run them via:
   - Command Palette (most are listed there), or
   - `Developer: Run Command` → paste the ID.
4. Note which command IDs reliably "ask about the current selection" in your Cursor version.
5. Make the chosen command ID **configurable** via `contributes.configuration` in `package.json` (e.g. `ask-markdown.askCommandId`) so future Cursor updates only need a settings change.

### Verify

Selecting text in the preview triggers the AI ask flow with that text included, with **no manual Command Palette step** required.

### Fallbacks (if no stable command exists)

- Copy selection to clipboard via `vscode.env.clipboard.writeText(...)` and show an information message: "Selection copied. Open Cursor chat and paste."
- Leave the editor selection in place so the user can invoke their normal chat shortcut.

---

## Phase 6 — Polish

**Goal:** Make it feel built-in.

### Steps

- Floating action bar in the preview: **Ask**, **Copy**, **Find in source**. Hide when selection clears.
- Optional scroll sync: when the editor scrolls, scroll the preview to the matching block (use `data-source-line` attributes).
- Click-to-jump: clicking a block in the preview moves the cursor in the source editor.
- Theme support: confirm light, dark, and high-contrast all look correct.
- Keyboard accessibility: every floating action also has a Command Palette command.
- Settings:
  - `ask-markdown.askCommandId` (string)
  - `ask-markdown.autoOpen` (boolean) — auto-open preview on `.md`
  - `ask-markdown.showFloatingButton` (boolean)

### Verify

Walk through the manual test cases from Phase 4 again, this time checking that polish features behave correctly under each theme.

---

## Phase 7 — Testing

**Goal:** Catch mapping bugs before users do.

### Steps

1. Unit tests for `sourceMapper.toRange` covering: single line, multi-line, last line of file, empty selection.
2. Unit tests for the markdown-it render rule: assert that a known input produces output containing `data-source-line="N"` on the right elements.
3. Integration tests via `@vscode/test-electron`: open a markdown document, simulate a postMessage from a fake webview, assert the editor selection equals the expected range.

### Run

```bash
npm test
```

### Verify

All tests pass. Add at least one test that would have caught a real bug you hit during development.

---

## Phase 8 — Ship

**Goal:** Build a `.vsix` and (optionally) publish.

### Steps

1. Production build:

   ```bash
   npm run package
   ```

   (Falls back to `npm run compile` if your scripts don't define `package`.)

2. Make sure `@vscode/vsce` is a devDependency:

   ```bash
   npm install -D @vscode/vsce
   ```

3. Edit `README.md` so it no longer contains the Yeoman template text. `vsce` refuses to package otherwise.

4. Build the `.vsix`:

   ```bash
   npx vsce package
   ```

5. (Optional) Publish to the marketplace:

   ```bash
   npx vsce login <publisher>
   npx vsce publish
   ```

### Verify

```bash
ls *.vsix
```

A `.vsix` file exists. Install it in a clean editor window via **Extensions view → … menu → Install from VSIX…**, then run the commands in a real (non-dev-host) window. They should work identically to Phase 2.

---

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Cursor changes its ask/chat command IDs | Make IDs configurable in settings; ship with sensible defaults; document the override. |
| Tricky selections (tables, nested lists) span multiple `token.map` ranges | Implement a deliberate expansion rule and add tests for each construct. |
| Webview security | Use a CSP with a nonce; never inject user content as raw HTML; treat markdown as untrusted input. |
| Conflict with VS Code's built-in markdown preview | Use distinct command titles (`Ask Markdown:` prefix); document the difference in README. |
| Activation never fires | Only the events listed in `activationEvents` activate the extension. Always include `onLanguage:markdown`. |
