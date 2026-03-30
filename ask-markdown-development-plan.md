# ask-markdown Development Plan

## Overview

Build a VS Code / Cursor extension that lets users select rendered text in a markdown preview and ask Cursor AI about that selection. The extension bridges markdown preview webview selection and editor-selection-based AI workflows.

---

## Phase 1: Project Scaffold

**Goal:** Set up extension boilerplate and tooling.

### Tasks

1. **Initialize extension project**
   - Use `yo code` to scaffold a TypeScript VS Code extension.
   - Target `vscode` engine `^1.85.0` (or latest stable).
   - Activation event: `onLanguage:markdown`.

2. **Create project structure**

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

3. **Dependencies**
   - Runtime: `markdown-it`.
   - Mapping: `markdown-it-source-map` (or custom plugin).
   - Dev: `typescript`, `@types/vscode`, `esbuild`.

4. **Contribute extension commands**
   - `ask-markdown.openPreview`
   - `ask-markdown.askAboutSelection`
   - Optional keybinding: `Ctrl+Shift+M` to open custom preview.

---

## Phase 2: Custom Markdown Preview Webview

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

## Phase 3: Selection Bridge (Webview -> Editor -> AI)

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

## Phase 4: UX Polish

**Goal:** Make the feature feel native and ergonomic.

### Tasks

1. **Floating action UX**
   - Show actions on text selection: Ask Cursor, Copy, Find in Source.
   - Dismiss on blur / empty selection.

2. **Sync behavior**
   - Optional scroll sync preview <-> source editor.
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

## Phase 5: Cursor Integration Discovery

**Goal:** Identify stable command strategy for sending selected context to AI.

### Tasks

1. **Enumerate available commands**
   - Use `vscode.commands.getCommands(true)` and filter for relevant chat/ai/cursor terms.

2. **Validate command behavior**
   - Test commands with selected markdown ranges and argument payloads.
   - Capture version-specific notes.

3. **Design for resilience**
   - Graceful fallback when commands are unavailable or changed.
   - Add diagnostics logs for supportability.

---

## Phase 6: Testing

### Tasks

1. **Unit tests**
   - Source-line mapping behavior.
   - Markdown-it data attribute injection.

2. **Integration tests**
   - Open markdown, render preview, simulate selection, verify editor range selection.

3. **Manual matrix**
   - Headings, paragraphs, lists, blockquotes.
   - Fenced code blocks.
   - Tables, images, links.
   - YAML frontmatter.
   - Large markdown files (1000+ lines).

---

## Phase 7: Packaging and Release

### Tasks

1. **Build and package**
   - Bundle extension with `esbuild`.
   - Produce `.vsix` via `vsce package`.

2. **Documentation**
   - Usage flow screenshots/GIF.
   - Known limitations and fallback behavior.

3. **Publish**
   - Publish to VS Code marketplace for Cursor compatibility.
   - Add issue templates for integration regressions.

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
