# ask-markdown

A VS Code / Cursor extension that turns markdown files into interactive, rendered previews with LaTeX support. Select any passage in the preview, click a button, and send it directly to Claude Code or Codex CLI with the exact file and line reference — no manual copying required.

## Features

- **Default markdown editor** — `.md` files open in the rendered preview automatically. Toggle back to VS Code's native source editor with the `</>` button or the title bar icon.
- **LaTeX rendering** — Inline `$...$` and display `$$...$$` math via KaTeX.
- **Selection action bar** — Select text in the preview to get a floating toolbar with Claude, Codex, and Find in source buttons.
- **Click-to-jump** — Double-click any block in the preview to jump to its source line.
- **Scroll sync** — Scrolling the source editor scrolls the preview to match.
- **Theme-aware** — The preview follows your VS Code light, dark, or high-contrast theme.

## Claude Code integration

ask-markdown runs an MCP-compatible WebSocket server that Claude Code connects to automatically.

**How it works:**

1. On activation, the extension starts a WebSocket server on a random port and writes a lock file to `~/.claude/ide/{port}.lock`.
2. Claude Code discovers the lock file, reads the auth token, and connects via WebSocket.
3. When you select text in the preview and click **Claude**, the extension broadcasts an `at_mentioned` notification over the WebSocket with the file path and line range.
4. Claude Code receives the file reference (e.g. `@file.md:10-20`) in its context.

The server speaks the MCP protocol (`2024-11-05`) with JSON-RPC 2.0, and exposes three tools: `getCurrentSelection`, `getOpenEditors`, and `getWorkspaceFolders`.

**Usage:** Run `claude` in a terminal inside your workspace. The Debug Console will log `[ask-markdown] Claude CLI connected`. Then select text and click Claude.

## Codex CLI integration

Codex CLI has no IDE server discovery mechanism, so ask-markdown uses **terminal text injection** — the same approach as codex.nvim.

**How it works:**

1. When you click **Codex** in the action bar, the extension formats an `@file:line-line` mention.
2. If one terminal is open, the mention is pasted directly into it.
3. If multiple terminals are open, a quick pick lets you choose which one.
4. If no terminals are open, a new terminal is created with `codex` launched, and the mention is copied to your clipboard (paste it once Codex is ready).

The `@file:line` syntax is Codex CLI's native file reference format. The file path is relative to the workspace root.

**Usage:** Open a terminal and run `codex`. Then select text in the preview and click Codex. The file mention appears in the terminal input, ready for you to type your question and press Enter.

## Requirements

- VS Code 1.85+ or Cursor
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI for the Claude button
- [Codex CLI](https://github.com/openai/codex) for the Codex button

## Extension settings

- `ask-markdown.autoOpen` — Automatically open the preview when a markdown file is opened (default: `true`).
- `ask-markdown.showFloatingButton` — Show the floating action bar when text is selected in the preview (default: `true`).

## Known issues

- The Codex 0-terminal case has a race condition: `codex` takes time to start, so the mention is copied to the clipboard instead of pasted directly.
- KaTeX requires `unsafe-inline` in the style CSP directive due to its inline `style` attributes.
