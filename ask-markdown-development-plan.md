# ask-markdown Development Plan

## Overview

Build a VS Code / Cursor extension that lets users select rendered text in a markdown preview and ask Cursor AI about that selection. The extension bridges markdown preview webview selection and editor-selection-based AI workflows.

This document assumes you work from **WSL2 (Linux)** and use **Cursor or VS Code with the Remote - WSL** extension so the editor runs against your Linux filesystem and toolchain.

---

## Prerequisites (WSL): what to install

Install these once in your WSL distro (Ubuntu is typical). Run updates first if the distro is new.

```bash
sudo apt update && sudo apt upgrade -y
```

| Need | Purpose |
|------|---------|
| **Node.js LTS** (20.x or 22.x) | Extension build, `npm`, `npx` |
| **Git** | Clone and version control |
| **build-essential** | Optional; some native npm deps may need a compiler |

**Scaffolding the official VS Code extension template** (used in Phase 1) — run from your projects parent directory (e.g. `~/GitHub/SIDES`) without installing `yo` globally; `npx` pulls Yeoman and `generator-code` as needed:

```bash
npx -p yo -p generator-code yo code
```

**Packaging / publishing** (Phase 2 and Phase 8): add the CLI as a **devDependency** in the extension repo and invoke it with `npx` (no global `vsce`):

```bash
npm install -D @vscode/vsce
# then: npx vsce package   or   npx vsce publish
```

**Editor**: Install **Cursor** or **VS Code** on Windows, enable **Remote - WSL**, and open the repo folder from WSL (`File → Open Folder` → `\\wsl$\...` or use “Open in WSL” from a `\\wsl.localhost\...` path). Extension development and **F5 “Run Extension”** work from the WSL-connected window.

---

## Phase 1 — Bootstrap: scaffold and dependencies

**Goal:** Create the extension project, install npm dependencies, and verify a compile.

### Tasks

1. **Initialize extension project**
   - From WSL, `cd` to where you keep projects (e.g. `~/GitHub/SIDES`).
   - Run `npx -p yo -p generator-code yo code` and choose **New Extension (TypeScript)**.
   - Target `vscode` engine `^1.85.0` (or latest stable).
   - Activation event: `onLanguage:markdown` (adjust in generated `package.json` if needed).

```bash
cd ~/GitHub/SIDES   # or your parent directory
npx -p yo -p generator-code yo code
# Follow prompts; then:
cd ask-markdown     # or the folder name you chose
npm install
```

2. **Create / align project structure** (evolve the scaffold toward this layout as you implement):

   ```text
   ask-markdown/
   ├── src/
   │   ├── extension.ts          # Entry point
   │   ├── previewProvider.ts     # Webview panel provider
   │   ├── selectionBridge.ts     # Webview -> editor mapping
   │   ├── sourceMapper.ts        # Rendered selection -> source lines
   │   └── commands.ts            # Command registration
   ├── media/
   │   ├── preview.js             # Webview client JS
   │   └── preview.css            # Webview styles
   ├── package.json
   ├── tsconfig.json
   ├── .vscodeignore
   └── README.md
   ```

3. **Dependencies** (add with `npm install` as you adopt them)
   - Runtime: `markdown-it`.
   - Mapping: `markdown-it-source-map` (or custom plugin).
   - Dev: `typescript`, `@types/vscode`, `esbuild`.

```bash
npm install markdown-it markdown-it-source-map
npm install -D esbuild
# typescript and @types/vscode are usually already from yo code
```

4. **Contribute extension commands** in `package.json`
   - `ask-markdown.openPreview`
   - `ask-markdown.askAboutSelection`
   - Optional keybinding: `Ctrl+Shift+M` to open custom preview.

**Verify:**

```bash
npm run compile
# or: npm run build — use whatever script yo code generated
```

---

## Phase 2 — Daily development: commands you run from WSL

**Goal:** Repeatable edit → build → run loop.

| Action | Command (from repo root in WSL) |
|--------|----------------------------------|
| One-off compile | `npm run compile` |
| Watch mode (if configured) | `npm run watch` |
| Run tests (when added) | `npm test` |
| Lint (if added) | `npm run lint` |

**Run the extension:** In Cursor/VS Code (WSL window), open the repo → **Run → Start Debugging** or press **F5**. A new **Extension Development Host** window opens with your extension loaded.

**Package a VSIX (when ready):**

```bash
npm install -D @vscode/vsce   # once per project
npm run compile
npx vsce package
# Produces e.g. ask-markdown-0.0.1.vsix
```

Install locally: **Extensions** view → **…** → **Install from VSIX…** and pick the file.

---

## Phase 3 — Implementation: custom markdown preview webview

**Goal:** Render markdown with source-line annotations and capture selection.

### Tasks

1. **Build `previewProvider.ts`**
   - Create and manage a webview panel.
   - Render active markdown content with `markdown-it`.
   - Listen for document changes and refresh preview.

2. **Add source-line metadata**
   - Inject `data-source-line` and `data-source-line-end` on block-level rendered elements.
   - Use `token.map` from markdown-it tokens where available.

3. **Implement `media/preview.css`**
   - Theme-aware styles using VS Code CSS variables.
   - Subtle hover and selection affordances.
   - Floating Ask button styles.

4. **Implement `media/preview.js`**
   - Listen to selection events (`selectionchange`/`mouseup`).
   - Collect selected text and nearest source-line attributes.
   - Show floating action button.
   - Post message to extension:

   ```js
   vscode.postMessage({
     type: "askAboutSelection",
     text: selectedText,
     startLine,
     endLine
   });
   ```

---

## Phase 4 — Implementation: selection bridge (webview → editor → AI)

**Goal:** Route rendered selection into Cursor AI via source selection.

### Tasks

1. **Implement `selectionBridge.ts`**
   - Handle webview messages (`askAboutSelection`).
   - Open source markdown in editor (`showTextDocument`).
   - Apply editor selection to mapped line range.

2. **Implement `sourceMapper.ts`**
   - Convert `{startLine, endLine}` into robust `vscode.Range`.
   - Handle multi-block selections.
   - Expand partial block selections to deterministic source ranges.

3. **Trigger AI command**
   - Attempt command invocation through `executeCommand` for Cursor chat/ask actions.
   - Keep command IDs configurable to reduce breakage risk.

4. **Fallback chain**
   - If command invocation fails:
     1. Keep source lines selected and show instruction toast.
     2. Optionally copy selected text to clipboard.
     3. Open chat panel as helper step.

---

## Phase 5 — Integration: Cursor command discovery

**Goal:** Identify a stable strategy for sending selected context to AI.

### Tasks

1. **Enumerate available commands**
   - Use `vscode.commands.getCommands(true)` and filter for relevant chat/ai/cursor terms.

2. **Validate command behavior**
   - Test commands with selected markdown ranges and argument payloads.
   - Capture version-specific notes.

3. **Design for resilience**
   - Graceful fallback when commands are unavailable or changed.
   - Add diagnostics logs for supportability.

**Optional one-off in DevTools / temporary command:** log commands while exercising the UI; no separate WSL CLI is required beyond running the extension host.

---

## Phase 6 — Polish: UX and settings

**Goal:** Make the feature feel native and ergonomic.

### Tasks

1. **Floating action UX**
   - Show actions on text selection: Ask Cursor, Copy, Find in Source.
   - Dismiss on blur / empty selection.

2. **Sync behavior**
   - Optional scroll sync preview ↔ source editor.
   - Click preview block to reveal source.

3. **Theming and accessibility**
   - Support light/dark/high-contrast themes.
   - Ensure keyboard accessibility for action controls.

4. **Status and settings**
   - Status bar indicator when preview bridge is active.
   - Settings:
     - `ask-markdown.autoOpen`
     - `ask-markdown.selectionMode`
     - `ask-markdown.showFloatingButton`

---

## Phase 7 — Quality: testing

### Tasks

1. **Unit tests**
   - Source-line mapping behavior.
   - Markdown-it data attribute injection.

```bash
npm test
```

2. **Integration tests**
   - Open markdown, render preview, simulate selection, verify editor range selection.

3. **Manual matrix**
   - Headings, paragraphs, lists, blockquotes.
   - Fenced code blocks.
   - Tables, images, links.
   - YAML frontmatter.
   - Large markdown files (1000+ lines).

---

## Phase 8 — Ship: packaging and release

### Tasks

1. **Build and package**
   - Bundle extension with `esbuild` (if that is your pipeline).
   - Produce `.vsix` via `npx vsce package` (with `@vscode/vsce` installed locally in the project).

```bash
npm install -D @vscode/vsce   # if not already added
npm run compile
npx vsce package
```

2. **Documentation**
   - Usage flow screenshots/GIF.
   - Known limitations and fallback behavior.

3. **Publish**
   - Publish to VS Code marketplace for Cursor compatibility.
   - Add issue templates for integration regressions.

```bash
# After vsce login / PAT setup (see VS Code publishing docs)
npx vsce publish
```

---

## Key Risks and Mitigations

1. **Cursor command API instability**
   - Mitigation: configurable command IDs + fallback chain.

2. **Selection mapping edge cases**
   - Mitigation: block-level expansion + deterministic line-range rules.

3. **Webview CSP and security constraints**
   - Mitigation: strict nonce usage, sanitize rendered HTML, avoid inline scripts.

4. **User confusion with dual previews**
   - Mitigation: clear command naming, optional auto-open, concise onboarding in README.
