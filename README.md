# ask-markdown

A VS Code / Cursor extension that renders markdown files with LaTeX support. Select text in the preview and send it to Claude Code with the exact file and line reference.

## Features

- **Rendered preview** — `.md` files open in a rendered preview.
- **Inline source editor** — The `</>` button toggles a syntax-highlighted, editable source view with line numbers. Edits sync back to the file in real time.
- **PDF export** — The **PDF** toolbar button opens a menu with four styles (Clean, GitHub, Academic, Keep Theme). Pick a style and an output path; the extension renders the PDF using a locally installed Chromium-based browser (Chrome, Chromium, Edge, or Brave).
- **LaTeX** — Inline `$...$` and display `$$...$$` math via KaTeX.
- **Syntax highlighting** — Fenced code blocks are highlighted using `highlight.js`, with colors that match your VS Code theme.
- **Selection action bar** — Select text to get a floating toolbar with **Add** (send to Claude Code), **Inline Edit** (rewrite via Claude), **Translate** (English dictionary lookup with IPA), and **Find in source**.
- **Code block copy** — Hover a rendered code block to reveal a copy button.
- **Clickable links** — Click links in the preview (or Ctrl/Cmd-click in the source editor) to follow them. Fragment links (`#heading`) scroll in place, relative `.md` paths open in Ask Markdown, everything else opens externally.
- **Bidirectional scroll sync** — Scrolling either the source editor or the preview keeps the other in sync.
- **Theme-aware** — Follows your VS Code light/dark/high-contrast theme.

## Claude Code integration

The extension runs an MCP-compatible WebSocket server. Claude Code discovers it through a lock file in `~/.claude/ide/`.

### How to use

1. Install the extension and open a markdown file.
2. Run `claude` in a terminal.
3. Run `/ide` inside Claude Code and select **Ask Markdown**.
4. Select text in the preview and click **Add**. The terminal gets focus automatically.

Claude Code receives the file reference (e.g. `@file.md:10-20`) in its context.

### Cursor workaround

When running Claude Code inside Cursor's integrated terminal, `/ide` only shows Cursor's own server. Ask Markdown's server is hidden because Cursor sets `TERM_PROGRAM=vscode` in its terminal, and Claude Code uses this to filter which IDE servers to show.

To bypass this, launch Claude Code with `TERM_PROGRAM` cleared:

**fish:**

```
env TERM_PROGRAM= claude
```

**zsh / bash:**

```
TERM_PROGRAM= claude
```

Then run `/ide` and select Ask Markdown.

This is not needed when running Claude Code from an external terminal (outside Cursor).

## Requirements

- VS Code 1.85+ or Cursor
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- Google Chrome, Chromium, Microsoft Edge, or Brave — only for **PDF export**

## Extension settings

- `ask-markdown.defaultEditor` — Use Ask Markdown as the default editor for `.md` files (default: `false`).
- `ask-markdown.showFloatingButton` — Show the floating action bar when text is selected (default: `true`).
- `ask-markdown.translateEnabled` — Show the Translate button in the floating action bar (default: `true`).

## Known issues

- Inside Cursor's integrated terminal, Claude Code cannot discover Ask Markdown's server without the `TERM_PROGRAM` workaround described above.
- KaTeX requires `unsafe-inline` in the style CSP directive due to its inline `style` attributes.
