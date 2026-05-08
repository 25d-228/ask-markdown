# Agent Integration Direction

The architectural story for how ask-markdown talks to AI coding agents — today's state, where it's going, and why.

---

## Contents

1. [Where ask-markdown sits today](#1-where-ask-markdown-sits-today)
2. [The two roles in the agent ecosystem](#2-the-two-roles-in-the-agent-ecosystem)
3. [Why ACP is the right next step](#3-why-acp-is-the-right-next-step)
4. [What ACP gives you for free](#4-what-acp-gives-you-for-free)
5. [Why we ruled out opencode-as-broker](#5-why-we-ruled-out-opencode-as-broker)
6. [Plan](#6-plan)
7. [Anti-patterns to avoid](#7-anti-patterns-to-avoid)
8. [Open questions](#8-open-questions)
9. [Legacy: the Claude Code MCP path we already have](#9-legacy-the-claude-code-mcp-path-we-already-have)

---

## 1. Where ask-markdown sits today

ask-markdown is a VS Code / Cursor extension that ships an **MCP tool server** specifically tuned for Claude Code's IDE-peer convention:

- WebSocket on a random localhost port
- Lock file at `~/.claude/ide/<port>.lock` so Claude Code can discover us
- Auth via `x-claude-code-ide-authorization` header
- Tool catalog: `getCurrentSelection`, `getLatestSelection`, `getOpenEditors`, `getWorkspaceFolders`, `getDiagnostics`, `openFile`, `openDiff` (markdown branch renders side-by-side), `close_tab`, `closeAllDiffTabs`
- Outbound notifications: `selection_changed` on selection, `at_mentioned` on Add-button click, with terminal focus afterward

Killer flow: select text in the preview → click **Add** → terminal Claude Code receives `at_mentioned` → user types their question → Claude replies with the file/line range in context.

This works well, but is **single-agent by construction**. The discovery, auth, and notification model are all Claude-Code-specific.

## 2. The two roles in the agent ecosystem

Every editor↔agent integration falls into one of two architectural roles. Confusing them is the source of most planning mistakes.

| Role | What it does | Auth burden | Examples |
|---|---|---|---|
| **Agent** (server-side of any protocol) | *Is* the AI — calls the LLM API, runs the agentic loop, owns the system prompt, owns the tool catalog. | Authenticates **to the LLM provider**. API key or OAuth. | Claude Code, opencode, Codex CLI, Kimi CLI, Gemini CLI |
| **Host / Client** (editor-side) | Hosts the UI. Spawns or connects to an agent. Translates editor state into prompts; renders the agent's streamed output. | **None** — the agent handles its own auth. | Zed, JetBrains plugins, Neovim plugins, current ask-markdown (as MCP server, hosting Claude Code in a terminal) |

opencode is firmly in the **agent** column. Its multi-LLM-provider story is internal — `@ai-sdk/anthropic`, `@ai-sdk/openai`, the `BUNDLED_PROVIDERS` registry, `opencode.json` config. ACP isn't in that path; opencode just calls Anthropic / OpenAI / etc. directly through SDKs.

The misconception we had earlier was thinking opencode aggregated *agents*. It doesn't — it aggregates *LLM providers*. Different abstraction.

## 3. Why ACP is the right next step

[ACP (Agent Client Protocol)](https://agentclientprotocol.com/) is what the user originally imagined opencode would be. It standardizes the editor↔agent boundary so a single host can drive any compatible agent.

- **Governance**: `agentclientprotocol` org, Zed-incubated, community-driven.
- **Transport**: JSON-RPC over stdio. Each agent runs as a subprocess of the host.
- **Maturity**: TypeScript SDK at v0.21.x. Stable core, clearly fenced `unstable_*` surface.
- **Adoption**: every agent we care about already speaks it.

| Agent we mentioned | ACP support today | How auth flows |
|---|---|---|
| Claude Code | `@zed-industries/claude-agent-acp` (formerly `claude-code-acp`, now deprecated) — spawns the `claude` native binary bundled via `@anthropic-ai/claude-agent-sdk` | Pro/Max OAuth (from `~/.claude/`) or `ANTHROPIC_API_KEY` — auth is delegated to the spawned CLI |
| Codex CLI | Via `codex-acp` adapter (`cola-io/codex-acp`), not native | ChatGPT subscription via Codex CLI's own OAuth |
| Kimi CLI | Native via `kimi --acp` flag | Kimi's own auth |
| opencode | Native via `opencode acp` | Whatever opencode is set up with (incl. opencode-claude-auth) |
| Gemini CLI | Native, the reference implementation | Google auth |

The critical insight: **ACP wrappers don't impersonate the official CLI — they** ***are*** **the official CLI in subprocess form.** `claude-agent-acp`'s source has no `ANTHROPIC_API_KEY` read; it imports `@anthropic-ai/claude-agent-sdk` and calls `query()`, which spawns a `claude` native binary shipped as a platform-specific optional dependency of the SDK. Both Pro/Max OAuth tokens stored by the bundled CLI in `~/.claude/` and an explicit API key flow through that subprocess. No billing-header signing, no system-prompt validation work-arounds, no version tracking on our side. Anthropic doesn't defend against you because you're not pretending to be Claude Code; you're running it.

This is exactly the asymmetry that made opencode-claude-auth a 2000+-line maintenance burden: opencode-the-agent calls `api.anthropic.com` directly and has to look like Claude Code to use a subscription. An ACP host doesn't call `api.anthropic.com` at all — Claude Code does, on its own behalf.

## 4. What ACP gives you for free

From `@agentclientprotocol/sdk` (verified in the v0.21.x TypeDoc reference):

**Stable surface, ready to ship:**

- `initialize` / `authenticate` — handshake.
- `newSession` / `closeSession` / `loadSession` / `resumeSession` / `listSessions` — multi-session, branchable conversations.
- `prompt(params)` — sends a turn; resolves when the turn ends. While running, the agent emits `sessionUpdate` notifications carrying `agent_message_chunk`, `user_message_chunk`, `thought` (extended thinking), tool-call events, status.
- `cancel(params)` — interrupts in-progress turns.
- Editor-side handlers (the `Client` interface you implement): `readTextFile`, `writeTextFile`, `requestPermission`, `sessionUpdate`. ask-markdown's existing tools map onto these.
- Terminal subsystem: `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release`.
- **Multimodal content**: `text`, `image` (base64 PNG/JPEG), `audio`, `resource` (text or binary blob — works for **PDFs natively**), `resource_link`. Capability-negotiated via the `audio` / `image` / `embeddedContext` agent capability flags.

**`unstable_*` surface (works, but API may shift):**

- Document lifecycle pushes: `unstable_didOpenDocument`, `didChangeDocument`, `didCloseDocument`, `didSaveDocument`, `didFocusDocument`. Closest thing to today's `selection_changed` broadcast.
- Session model/provider switching: `unstable_setSessionModel`, `unstable_listProviders`, `unstable_setProvider`. Lets in-extension UI pick "switch from Claude to Codex" mid-session.
- Session forking: `unstable_forkSession`.
- Next-edit-suggestion: `unstable_startNes`, `unstable_suggestNes`, `unstable_closeNes`, `unstable_acceptNes`, `unstable_rejectNes`. Cursor-style ghost-text edits. Could subsume the current inline-edit feature.

**Escape hatch**: `extMethod(method, params)` and `extNotification(method, params)` for sending JSON-RPC the protocol doesn't define. Use this for "selection_changed" semantics if the document-push shape doesn't fit; agents that don't understand it ignore it.

**The architectural payoff for ask-pdf**: PDFs are first-class content via `resource`. Whatever bridge ask-markdown extracts, ask-pdf inherits with zero new wire-protocol work.

## 5. Why we ruled out opencode-as-broker

We originally considered making opencode the multi-agent layer (Option D in earlier analysis). The path turned out broken on two counts:

- **Architectural**: opencode is an agent, not a host. It doesn't consume other agents. There's no "external agents" config in opencode; `opencode acp` only exposes opencode itself to ACP hosts.
- **Auth**: opencode shipped native Pro/Max OAuth in its built-in Anthropic provider, then removed it in v1.3.0 after Anthropic prohibited third-party clients from using subscription auth. Pro/Max users now need the community `griffinmartin/opencode-claude-auth` plugin — ~2000+ lines across `index.ts`, `credentials.ts`, `signing.ts`, `keychain.ts`, `transforms.ts`, `betas.ts`, `model-config.ts`, `plugin-config.ts`. The signing path uses SHA-256 with a salt that was reverse-engineered out of Claude Code's binary and now sits hardcoded in `signing.ts` (`const BILLING_SALT = "59cf53e54c78"`); plus system-prompt-content work-arounds (rewrite system blocks, prepend the rest as user content) and `mcp_` tool-name prefix translation. Anthropic actively defends the OAuth path server-side; the plugin must track every Claude Code release whose hash, prompt-shape, or beta-header set drifts.

The second point is the deep one: **Anthropic gates subscription access to their server-validated official client.** Anyone calling `api.anthropic.com` while pretending to be Claude Code carries that maintenance burden. The only sustainable way to use a Claude subscription from a third-party tool is to run the real `claude` binary. ACP wrappers do exactly that.

## 6. Plan

Six phases, each landing real value before the next starts.

### Phase 0 — UX validation (1 day, no code)

Use Zed (or the existing VS Code ACP extension `fiyqkrc.vscode-acp-chat`) for a real coding task with `claude-agent-acp`. Confirm: the "agent-as-subprocess + in-editor chat panel" model is something you actually want to build. If you prefer the terminal-driven model, ACP is the wrong path and this whole plan is moot.

Decision criterion: does the Zed-style chat feel like an upgrade over `claude` in a terminal next to ask-markdown? If yes, proceed. If no, the right answer is "stay narrow on Claude Code MCP" and this doc gets shelved until the calculus changes.

### Phase 1 — single-agent ACP prototype (3–5 days)

Inside ask-markdown:

1. Add a chat panel webview (separate from the preview).
2. Take a dependency on `@agentclientprotocol/sdk`.
3. Spawn `claude-agent-acp` as a subprocess via `ClientSideConnection`.
4. Wire prompt input → `connection.prompt()` → stream `sessionUpdate` notifications into the chat UI.
5. Implement the `Client` interface: at minimum `readTextFile`, `writeTextFile`, `requestPermission`, `sessionUpdate`. Map `getCurrentSelection` and friends into the relevant handler returns.
6. Hook the existing **Add** button: insert the current selection as content in the chat input, then send.

Don't generalize. One agent, one path, ship it. The friction tells you where the seams are.

### Phase 2 — second agent (1–2 days)

Swap `claude-agent-acp` for `kimi --acp` or `opencode acp`. Whatever resists is what your eventual library has to abstract. Note the resistance; don't fix it yet.

### Phase 3 — extract the shared library (after Phase 1+2 ship)

Once two agents are working, the seams are obvious. Likely shape: a separate package `ask-acp-bridge` (or whatever name) containing:

- `ClientSideConnection` lifecycle wrapper (spawn, stdio framing, error handling)
- Editor-side tool registry (so ask-markdown registers markdown tools, ask-pdf registers PDF tools)
- Selection / context-push helpers (probably built on `extNotification` until `unstable_didChangeDocument` stabilizes)
- Agent picker UI primitives

The library does **not** contain auth code, agent-specific protocol translation, model selection, or anything LLM-API-shaped. Those live in each agent's ACP server.

ask-markdown imports it and registers markdown-specific tools. Future ask-pdf imports it and registers PDF-specific tools. The chat UI shell stays per-extension (different products, different UX).

### Phase 4 — keep the legacy Claude Code MCP path running (parallel, untouched)

The current WebSocket + lock-file integration with terminal-driven Claude Code stays. Some users (potentially you, day-to-day) still prefer the terminal model. Two coexisting paths:

- **ACP path**: in-extension chat panel, agent-as-subprocess, multi-agent.
- **MCP-server path**: terminal-driven Claude Code, `at_mentioned` flow, single-agent.

Don't deprecate the legacy path until you've used the ACP version for ~a month and confirmed it's a real upgrade. Maybe never deprecate; the two paths serve different workflows.

### Phase 5 — start ask-pdf (only after Phase 3 lands)

ask-pdf consumes the same `ask-acp-bridge` library. Its only new code is PDF-specific UI and PDF-specific tools. Multi-agent is inherited.

## 7. Anti-patterns to avoid

- **Don't build an ACP implementation.** Use the SDK. Zed maintains the protocol; agent vendors maintain their wrappers.
- **Don't build per-agent auth.** That's the agent's job. Every line of auth code in ask-markdown is a line that breaks when an upstream protocol shifts.
- **Don't impersonate Claude Code.** The opencode-claude-auth approach is fundamentally fragile. If the user wants subscription auth, the answer is `claude-agent-acp`, not a reverse-engineered billing header.
- **Don't extract the library before Phase 2 ships.** Premature abstraction designs against assumptions that won't survive the second agent.
- **Don't kill the legacy MCP path early.** It's small and orthogonal to the ACP code. Leave it until the ACP path is proven.
- **Don't add a direct Anthropic / OpenAI SDK dependency.** That puts ask-markdown in the *agent* role and we're explicitly choosing to stay in the *host* role.

## 8. Open questions

These are real, and worth resolving in Phase 0 / Phase 1 rather than designing around assumptions:

- **Context window cap on ACP-routed Claude.** [Zed issue #51648](https://github.com/zed-industries/zed/issues/51648) reports ACP-routed Claude Code is currently 200K context vs 1M on a Max subscription. Whether this is a Claude Code limitation, an ACP wrapper choice, or a Zed-side cap isn't fully clear. For typical markdown documents 200K is fine; verify in your own use before committing if 1M matters.
- **`ANTHROPIC_API_KEY` env var.** If set, Claude Code (and thus the ACP wrapper) falls back to API billing instead of subscription. Default-off subscription path; just confirm the env is clean.
- **Document-push API stability.** The `unstable_didChangeDocument` family is what you'd use for selection sync. Either build conservatively against it (knowing the shape may shift) or use `extNotification` with a custom method until it stabilizes.
- **Bundling vs user-installed agents.** Do you ship `claude-agent-acp` etc. as bundled deps in the VSIX, or have users install them? Affects extension size and update story. Bundling probably wins for first-time UX; leave room to make this configurable.
- **Multiple agents simultaneously.** Memory and startup cost of running 2–3 ACP subprocesses in parallel. Probably fine; worth measuring once Phase 2 ships.
- **Existing competitors in VS Code.** [`fiyqkrc.vscode-acp-chat`](https://marketplace.visualstudio.com/items?itemName=fiyqkrc.vscode-acp-chat) is a generic ACP chat client for VS Code today. ask-markdown's differentiator is the markdown surface (rendered preview, in-place diff, source/preview toggle, KaTeX, PDF export) — not the chat itself. Install it during Phase 0 to learn the UX baseline you need to beat.

## 9. Legacy: the Claude Code MCP path we already have

Reference for maintainers of the existing WebSocket+lock-file integration. Phase 4 keeps this path alive in parallel with the ACP work.

### Architecture

ask-markdown is the **MCP server**. Claude Code (running in the user's terminal) is the **MCP client**. Connection is initiated by Claude when the user runs `/ide` and selects "Ask Markdown."

```
                ┌──────────────────────┐
                │   Claude Code CLI    │   ← runs in terminal
                └──────────────────────┘
                   ▲                ▲
          requests │                │ notifications
          (has id) │                │ (no id)
                   ▼                │
         ┌───────────────────────────────┐
         │   ask-markdown (this ext)    │
         │   WebSocket MCP server        │
         │   127.0.0.1:{random}          │
         └───────────────────────────────┘
```

### Discovery

- Lock file at `$CLAUDE_CONFIG_DIR/ide/<port>.lock` if `CLAUDE_CONFIG_DIR` is set, else `~/.claude/ide/<port>.lock`. **We currently hardcode the latter — see "known gaps" below.**
- Lock JSON: `{ pid, workspaceFolders, ideName: "Ask Markdown", transport: "ws", runningInWindows, authToken }`.
- Auth: WebSocket upgrade requires the `x-claude-code-ide-authorization` header to match the per-session UUID we generated.

### JSON-RPC methods we handle

Inbound from Claude:

- `initialize` — handshake; we declare `tools.listChanged: true`.
- `notifications/initialized` — no response.
- `prompts/list` — return `{ prompts: [] }` to quiet the error path.
- `tools/list` — return our 9-tool catalog.
- `tools/call` — dispatch to handlers.

Outbound to Claude (notifications, no `id`):

- `selection_changed` — debounced on selection change in the preview.
- `at_mentioned` — fired when the user clicks the **Add** button. Followed by `workbench.action.terminal.focus`.

### Tool catalog (current)

| Tool | Implemented | Notes |
|---|---|---|
| `getCurrentSelection` | ✅ | LSP-shaped (0-indexed positions) |
| `getLatestSelection` | ✅ | Cached non-empty selection that survives focus loss |
| `getDiagnostics` | ✅ | Returns `{ content: [] }` (markdown has none) |
| `getOpenEditors` | ✅ | Returns bare `string[]` of paths — see gaps |
| `getWorkspaceFolders` | ✅ | Returns bare `string[]` of fsPaths — see gaps |
| `openFile` | ✅ | `.md`/`.mdx` route to our preview viewType |
| `openDiff` | ✅ | Markdown branch renders side-by-side; others use vscode.diff. Resolves `FILE_SAVED` / `DIFF_REJECTED` |
| `close_tab` | ✅ | Scoped to diff tabs only — won't close user's plain editor |
| `closeAllDiffTabs` | ✅ | Disposes tracked rendered-diff webviews too |

### Known gaps in the legacy path

Low-priority polish, kept for whoever maintains this path:

- **`$CLAUDE_CONFIG_DIR` honor** — `src/server/lockFile.ts` should check the env var before falling back to `~/.claude/ide`.
- **Atomic lock file write** — write to `*.lock.tmp`, rename. Avoids racy partial reads by Claude Code.
- **Keepalive with wake-from-sleep** — the `ws` library supports ping/pong; copying claudecode.nvim's `1.5×` interval heuristic so laptop sleep doesn't kill the connection.
- **Constant-time auth comparison** — `crypto.timingSafeEqual` instead of `===`. No real threat on localhost, but trivially free.
- **Auth header length bounds** — reject tokens <10 or >500 chars before compare.
- **Richer `getOpenEditors` / `getWorkspaceFolders` shapes** — claudecode.nvim returns full tab objects with `isActive`, `languageId`, `selection`, etc. We return bare strings; functional but limited.
- **Broader `initialize` capabilities** — currently only `tools`. Adding `logging`, `prompts`, `resources` (with `subscribe: true`, even unimplemented) matches what other clients declare.
- **Source-line-aware `openFile` for markdown** — `startText` / `endText` are ignored when we route to the preview. Could resolve them to source line ranges and post-message the webview to scroll/highlight.

None of these are blockers. They become relevant only if someone reports the corresponding rough edge.
