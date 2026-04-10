# ask-markdown

A VS Code / Cursor extension that renders markdown files with LaTeX support. Select text in the preview, click a button, and send it to Claude Code or Codex CLI with the exact file and line reference.

## Features

- **Rendered preview** — `.md` files open in a rendered preview. Toggle back to source with the `</>` button.
- **LaTeX** — Inline `$...$` and display `$$...$$` math via KaTeX.
- **Selection action bar** — Select text to get a floating toolbar with Claude, Codex, and Find in source buttons.
- **Click-to-jump** — Double-click any block to jump to its source line.
- **Scroll sync** — Scrolling the source editor scrolls the preview.
- **Theme-aware** — Follows your VS Code light/dark/high-contrast theme.

## Claude Code integration

The extension runs an MCP-compatible WebSocket server. Claude Code discovers it through a lock file in `~/.claude/ide/`.

### How to use

1. Install the extension and open a markdown file.
2. Run `claude` in a terminal.
3. Run `/ide` inside Claude Code and select **Ask Markdown**.
4. Select text in the preview and click **Claude**. The terminal gets focus automatically.

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

## Codex CLI integration

Codex CLI has no IDE server discovery, so ask-markdown uses **terminal text injection** instead — it pastes the file reference directly into the terminal.

### How to use

1. Open a terminal and run `codex`.
2. Select text in the preview and click **Codex**. The terminal gets focus automatically.
3. The `@file:line-line` mention appears in the terminal input. Type your question and press Enter.

If multiple terminals are open, a quick pick lets you choose which one. If no terminal is open, a new one is created with `codex` launched and the mention is copied to your clipboard.

## How the two integrations differ

| | Claude Code | Codex CLI |
|---|---|---|
| Connection | WebSocket server (MCP protocol) | Terminal text injection |
| Discovery | Lock file in `~/.claude/ide/` | None (pastes into terminal) |
| Setup | Run `claude`, then `/ide` | Run `codex` in a terminal |
| What happens on click | Broadcasts file reference over WebSocket | Pastes `@file:line` into terminal |

## Requirements

- VS Code 1.85+ or Cursor
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) for the Claude button
- [Codex CLI](https://github.com/openai/codex) for the Codex button

## Extension settings

- `ask-markdown.defaultEditor` — Use Ask Markdown as the default editor for `.md` files (default: `false`).
- `ask-markdown.showFloatingButton` — Show the floating action bar when text is selected (default: `true`).

## Known issues

- Codex with no open terminal: `codex` takes time to start, so the mention is copied to clipboard instead of pasted directly.
- Inside Cursor's integrated terminal, Claude Code cannot discover Ask Markdown's server without the `TERM_PROGRAM` workaround described above.
