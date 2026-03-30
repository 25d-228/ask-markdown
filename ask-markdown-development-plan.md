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

---

## Agent Prompt Decomposition

Use the prompts below one-by-one with an AI coding agent. Each step is self-contained and includes deliverables and acceptance criteria.

### Step 1: Bootstrap extension project

**Prompt to agent:**

```text
Create a TypeScript VS Code extension scaffold for project "ask-markdown".
Requirements:
- Activation on markdown files.
- Commands: ask-markdown.openPreview and ask-markdown.askAboutSelection.
- Source folders: src/ and media/.
- Build tooling with TypeScript and esbuild.

Deliverables:
- package.json contributions and scripts
- tsconfig.json
- src/extension.ts with command registration
- placeholder files: src/previewProvider.ts, src/selectionBridge.ts, src/sourceMapper.ts, src/commands.ts, media/preview.js, media/preview.css

Acceptance:
- Project compiles successfully.
- Both commands appear in command palette.
```

### Step 2: Implement custom markdown preview panel

**Prompt to agent:**

```text
Implement a webview-based markdown preview for ask-markdown.
Requirements:
- ask-markdown.openPreview opens a panel beside the active editor.
- Render active markdown document using markdown-it.
- On document edits, refresh preview content.
- Keep implementation modular in src/previewProvider.ts.

Deliverables:
- Working preview panel with rendered markdown.
- Basic CSS theme support via VS Code CSS vars.

Acceptance:
- Opening command renders the current .md file.
- Editing markdown updates preview without reopening.
```

### Step 3: Add source-line mapping metadata

**Prompt to agent:**

```text
Add source line metadata to rendered markdown blocks.
Requirements:
- Add data-source-line and data-source-line-end attributes where token.map is available.
- Cover common block tokens: headings, paragraphs, list items, blockquotes, code blocks, tables.
- Keep metadata generation in a dedicated helper/plugin.

Deliverables:
- markdown-it integration that emits source attributes in HTML.
- Unit tests for metadata injection.

Acceptance:
- Rendered HTML shows expected data-source-line attributes on block elements.
```

### Step 4: Capture selection in webview and send to extension host

**Prompt to agent:**

```text
Implement preview-side selection capture in media/preview.js.
Requirements:
- Detect non-empty text selection.
- Resolve nearest source-line metadata for anchor/focus nodes.
- Show a floating "Ask Cursor" button near selection.
- On click, post message:
  { type: "askAboutSelection", text, startLine, endLine }.

Deliverables:
- Selection detection logic.
- Floating button UI and interactions.
- Message bridge to extension host.

Acceptance:
- Selecting rendered text shows button.
- Clicking button sends correct payload to extension.
```

### Step 5: Bridge message to source editor selection

**Prompt to agent:**

```text
Implement extension-host message handling in src/selectionBridge.ts.
Requirements:
- Receive askAboutSelection messages from webview.
- Open source markdown document in editor.
- Convert line info into vscode.Range via sourceMapper.
- Programmatically select that source range.

Deliverables:
- Message handler wiring from preview provider.
- sourceMapper implementation for robust line-to-range conversion.

Acceptance:
- After selecting text in preview and clicking Ask, the source editor highlights mapped lines.
```

### Step 6: Add AI command invocation with fallback behavior

**Prompt to agent:**

```text
Implement AI invocation after source selection.
Requirements:
- Attempt configured command IDs via vscode.commands.executeCommand.
- If command fails, fallback to:
  1) keep source selection,
  2) copy selected text to clipboard,
  3) show actionable instruction message.
- Make command IDs configurable in extension settings.

Deliverables:
- Invocation service/helper.
- Settings schema in package.json.
- Clear user notifications for fallback path.

Acceptance:
- Successful path triggers configured command.
- Failure path degrades gracefully without crashes.
```

### Step 7: UX polish and optional sync features

**Prompt to agent:**

```text
Polish UX for ask-markdown extension.
Requirements:
- Improve floating button positioning and dismissal rules.
- Add optional preview->source reveal on block click.
- Add status bar item when preview bridge is active.
- Ensure keyboard accessibility and theme compatibility.

Deliverables:
- Updated preview JS/CSS and extension status-bar wiring.
- Settings toggles for optional behaviors.

Acceptance:
- Interaction feels stable in light/dark themes.
- No broken focus traps; keyboard navigation works.
```

### Step 8: Testing and validation suite

**Prompt to agent:**

```text
Add tests for ask-markdown core behavior.
Requirements:
- Unit tests for source mapper and metadata injection.
- Integration test for selection flow (preview event -> editor range selection).
- Document manual QA checklist in README.

Deliverables:
- Test files and scripts.
- README section for manual test scenarios and expected results.

Acceptance:
- Tests pass locally.
- Manual QA checklist covers markdown edge cases.
```

### Step 9: Package and release readiness

**Prompt to agent:**

```text
Prepare ask-markdown for packaging and release.
Requirements:
- Ensure production build output is clean.
- Add README usage docs with screenshots placeholders.
- Add CHANGELOG and LICENSE.
- Configure .vscodeignore for lean package.

Deliverables:
- Release-ready repository state.
- Verified .vsix generation command documented.

Acceptance:
- Extension packages successfully.
- Docs explain install, usage, settings, and known limitations.
```

### Step 10: Hardening pass for Cursor compatibility

**Prompt to agent:**

```text
Run a hardening pass focused on Cursor compatibility.
Requirements:
- Enumerate available command IDs and log capability detection at activation.
- Ensure extension still works when direct AI command hook is unavailable.
- Add troubleshooting section for command ID changes between Cursor versions.

Deliverables:
- Capability detection utility.
- Improved fallback messaging.
- Troubleshooting docs in README.

Acceptance:
- Core flow (selection -> source highlight) works regardless of AI command availability.
- Users get clear guidance when integration command cannot be executed.
```
