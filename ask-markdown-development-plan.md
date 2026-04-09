# ask-markdown Development Plan

## What this project is

**ask-markdown** is a VS Code / Cursor extension that renders a markdown file in a custom webview, lets the user select text inside that preview, maps the selection back to the exact line range in the source file, and hands it off to Cursor's AI chat command. The hard part is the **mapping** (preview DOM → source line range) and the **bridging** (webview → extension host → editor selection → AI command). The audience is anyone who reads long markdown documents in Cursor and wants to ask the AI questions about specific passages without manually copying text.

## Repository layout

The extension lives **at the repo root** — there is no inner `ask-markdown/` folder. All `npm` and `npx` commands run from the repo root.

Current layout:

```text
ask-markdown/                       ← repo root = npm root
├── ask-markdown-development-plan.md
├── package.json
├── tsconfig.json
├── esbuild.js
├── eslint.config.mjs
├── README.md
├── CHANGELOG.md
├── src/
│   └── extension.ts
└── dist/                           ← build output (generated)
```

After Phase 3 the repo also contains `src/previewProvider.ts`, `src/commands.ts`, and a `media/` folder. After Phase 4 it also contains `src/sourceMapper.ts` and `src/selectionBridge.ts`.

---

## Phase 1 — Bootstrap *(DONE)*

**Goal:** A buildable extension package exists with all dependencies installed.

**What gets built in this phase:**

- [package.json](package.json) — Declares the extension, its two commands, and its dependencies.
- [src/extension.ts](src/extension.ts) — The entry point VS Code loads when the extension activates.
- `dist/extension.js` — The bundled output that VS Code actually runs.

### 1.1 Re-verify from scratch (only if needed)

```bash
node --version
npm --version
npm install
npm run compile
ls dist/extension.js
```

**Result:** `dist/extension.js` exists and `npm run compile` exits with `0`.

### Verify (end of phase)

1. `node --version` prints a Node LTS version (20.x or 22.x).
2. `npm install` exits cleanly.
3. `npm run compile` exits with `0`.
4. `dist/extension.js` exists.

### If verification fails

| Symptom                          | Check                                                       |
|----------------------------------|-------------------------------------------------------------|
| `npm install` fails              | Node version too old; upgrade to LTS.                       |
| `npm run compile` errors         | Look for missing types in `src/extension.ts`.               |
| `dist/extension.js` missing      | `esbuild.js` did not run; re-check the `compile` script.    |

---

## Phase 2 — First run in the Extension Development Host *(DONE)*

**Goal:** Pressing F5 opens a second VS Code window where both extension commands appear in the Command Palette.

**What gets built in this phase:** nothing new — this phase only proves Phase 1's package is loadable.

### 2.1 Launch the dev host

1. Open the repo root in VS Code or Cursor.
2. Press **F5**. A second window opens with `[Extension Development Host]` in its title bar.
3. In that window, open any `.md` file.
4. Command Palette (`Cmd+Shift+P`) → type `Ask Markdown`.

**Result:** both `Ask Markdown` commands appear in the palette.

**Verify:**

1. Title bar of the second window contains `[Extension Development Host]`.
2. `Ask Markdown: Open Preview` appears in the palette.
3. `Developer: Show Running Extensions` lists `ask-markdown`.

### Verify (end of phase)

1. The dev host launches without errors.
2. The extension activates on a markdown file (visible in `Show Running Extensions`).
3. Both commands are listed in the palette.

### If verification fails

| Symptom                            | Check                                                            |
|------------------------------------|------------------------------------------------------------------|
| F5 does nothing                    | `.vscode/launch.json` missing or broken.                         |
| Commands not in palette            | `activationEvents` missing `onLanguage:markdown`.                |
| "Cannot find module" on activate   | `main` field in `package.json` does not point at `dist/extension.js`. |

---

## Phase 3 — Custom markdown preview (webview)

**Goal:** Running `Ask Markdown: Open Preview` opens a webview beside the editor that renders the active markdown file, with every block element tagged so we know which source lines it came from.

**What gets built in this phase:**

- [src/previewProvider.ts](src/previewProvider.ts) — Owns the preview window.
  - `openPreview` — Opens a side panel and shows the rendered markdown for the current file.
  - The render rule — Stamps every paragraph, heading, list item, code block and quote with the line numbers it came from in the source.
  - The change listener — Re-renders the preview whenever the source file changes.
- [src/commands.ts](src/commands.ts) — Tiny glue file that wires the palette commands to the provider.
- [media/preview.css](media/preview.css) — Makes the preview match the editor's light, dark, or high-contrast theme.
- [media/preview.js](media/preview.js) — Watches for text selections in the preview and tells the extension host which lines were picked.

### 3.1 Create the new files

```bash
mkdir -p media
touch src/previewProvider.ts src/commands.ts media/preview.css media/preview.js
```

**Result:** four empty files exist.

**Verify:**

```bash
ls src/previewProvider.ts src/commands.ts media/preview.css media/preview.js
```

All four paths print with no error.

### 3.2 Implement the preview provider

Edit [src/previewProvider.ts](src/previewProvider.ts):

- Configure `markdown-it` with `{ html: false, linkify: true }` and enable `token.map` on block tokens.
- Add a render rule that wraps every block-level token's opening tag with `data-source-line="<map[0]+1>"` and `data-source-line-end="<map[1]>"`.
- Export `openPreview(context, document)` which calls `vscode.window.createWebviewPanel('askMarkdownPreview', 'Ask Markdown Preview', vscode.ViewColumn.Beside, { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] })`.
- Build the HTML with a CSP `<meta>` tag carrying a per-load **nonce**, and inject `media/preview.css` and `media/preview.js` via `panel.webview.asWebviewUri(...)`.
- Subscribe to `vscode.workspace.onDidChangeTextDocument`, re-render on change, and dispose the listener when the panel is disposed.
- Store the source `document` on the panel so Phase 4 can reach it.

```bash
npm run compile
```

**Result:** clean build, `dist/extension.js` updated.

**Verify:** `npm run compile` exits with `0` and reports no TypeScript errors.

### 3.3 Implement preview.css

Edit [media/preview.css](media/preview.css) and use VS Code theme variables so the preview tracks the editor theme:

```css
body {
  background: var(--vscode-editor-background);
  color: var(--vscode-editor-foreground);
  font-family: var(--vscode-font-family);
  padding: 1rem 2rem;
}
a { color: var(--vscode-textLink-foreground); }
code, pre { font-family: var(--vscode-editor-font-family); }
```

**Result:** preview will inherit the editor theme.

**Verify:** checked visually in 3.6.

### 3.4 Implement preview.js

Edit [media/preview.js](media/preview.js):

```javascript
const vscode = acquireVsCodeApi();

document.addEventListener('mouseup', () => {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const text = sel.toString();
  if (!text.trim()) return;

  let node = sel.anchorNode;
  while (node && node.nodeType !== 1) node = node.parentNode;
  let el = node;
  while (el && !el.dataset?.sourceLine) el = el.parentElement;
  if (!el) return;

  vscode.postMessage({
    type: 'askAboutSelection',
    text,
    startLine: Number(el.dataset.sourceLine),
    endLine: Number(el.dataset.sourceLineEnd ?? el.dataset.sourceLine),
  });
});
```

**Result:** any selection in the webview posts a message with the text and source line range.

**Verify:** checked in 3.6.

### 3.5 Wire extension.ts to the new provider

Edit [src/extension.ts](src/extension.ts):

- Import `openPreview` from `./previewProvider`.
- Replace the stub `ask-markdown.openPreview` handler so it calls `openPreview(context, vscode.window.activeTextEditor.document)` for markdown files, otherwise shows a warning message.
- Register `panel.webview.onDidReceiveMessage` and **temporarily** `console.log('[ask-markdown]', message)` so 3.6 can verify the bridge.
- Remove any old "Hello World" popup.

```bash
npm run compile
```

**Result:** clean build.

**Verify:**

```bash
ls dist/extension.js
```

File exists and its mtime is recent.

### 3.6 Run end-to-end

1. Press **F5** in the main window (or `Cmd+R` in the dev host if it is open).
2. In the dev host, open a `.md` file with at least: a heading, a paragraph, a list, and a fenced code block.
3. Command Palette → **`Ask Markdown: Open Preview`**.

**Result:** preview opens beside the editor, theme-matched, and selection messages reach the host.

### Verify (end of phase)

1. A panel titled **Ask Markdown Preview** opens beside the editor with theme-matched colors.
2. Right-click → **Inspect** in the webview shows block elements (`<p>`, `<h1>`, `<ul>`) carrying `data-source-line` attributes.
3. Editing the source `.md` re-renders the preview within ~1 second.
4. Selecting a paragraph in the preview prints an `[ask-markdown]` log line in the **Debug Console** of the original window with `startLine` / `endLine` matching the editor gutter.

### If verification fails

| Symptom                          | Check                                                                        |
|----------------------------------|------------------------------------------------------------------------------|
| Command not found                | Dev host wasn't reloaded; press `Cmd+R`.                                     |
| Webview opens blank              | CSP too strict, or `localResourceRoots` doesn't include `media/`.            |
| `data-source-line` missing       | Render rule isn't running; check overrides for `paragraph_open`, `heading_open`, `list_item_open`, `fence`, `blockquote_open`. |
| No message in Debug Console      | `enableScripts` is false, or `acquireVsCodeApi()` was called twice.          |

---

## Phase 4 — Bridge: webview selection → editor selection → AI

**Goal:** A selection in the preview becomes a real selection in the source markdown editor and triggers Cursor AI.

**What gets built in this phase:**

- [src/sourceMapper.ts](src/sourceMapper.ts) — Pure helpers for translating line numbers.
  - `toRange` — Turns a pair of line numbers into something the editor can highlight, and clips them so they never run off the end of the file.
- [src/selectionBridge.ts](src/selectionBridge.ts) — The hand-off between the preview and the editor.
  - `handleAskAboutSelection` — Brings the source file forward, highlights the lines the user picked, scrolls them into view, and asks Cursor AI about them.

### 4.1 Create the new files

```bash
touch src/sourceMapper.ts src/selectionBridge.ts
```

**Result:** both files exist.

**Verify:** `ls src/sourceMapper.ts src/selectionBridge.ts` prints both paths.

### 4.2 Implement sourceMapper.ts

Edit [src/sourceMapper.ts](src/sourceMapper.ts) and export:

```typescript
export function toRange(
  doc: vscode.TextDocument,
  startLine: number,
  endLine: number,
): vscode.Range
```

It clamps `startLine` and `endLine` to `[0, doc.lineCount - 1]` and uses the end-of-line column on `endLine` so the full last line is included.

**Result:** a pure function with no `vscode.window` dependencies — easy to unit-test in Phase 7.

**Verify:** `npm run compile` exits with `0`.

### 4.3 Implement selectionBridge.ts

Edit [src/selectionBridge.ts](src/selectionBridge.ts) and export:

```typescript
export async function handleAskAboutSelection(
  doc: vscode.TextDocument,
  message: { text: string; startLine: number; endLine: number },
): Promise<void>
```

It must:

1. Compute `range = toRange(doc, message.startLine - 1, message.endLine - 1)` — markdown-it line numbers are 1-based; `vscode.Position` is 0-based.
2. `const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: false })`.
3. `editor.selection = new vscode.Selection(range.start, range.end)`.
4. `editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport)`.
5. `await vscode.commands.executeCommand(<configured ask command id>)` — leave as a TODO that just returns until Phase 5.

**Result:** the selection round-trip works without the AI step.

**Verify:** `npm run compile` exits with `0`.

### 4.4 Wire it into previewProvider.ts

In the `onDidReceiveMessage` handler in [src/previewProvider.ts](src/previewProvider.ts), replace the temporary `console.log` with:

```typescript
if (message.type === 'askAboutSelection') {
  await handleAskAboutSelection(sourceDoc, message);
}
```

where `sourceDoc` is the document the panel was created for.

```bash
npm run compile
```

**Result:** clean build.

**Verify:** no TypeScript errors.

### 4.5 Run end-to-end

1. Reload the dev host with `Cmd+R`.
2. Open a markdown file and run **`Ask Markdown: Open Preview`**.
3. Select a paragraph inside the preview.

**Result:** focus jumps back to the source editor, the corresponding lines are highlighted, and the view scrolls to reveal them.

### Verify (end of phase)

Walk through every construct in this table and confirm the editor selection matches:

| Markdown construct        | Expected mapping                              |
|---------------------------|-----------------------------------------------|
| Single paragraph          | exact line range of that paragraph            |
| Heading                   | the heading line                              |
| List item                 | the list item lines                           |
| Multi-paragraph selection | start of first → end of last                  |
| Code fence                | full fence including the ``` lines            |
| Blockquote                | full quote block                              |

### If verification fails

| Symptom                              | Check                                                                       |
|--------------------------------------|-----------------------------------------------------------------------------|
| Selection is off by one line         | 0/1-based mismatch in `toRange`; markdown-it is 1-based.                    |
| Wrong file gets focus                | `showTextDocument` got a stale `sourceDoc`; confirm panel storage in 3.2.   |
| Selection is empty                   | `range.end` column is 0; use end-of-line column on `endLine`.               |
| Editor doesn't scroll                | `revealRange` not called, or wrong reveal type.                             |

---

## Phase 5 — Find a stable Cursor "ask about selection" command

**Goal:** Know which `vscode.commands.executeCommand(<id>)` actually opens Cursor's AI chat with the current selection.

**What gets built in this phase:**

- A new setting `ask-markdown.askCommandId` — Lets the user override which Cursor command we call, in case Cursor renames it later.
- An updated `selectionBridge.ts` — Reads the setting and runs that command after setting the editor selection.

### 5.1 Discover candidates

Add temporarily to `activate` in [src/extension.ts](src/extension.ts):

```typescript
const all = await vscode.commands.getCommands(true);
console.log('[ask-markdown] candidates:',
  all.filter(c => /chat|ask|cursor|ai/i.test(c)));
```

```bash
npm run compile
```

Reload the dev host and read the filtered list from the **Debug Console**.

**Result:** a list of plausible command IDs.

**Verify:** the Debug Console prints a non-empty array.

### 5.2 Test each candidate

With a real selection in a markdown file in the dev host:

1. Command Palette → `Developer: Run Command`.
2. Paste each candidate ID, run it, and note which one opens Cursor's chat **with the current selection already attached**.

**Result:** one ID is identified as the working one.

**Verify:** running that ID by hand opens Cursor's chat with the selection.

### 5.3 Make the chosen ID configurable

Edit [package.json](package.json), under `"contributes"`, add:

```json
"configuration": {
  "title": "Ask Markdown",
  "properties": {
    "ask-markdown.askCommandId": {
      "type": "string",
      "default": "<the id you found>",
      "description": "Cursor command invoked after the editor selection has been set."
    }
  }
}
```

Then in [src/selectionBridge.ts](src/selectionBridge.ts):

```typescript
const id = vscode.workspace
  .getConfiguration('ask-markdown')
  .get<string>('askCommandId');
if (id) await vscode.commands.executeCommand(id);
```

Remove the temporary `getCommands` log from `extension.ts`.

```bash
npm run compile
```

**Result:** clean build with the setting wired in.

**Verify:** the new setting appears under **Settings → Extensions → Ask Markdown** in the dev host.

### 5.4 Run end-to-end

Reload the dev host. Select text in the preview.

**Result:** with no manual palette step, Cursor's chat opens with the text included.

**Verify:** Cursor's chat panel appears with the selected text attached.

### Verify (end of phase)

1. Setting `ask-markdown.askCommandId` exists and is editable.
2. Selecting text in the preview opens Cursor's chat with that text.
3. Changing the setting to a bogus ID falls through gracefully (no crash).
4. Removing the temporary `getCommands` log left no dead code.

### If verification fails

| Symptom                              | Check                                                                          |
|--------------------------------------|--------------------------------------------------------------------------------|
| No candidate opens chat with selection | Use the fallback in 5.5: copy to clipboard and prompt the user to paste.     |
| Cursor opens chat but selection empty  | The command needs an `editor.selection` set; confirm 4.3 step 3.             |
| Setting not visible                   | `package.json` `configuration` block is in the wrong place; must be under `contributes`. |

### 5.5 Fallbacks (if no stable command exists)

- Call `vscode.env.clipboard.writeText(message.text)` and show *"Selection copied. Open Cursor chat and paste."*.
- Leave the editor selection in place so the user can use their normal chat shortcut.

---

## Phase 6 — Polish

**Goal:** Make the extension feel built-in.

**What gets built in this phase:**

- Floating action bar in the preview — A small **Ask / Copy / Find in source** toolbar that pops up when text is selected.
- Scroll sync — As the user scrolls the editor, the preview scrolls to the matching block (and vice versa on click).
- Click-to-jump — Clicking a block in the preview moves the editor cursor to the matching line.
- New settings:
  - `ask-markdown.autoOpen` — Opens the preview automatically whenever a markdown file is opened.
  - `ask-markdown.showFloatingButton` — Shows or hides the floating action bar.

### 6.1 Floating action bar

Edit [media/preview.js](media/preview.js): add a `<div id="ask-bar">` with **Ask**, **Copy**, **Find in source** buttons. Show on selection, hide on collapse.

**Result:** selecting text shows a small toolbar above the selection.

**Verify:** select text in the preview; the bar appears; clicking outside hides it.

### 6.2 Scroll sync

In [src/extension.ts](src/extension.ts), subscribe to `vscode.window.onDidChangeTextEditorVisibleRanges` and post `{ type: 'scrollTo', line }` to the webview. In the webview, scroll the matching `[data-source-line]` element into view.

**Result:** scrolling the editor scrolls the preview.

**Verify:** scroll a long markdown file; preview keeps pace.

### 6.3 Click-to-jump

In [media/preview.js](media/preview.js), on click of a block, post `{ type: 'revealSource', line }`. The host moves the editor cursor.

**Result:** clicking a block in the preview moves the editor cursor to that line.

**Verify:** click each construct from the Phase 4 table; the editor cursor lands on the right line.

### 6.4 Add settings

Edit [package.json](package.json) `"contributes.configuration.properties"` to add `ask-markdown.autoOpen` and `ask-markdown.showFloatingButton`. Wire each into the relevant module.

```bash
npm run compile
```

**Result:** new settings appear in the Settings UI and take effect without restart.

### Verify (end of phase)

1. Floating bar appears on selection and disappears on collapse.
2. Scroll sync keeps the preview aligned with the editor.
3. Click-to-jump moves the editor cursor.
4. All three settings (`askCommandId`, `autoOpen`, `showFloatingButton`) take effect without reloading the host.
5. Walk every Phase 4 construct in light, dark, and high-contrast themes.

### If verification fails

| Symptom                            | Check                                                            |
|------------------------------------|------------------------------------------------------------------|
| Floating bar flickers              | Use `selectionchange` debounce, not just `mouseup`.              |
| Scroll sync feedback loop          | Guard against echoing scroll events back to the source side.    |
| Settings don't take effect         | `vscode.workspace.onDidChangeConfiguration` not wired.           |

---

## Phase 7 — Testing

**Goal:** Catch mapping bugs before users do.

**What gets built in this phase:**

- `src/test/sourceMapper.test.ts` — Proves the line-number helper handles single lines, multi-line ranges, the last line of the file, and out-of-range numbers.
- `src/test/renderRule.test.ts` — Proves the markdown render rule stamps the right `data-source-line` values on real markdown input.
- `src/test/integration.test.ts` — Pretends to be the webview, sends a selection message, and checks the editor highlights the expected lines.

### 7.1 Unit tests for the source mapper

Cover: single line, multi-line, last line of file, line numbers past EOF (should clamp), negative line numbers.

```bash
npm test
```

**Result:** unit suite passes.

**Verify:** test runner reports all source mapper tests green.

### 7.2 Unit tests for the render rule

Feed a known markdown string into the configured `markdown-it`, then assert the output HTML contains `data-source-line="N"` on the right elements for paragraphs, headings, lists, fences, and quotes.

**Result:** render rule suite passes.

**Verify:** assertions cover at least the five block types.

### 7.3 Integration tests via @vscode/test-electron

Open a markdown document, simulate a `postMessage` from a fake webview, assert `vscode.window.activeTextEditor.selection` equals the expected `vscode.Selection`.

```bash
npm test
```

**Result:** integration suite passes in a headless VS Code instance.

### Verify (end of phase)

1. `npm test` exits with `0`.
2. At least one regression test exists for any bug actually hit during Phases 3 / 4.
3. CI (or a fresh local clone) reproduces the same green run.

### If verification fails

| Symptom                              | Check                                                                |
|--------------------------------------|----------------------------------------------------------------------|
| `@vscode/test-electron` won't launch | Headless VS Code download blocked; check network/proxy.              |
| Mapper tests pass but live preview wrong | Render rule isn't covered; add the failing input as a test case. |
| Tests pass locally, fail on CI       | File system case sensitivity or line endings (CRLF vs LF).           |

---

## Phase 8 — Ship

**Goal:** Build a `.vsix` and (optionally) publish it.

**What gets built in this phase:**

- A production bundle of `dist/extension.js` — Minified, no sourcemaps.
- A `.vsix` package — A single file someone can install in any VS Code or Cursor.
- A real [README.md](README.md) — Replaces any leftover Yeoman template text.

### 8.1 Production build

```bash
npm run package
```

**Result:** `dist/extension.js` rebuilt with `--production`.

**Verify:** `dist/extension.js` mtime is recent and file is smaller than the dev build.

### 8.2 Install vsce

```bash
npm install -D @vscode/vsce
```

**Result:** `@vscode/vsce` is in `devDependencies`.

**Verify:** `npx vsce --version` prints a version.

### 8.3 Edit the README

Open [README.md](README.md). Replace any leftover Yeoman template text with a real description and usage section. `vsce` refuses to package extensions whose README still contains the template.

**Result:** README has real content.

**Verify:** grep the README for the string `This is the README` — no matches.

### 8.4 Build the .vsix

```bash
npx vsce package
```

**Result:** a file like `ask-markdown-0.0.1.vsix` appears at the repo root.

**Verify:**

```bash
ls *.vsix
```

The file exists.

### 8.5 (Optional) Publish

```bash
npx vsce login <publisher>
npx vsce publish
```

**Result:** the extension is live on the marketplace.

**Verify:** the marketplace listing shows the new version.

### 8.6 Smoke-test the packaged extension

In a clean (non-dev-host) editor window:

1. **Extensions view → … menu → Install from VSIX…** → pick the `.vsix`.
2. Open a `.md` file.
3. Run `Ask Markdown: Open Preview` and walk through the Phase 4 verification table.

**Result:** packaged behavior matches the dev host.

### Verify (end of phase)

1. `dist/extension.js` is the production build.
2. `*.vsix` exists at the repo root.
3. Installing the `.vsix` in a clean window works end-to-end.
4. The Phase 4 construct table all passes against the packaged extension.

### If verification fails

| Symptom                                     | Check                                                          |
|---------------------------------------------|----------------------------------------------------------------|
| `vsce package` complains about the README   | Template text still present; rewrite it.                       |
| `vsce package` complains about repository   | `repository` field missing or malformed in `package.json`.     |
| Installed extension doesn't activate        | `main` field points at a path not included in the bundle.     |
| Webview blank in packaged build             | `media/` folder not in `files` glob; add it or rely on default. |

---

## Daily workflow

| Action                       | How                                                       |
|------------------------------|-----------------------------------------------------------|
| Edit code                    | edit files under `src/` or `media/`                       |
| Rebuild                      | `npm run compile` (or `npm run watch` for auto-rebuild)   |
| Reload extension after edits | `Cmd+R` in the dev host window                            |
| Stop debugging               | close the dev host, or hit the red stop button            |
| Run tests                    | `npm test`                                                |
| Lint                         | `npm run lint`                                            |

---

## Risks & mitigations

| Risk                                                     | Mitigation                                                                                       |
|----------------------------------------------------------|--------------------------------------------------------------------------------------------------|
| Cursor changes its ask/chat command IDs                  | `ask-markdown.askCommandId` setting; document the override in the README.                        |
| Tricky selections (tables, nested lists) span multiple `token.map` ranges | Implement a deliberate expansion rule and add a test per construct.                |
| Webview security                                         | Use a CSP with a per-load nonce; never inject user content as raw HTML; treat markdown as untrusted. |
| Conflict with VS Code's built-in markdown preview        | Use distinct `Ask Markdown:` command titles; document the difference in the README.              |
| Activation never fires                                   | Always include `onLanguage:markdown` in `activationEvents`.                                       |
