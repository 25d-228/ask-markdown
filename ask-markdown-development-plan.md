# ask-markdown Development Plan

## Overview

Build a VS Code / Cursor extension: select text in a **markdown preview**, map it back to the **source file**, and **ask Cursor AI** about that selection.

Use **WSL2 (Linux)** and open the project with **Cursor or VS Code + Remote - WSL** so the editor uses your Linux files and tools.

**Where to run `npm`:** In this repository, the extension lives in the inner **`ask-markdown/`** folder (the one with `package.json`). Open that folder in the editor and run all npm commands there.

---

## Prerequisites (WSL)

Update packages if the distro is new:

```bash
sudo apt update && sudo apt upgrade -y
```

| Install | Why |
|---------|-----|
| **Node.js LTS** (20.x or 22.x) | `npm`, `npx`, build |
| **Git** | Version control |
| **build-essential** | Only if some npm package needs a native compile |

**Create a new extension from the official template** (skip if you already cloned this repo):

```bash
cd ~/GitHub/SIDES    # parent folder you use for projects
npx -p yo -p generator-code yo code
```

Pick **New Extension (TypeScript)**, **esbuild**, **npm**, then open the generated folder.

**Package extensions without a global tool:**

```bash
cd ask-markdown        # folder that contains package.json
npm install -D @vscode/vsce
npx vsce package       # or: npx vsce publish
```

**Editor:** Install **Cursor** or **VS Code** on Windows, turn on **Remote - WSL**, open the repo from WSL. Use **Run → Start Debugging** or **F5** to launch an **Extension Development Host** with your extension loaded.

---

## Phase 1 — Bootstrap

**What:** Have a project that compiles, and add the dependencies and file layout for the real feature.

**How:**

1. **Scaffold** (if starting fresh): run `npx -p yo -p generator-code yo code` in a parent directory, then `cd` into the new folder and `npm install`.
2. **Set `package.json`:** Use a recent `vscode` engine (e.g. `^1.85.0` or newer). Add **`onLanguage:markdown`** (or other activation you need) when you wire up preview and commands.
3. **Grow the tree** toward something like:

   ```text
   ask-markdown/
   ├── src/
   │   ├── extension.ts
   │   ├── previewProvider.ts
   │   ├── selectionBridge.ts
   │   ├── sourceMapper.ts
   │   └── commands.ts
   ├── media/
   │   ├── preview.js
   │   └── preview.css
   ├── package.json
   ├── tsconfig.json
   ├── .vscodeignore
   └── README.md
   ```

4. **Install libraries** when you implement rendering and mapping:

   ```bash
   npm install markdown-it markdown-it-source-map
   ```

5. **Register commands** in `package.json`: e.g. `ask-markdown.openPreview`, `ask-markdown.askAboutSelection`. Optionally bind a key (e.g. **Ctrl+Shift+M**) to open the custom preview.

**Check that it builds:**

```bash
npm run compile
```

Use `npm run build` or `npm run package` instead if that is what your `package.json` defines.

---

## Phase 2 — Daily workflow

**What:** Edit code → build → run the extension in a test window.

**How:**

| Step | Command |
|------|---------|
| Build | `npm run compile` |
| Watch while coding | `npm run watch` (if present) |
| Tests | `npm test` |
| Lint | `npm run lint` (if present) |

**Run the extension:** **F5** or **Run → Start Debugging** from the extension folder.

**Make a `.vsix` to install locally:**

```bash
npm install -D @vscode/vsce
npm run compile
npx vsce package
```

Install it: **Extensions** → **…** → **Install from VSIX…**.

---

## Phase 3 — Custom markdown preview (webview)

**What:** Show rendered markdown in a webview, tag blocks with source lines, capture selection.

**How:**

1. Add **`previewProvider.ts`:** create/update a webview panel, render with `markdown-it`, refresh when the document changes.
2. **Tag HTML:** set `data-source-line` / `data-source-line-end` on blocks using `token.map` from markdown-it where possible.
3. Add **`media/preview.css`:** use VS Code theme variables; style selection and a floating Ask control.
4. Add **`media/preview.js`:** on selection, read text + line info, then:

   ```js
   vscode.postMessage({
     type: "askAboutSelection",
     text: selectedText,
     startLine,
     endLine
   });
   ```

---

## Phase 4 — Bridge: webview → editor → AI

**What:** Turn webview selection into a source selection and trigger AI.

**How:**

1. **`selectionBridge.ts`:** handle `askAboutSelection`, open the markdown file, set the editor selection to the mapped range.
2. **`sourceMapper.ts`:** map `{ startLine, endLine }` to a solid `vscode.Range` (including multi-block and edge cases).
3. **Call Cursor:** `vscode.commands.executeCommand(...)` with the chat/ask command you discover (make IDs configurable).
4. **If that fails:** keep text selected, show a message, optionally copy to clipboard or open chat manually.

---

## Phase 5 — Find stable Cursor commands

**What:** Know which command IDs work for “ask about selection” in Cursor.

**How:**

1. Call `vscode.commands.getCommands(true)` and search names for chat / AI / cursor.
2. Try each candidate with a real selection; note what works in your Cursor version.
3. Prefer settings for command IDs so you can change them without a new release.

---

## Phase 6 — Polish

**What:** Make the UX feel built-in.

**How:**

- Floating actions: Ask, Copy, Find in source; hide when selection clears.
- Optional: scroll sync between preview and editor; click preview to jump in source.
- Support light / dark / high contrast; keyboard access for actions.
- Optional status bar + settings, e.g. `ask-markdown.autoOpen`, `ask-markdown.selectionMode`, `ask-markdown.showFloatingButton`.

---

## Phase 7 — Testing

**What:** Catch mapping bugs before users do.

**How:**

1. Unit tests for line mapping and markdown-it attributes.
2. Integration: open MD, select in preview, assert editor range.
3. Manual pass: headings, lists, quotes, code fences, tables, links, images, front matter, large files.

```bash
npm test
```

---

## Phase 8 — Ship

**What:** Build a release artifact and publish if you want.

**How:**

1. Run your production build (`npm run package` or `npm run compile` depending on scripts).
2. `npx vsce package` → install or share the `.vsix`.
3. Document usage, limits, and fallbacks (README + screenshots or GIF).
4. To publish: `vsce login` / PAT, then `npx vsce publish`. Add issue templates for regressions.

---

## Risks

| Risk | What to do |
|------|------------|
| Cursor changes command IDs | Configurable IDs + fallbacks |
| Tricky selections | Clear rules for block ranges and expansion |
| Webview security | Nonces, sanitize HTML, avoid unsafe inline scripts |
| Two previews (built-in vs yours) | Clear command names and README |
