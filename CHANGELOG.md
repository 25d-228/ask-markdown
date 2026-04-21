# Changelog

## 0.3.28 - 2026-04-21

- Drop the Accept / Reject buttons from the rendered markdown diff — the decision is now driven entirely from the Claude Code terminal prompt, and the webview resolves `FILE_SAVED` or `DIFF_REJECTED` based on whether the file on disk matches the proposed contents once the panel is dismissed
- Scope `close_tab` / `closeAllDiffTabs` to also dismiss the rendered-diff webview so Claude's post-decision close call clears the panel

## 0.3.27 - 2026-04-21

- Fix a regression in 0.3.26 where opening a markdown file with Ask Markdown hung on the loading progress bar — the rendered-diff module introduced an import cycle that caused the extension to fail activation silently

## 0.3.26 - 2026-04-21

- Render Claude Code diffs for markdown files as a side-by-side rendered preview with line-level red/green highlights and Accept/Reject buttons, instead of the plain source-text diff
- Add a toolbar search bar next to `</>` that searches both rendered and source views, with ↑/↓ (or Enter / Shift+Enter) to jump between matches, a match counter, and smooth scrolling for nearby jumps
- Make `</>` carry the current text selection to the other view (like "Find in source / Find in preview") when something is selected, instead of toggling to the top-visible line

## 0.3.25 - 2026-04-21

- Scope the `close_tab` MCP tool to diff tabs so Claude Code's accept-diff flow no longer closes a plain editor the user already had open for the same file

## 0.3.24 - 2026-04-21

- Advertise `close_tab` and `closeAllDiffTabs` MCP tools so Claude Code's accept-diff flow can dismiss the diff tab it opened, instead of leaving it behind after the edit lands

## 0.3.23 - 2026-04-21

- Close the Claude Edit diff tab automatically after the user saves (approves) the proposed change, instead of leaving it open pointing at a deleted temp file

## 0.3.22 - 2026-04-18

- Fix source-mode scroll drift where the syntax-highlighted layer moved at a different range than the textarea — the highlight renderer was appending an extra trailing newline on top of the one `split('\n')` already reconstructs, making the highlight div one line taller than the textarea and causing the visible text to slide out of alignment with the cursor and selection during scroll

## 0.3.21 - 2026-04-18

- Render the translate bar with structured rows — IPA on top and a part-of-speech × definition grid — instead of a plain text block
- Suppress the selection action bar after Find in source / Find in preview jumps until the user takes a fresh mouse or key input, so the programmatic selection in the target view doesn't re-open the bar

## 0.3.20 - 2026-04-18

- Convert 1-based preview selection line numbers to 0-based LSP positions before broadcasting `askClaude` requests, so the @-mention range Claude renders matches the selection
- Drop the phantom trailing line that triple-click / line-select picks up past the last newline, so "one line selected" reports one line

## 0.3.19 - 2026-04-18

- Render PDF exports via a locally installed Chromium-based browser (Chrome, Chromium, Edge, or Brave) instead of relying on the webview print dialog
- Report fine-grained line ranges when selecting inside a table (per-row) or a fenced code block (per-line), rather than always sending the whole block
- Fix an off-by-one in preview selection line ranges caused by markdown-it including trailing blank lines in paragraph source maps
- Drop the "Open in Editor" toolbar button

## 0.3.18 - 2026-04-18

- Add a **PDF** toolbar button with four print-style presets (Clean, GitHub, Academic, Keep Theme) that drives the browser print dialog for "Save as PDF"
- Make links in the preview clickable — fragment links (`#heading`) scroll in place, relative `.md` paths open in Ask Markdown, everything else opens externally via the host
- Ctrl/Cmd-click on links in the source editor to follow them
- Generate GitHub-style heading slug IDs so fragment links resolve against rendered headings
- Rename the "Edit" toolbar button to "Open in Editor"
- Suppress the selection action bar after dismissing the translate bar until the user makes a new selection
- Refresh the extension icon

## 0.3.17 - 2026-04-17

- Clean up stale Ask Markdown lock files in `~/.claude/ide/` on startup so `/ide` no longer lists dead instances
- Show a red "Copy failed" state on the code-block copy button when the clipboard write is rejected, and update the tooltip to reflect Copied / Copy failed / Copy code
- Wrap the selected text in `<selection>` tags in the inline-edit prompt sent to Claude
- Surface the tail of Claude's stdout in the inline-edit error toast when the process exits non-zero with empty stderr
- Open the target in the default editor directly when clicking Edit (no longer tries the built-in Markdown preview editor first)
- Drop the workspace-wide `<stem>.md` fallback when resolving preview tab labels to a markdown URI

## 0.3.16 - 2026-04-17

- Update README to reflect the Add / Inline Edit / Translate toolbar, code-block copy button, and `translateEnabled` setting; drop the stale double-click-to-jump entry

## 0.3.15 - 2026-04-17

- Replace the Claude-backed Translate action with a dictionary lookup (IPA + short definitions) via dictionaryapi.dev
- Replace the `ask-markdown.outputLanguage` setting with `ask-markdown.translateEnabled` to toggle the Translate button
- Live-update the Translate button's visibility when the setting changes

## 0.3.14 - 2026-04-17

- Maintenance release

## 0.3.13 - 2026-04-17

- Dismiss the translate bar on any click outside it
- Disallow all tools in the translate Claude invocation

## 0.3.12 - 2026-04-16

- Pin the inline-edit Claude invocation to the `sonnet` model

## 0.3.11 - 2026-04-16

- Add inline edit bar that rewrites the selected text via Claude
- Add translate bar that renders a translation of the selected text into the configured output language
- Add hover copy button to rendered code blocks
- Rename the preview toolbar "Claude" action to "Add" and add "Inline Edit" and "Translate" actions
