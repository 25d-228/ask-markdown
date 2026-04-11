# Codex ChatGPT-Subscription Auth — Reference from opencode

Distilled notes on how [anomalyco/opencode](https://github.com/anomalyco/opencode) talks to OpenAI Codex using a **ChatGPT Plus/Pro subscription** instead of a billed API key — what endpoint it actually hits, how OAuth is wired, what headers are mandatory, and the small set of quirks you have to reproduce or the server will refuse you.

The relevant code lives in a single file: [`packages/opencode/src/plugin/codex.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/codex.ts). Everything else (the AI SDK, the provider loader, the system prompt) is generic — the plugin is what converts "I have a ChatGPT subscription" into "working requests against a gpt-5-codex model."

---

## Contents

1. [The trick, in one paragraph](#1-the-trick-in-one-paragraph)
2. [OAuth flow — PKCE + local callback](#2-oauth-flow--pkce--local-callback)
3. [OAuth flow — headless device code](#3-oauth-flow--headless-device-code)
4. [Credential storage](#4-credential-storage)
5. [Account ID extraction from JWT](#5-account-id-extraction-from-jwt)
6. [The fetch wrapper — where requests get rewritten](#6-the-fetch-wrapper--where-requests-get-rewritten)
7. [Request-time quirks that actually matter](#7-request-time-quirks-that-actually-matter)
8. [Model / cost plumbing](#8-model--cost-plumbing)
9. [Error codes unique to subscription mode](#9-error-codes-unique-to-subscription-mode)
10. [What this means for ask-markdown](#10-what-this-means-for-ask-markdown)
11. [Wire format reference](#11-wire-format-reference)

---

## 1. The trick, in one paragraph

OpenAI's public API lives at `https://api.openai.com/v1/responses` and requires a billed `sk-...` API key. The **ChatGPT product** lives at `https://chatgpt.com/backend-api/...` and is authenticated by the same OAuth session that `chat.openai.com` uses. Codex CLI is an official OpenAI client for that second world — it logs you in with the ChatGPT Pro account, gets an access token, and talks to `https://chatgpt.com/backend-api/codex/responses`. The endpoint accepts *almost* the same JSON body as the public Responses API — there are a few extra headers and a couple of forbidden fields, but structurally it's the same.

opencode reproduces Codex CLI's behavior entirely client-side. It:

1. Runs the **same OAuth PKCE flow** against `auth.openai.com` that the official Codex CLI uses, with the same `client_id` and the same `codex_cli_simplified_flow=true` authorize param.
2. Stores `{refresh, access, expires, accountId}` in a local JSON file.
3. Intercepts every call the AI SDK makes to OpenAI, **rewrites the URL** from `/v1/responses` to `chatgpt.com/backend-api/codex/responses`, swaps the dummy Authorization header for the real bearer token, and adds the Codex-specific headers.
4. Refreshes the access token when it's expired, silently, on the next request.

The AI SDK never knows it's not talking to the public API. The dummy API key (`"opencode-oauth-dummy-key"`) exists only so the SDK doesn't bail out at provider-creation time for missing credentials — it's stripped from the request before the real fetch happens.

```
┌──────────────────┐     Authorization: Bearer <OAuth access>      ┌────────────────────────────┐
│   opencode       │     ChatGPT-Account-Id: acc-xxx                │   chatgpt.com             │
│   AI SDK call    │ ──  originator: opencode                   ──► │   /backend-api/codex/     │
│   (expects       │     session_id: <session>                      │   responses               │
│    api.openai)   │     User-Agent: opencode/<ver> (...)           │                            │
└──────────────────┘                                                └────────────────────────────┘
        ▲                                                                     │
        │                                                                     │
        │        refresh_token grant @ auth.openai.com/oauth/token             │
        └─────────────────────────────────────────────────────────────────────┘
```

---

## 2. OAuth flow — PKCE + local callback

The constants in `plugin/codex.ts`:

```ts
const CLIENT_ID          = "app_EMoamEEZ73f0CkXaXp7hrann"
const ISSUER             = "https://auth.openai.com"
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
const OAUTH_PORT         = 1455
```

`app_EMoamEEZ73f0CkXaXp7hrann` is the same public client id the official Codex CLI uses. It's a **PKCE public client** — no secret — which is what makes the whole thing work without a registered developer application.

### 2.1 Authorize URL

```ts
https://auth.openai.com/oauth/authorize
  ?response_type=code
  &client_id=app_EMoamEEZ73f0CkXaXp7hrann
  &redirect_uri=http://localhost:1455/auth/callback
  &scope=openid%20profile%20email%20offline_access
  &code_challenge=<base64url(sha256(verifier))>
  &code_challenge_method=S256
  &id_token_add_organizations=true
  &codex_cli_simplified_flow=true
  &state=<random 32 bytes, base64url>
  &originator=opencode
```

Two params that are load-bearing and not obvious:

- **`codex_cli_simplified_flow=true`** — this tells `auth.openai.com` "I'm one of the Codex CLI-class clients, give me the reduced-friction consent screen and the right claims." Without it you can still complete the flow, but you may not get the `chatgpt_account_id` claim, and the redirect fails for some accounts.
- **`id_token_add_organizations=true`** — requests that the ID token include an `organizations[]` claim. Needed for the fallback account-ID extraction (see §5).

Scopes are boring OIDC: `openid profile email offline_access`. `offline_access` is what gives you a refresh token.

### 2.2 PKCE generation

```ts
// 43-character verifier, unreserved URL chars only
const verifier  = randomString(43, "A-Za-z0-9-._~")
const challenge = base64url(sha256(verifier))
```

Standard RFC 7636. Both `verifier` and `challenge` live in memory until the callback completes.

### 2.3 The local HTTP server

opencode spins up a plain Node `http.createServer` bound to `127.0.0.1:1455` for exactly the length of one authorization. The server has two routes:

| Route             | Purpose                                                 |
|-------------------|---------------------------------------------------------|
| `/auth/callback`  | OAuth redirect target. Exchanges `code` for tokens.     |
| `/cancel`         | User-initiated cancel; rejects the pending promise.     |

When `/auth/callback?code=...&state=...` fires, the server:

1. Compares `state` against the in-memory `pendingOAuth.state`. Mismatch → 400 + "potential CSRF."
2. POSTs to `auth.openai.com/oauth/token` with `grant_type=authorization_code`, the code, the PKCE verifier, and the same redirect URI.
3. Resolves a promise that the CLI is awaiting with the token response.
4. Renders a small HTML "Authorization Successful" page with an auto-close script.

If the user never clicks through, there's a **5-minute timeout** on the pending promise and the server rejects.

### 2.4 Token exchange request

```
POST https://auth.openai.com/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=<the code from the callback>
&redirect_uri=http://localhost:1455/auth/callback
&client_id=app_EMoamEEZ73f0CkXaXp7hrann
&code_verifier=<the 43-char verifier>
```

Response (relevant fields):

```json
{
  "id_token":      "eyJ...",
  "access_token":  "eyJ...",
  "refresh_token": "rt_...",
  "expires_in":    3600
}
```

`expires_in` is seconds. opencode converts to an absolute millisecond timestamp: `Date.now() + expires_in * 1000`.

---

## 3. OAuth flow — headless device code

For SSH / remote contexts where launching a browser on the client host isn't possible, opencode offers a **device auth** path — the same two-step flow the Codex CLI uses on headless boxes.

```
POST https://auth.openai.com/api/accounts/deviceauth/usercode
Content-Type: application/json
User-Agent: opencode/<version>

{ "client_id": "app_EMoamEEZ73f0CkXaXp7hrann" }
```

Response:

```json
{
  "device_auth_id": "da_...",
  "user_code":      "ABCD-1234",
  "interval":       "5"
}
```

opencode then:

1. Tells the user to open `https://auth.openai.com/codex/device` and enter `user_code`.
2. Polls `POST /api/accounts/deviceauth/token` with `{device_auth_id, user_code}` every `interval` seconds (+ 3 s safety margin).
3. While the user hasn't approved, the server returns 403/404 — treat as "keep polling."
4. On approval, the server returns `{authorization_code, code_verifier}` — note: the **server hands back the verifier** in this flow, which is why it's called "simplified."
5. Finally do a normal `authorization_code` token exchange using the server-provided verifier, with `redirect_uri=https://auth.openai.com/deviceauth/callback`.

Any other status → bail with `{type: "failed"}`.

The device flow is surprisingly clean because the "PKCE" is essentially degenerate (the verifier is chosen and revealed by the server after a successful second-factor), but the token exchange itself is identical to the interactive path.

---

## 4. Credential storage

```ts
const file = path.join(Global.Path.data, "auth.json")
// Global.Path.data = $XDG_DATA_HOME/opencode
// On Linux:   ~/.local/share/opencode/auth.json
// On macOS:   ~/Library/Application Support/opencode/auth.json (via xdg-basedir)
```

The file is a flat `{ providerID: AuthInfo }` map, written with mode **`0o600`** (owner read/write only). A typical entry for an OAuth provider looks like:

```json
{
  "openai": {
    "type":      "oauth",
    "refresh":   "rt_...",
    "access":    "eyJ...",
    "expires":   1734567890000,
    "accountId": "acc-abc123"
  }
}
```

The schema (`packages/opencode/src/auth/index.ts`) allows three kinds:

| `type`       | Fields                              | Used by                               |
|--------------|-------------------------------------|---------------------------------------|
| `oauth`      | `refresh`, `access`, `expires`, optional `accountId`, optional `enterpriseUrl` | ChatGPT subscription, GitHub Copilot, etc. |
| `api`        | `key`, optional `metadata`          | Old-school `sk-...` API keys          |
| `wellknown`  | `key`, `token`                      | Provider-registered "well-known" keys |

Same file, one JSON, hot-swapped per provider. The OAuth variant is what unlocks Codex-without-API-key.

---

## 5. Account ID extraction from JWT

Org-scoped ChatGPT plans (Team, Enterprise) require a **`ChatGPT-Account-Id` header** on every request. Getting the right value out of the token is the most fiddly part of the whole integration.

```ts
function parseJwtClaims(token: string) {
  const [, payload] = token.split(".")
  return JSON.parse(Buffer.from(payload, "base64url").toString())
}

function extractAccountIdFromClaims(claims) {
  return (
    claims.chatgpt_account_id                                  // personal plans
    ?? claims["https://api.openai.com/auth"]?.chatgpt_account_id  // org plans
    ?? claims.organizations?.[0]?.id                            // fallback
  )
}
```

Priority order matters. Try `id_token` first, then `access_token`, and take the first hit. If none of the three paths produce an ID, the header is just omitted — that's fine for personal Plus/Pro accounts.

The fact that the namespaced claim `https://api.openai.com/auth.chatgpt_account_id` even exists is the reason for `id_token_add_organizations=true` in the authorize params.

---

## 6. The fetch wrapper — where requests get rewritten

The plugin returns a `loader` that the opencode provider system calls once at load time. That loader returns two things:

```ts
return {
  apiKey: OAUTH_DUMMY_KEY,        // "opencode-oauth-dummy-key"
  fetch: async (url, init) => { ... }
}
```

`apiKey` is a placeholder so `createOpenAI({ apiKey })` from `@ai-sdk/openai` doesn't throw at construction time. `fetch` is the actual request interceptor. The AI SDK uses this custom fetch for every outbound call, so every Responses-API request routes through it.

Inside the wrapper (paraphrased):

```ts
// 1. Strip the dummy Authorization header the SDK is about to send
deleteHeader(init.headers, "authorization")
deleteHeader(init.headers, "Authorization")

// 2. Load current tokens from auth storage
let current = await getAuth()
if (current.type !== "oauth") return fetch(url, init)  // fall through for api keys

// 3. Refresh if expired
if (!current.access || current.expires < Date.now()) {
  const fresh = await refreshAccessToken(current.refresh)
  await input.client.auth.set({
    path: { id: "openai" },
    body: {
      type: "oauth",
      refresh: fresh.refresh_token,
      access:  fresh.access_token,
      expires: Date.now() + (fresh.expires_in ?? 3600) * 1000,
      accountId: extractAccountId(fresh) ?? current.accountId,
    },
  })
  current.access = fresh.access_token
}

// 4. Rebuild headers with the real token
const headers = new Headers(init.headers)
headers.set("authorization", `Bearer ${current.access}`)
if (current.accountId) headers.set("ChatGPT-Account-Id", current.accountId)

// 5. Rewrite the URL: /v1/responses or /chat/completions → Codex endpoint
const parsed = new URL(typeof url === "string" ? url : url.toString())
const target =
  parsed.pathname.includes("/v1/responses") || parsed.pathname.includes("/chat/completions")
    ? new URL(CODEX_API_ENDPOINT)
    : parsed

return fetch(target, { ...init, headers })
```

Points worth noting:

- **The URL swap is total** — query params and body are preserved but the host, port, pathname all come from `CODEX_API_ENDPOINT`. The AI SDK builds a pristine Responses request, and the plugin redirects it whole-cloth.
- **The refresh is lazy, not proactive** — no background timer. Requests check-and-refresh. This keeps the plugin stateless between invocations, at the cost of an occasional extra round-trip when a token expires.
- **Refresh writes back through `input.client.auth.set`**, which funnels through the opencode HTTP server and back into `auth.json`. A direct write would work; they go through the client for consistency with other auth providers.
- **On refresh, they re-run `extractAccountId`** in case the refreshed `id_token` / `access_token` has different org claims. Good practice for long-lived sessions where org membership changes.

---

## 7. Request-time quirks that actually matter

These are the things that make the difference between "server returns 200" and "server returns 400 with a cryptic error." Found in `plugin/codex.ts`, `session/llm.ts`, and `provider/transform.ts`.

### 7.1 Extra outbound headers (`chat.headers` hook)

```ts
"chat.headers": async (input, output) => {
  if (input.model.providerID !== "openai") return
  output.headers.originator  = "opencode"
  output.headers["User-Agent"] = `opencode/${version} (${os.platform()} ${os.release()}; ${os.arch()})`
  output.headers.session_id  = input.sessionID
}
```

- **`originator`** — identifies the client. Codex CLI sends `"codex_cli_rs"`. The server uses it for quota accounting and, empirically, for rate-limit differentiation.
- **`session_id`** — a stable session identifier. Required by the Codex endpoint; without it you get a 400. opencode reuses its own internal session ID, but any UUID-shaped string works.
- **`User-Agent`** — not strictly required but matches what Codex CLI sends. Keep it CLI-looking.

### 7.2 `maxOutputTokens` must be unset

```ts
"chat.params": async (input, output) => {
  if (input.model.providerID !== "openai") return
  output.maxOutputTokens = undefined   // "Match codex cli"
}
```

The Codex endpoint rejects `max_output_tokens` on the request body. Strip it or you'll get an invalid-prompt error. The model runs to its natural stop.

### 7.3 System prompt goes into `instructions`, not a `role: "system"` message

From `session/llm.ts`:

```ts
const isOpenaiOauth = provider.id === "openai" && auth?.type === "oauth"

if (isOpenaiOauth) {
  options.instructions = system.join("\n")
}

const messages = isOpenaiOauth
  ? input.messages                     // no system role prepended
  : [...system.map(s => ({ role: "system", content: s })), ...input.messages]
```

The Codex endpoint expects Codex CLI's convention: system/tools information goes in the top-level `instructions` field of the Responses request body, and the `input` array contains only user/assistant/tool messages. Mixing a `role: "system"` message in alongside `instructions` either silently ignores the system message or errors out, depending on the model.

For reference, the Codex-specific system prompt lives in `session/prompt/codex.txt` — ~80 lines of agent instructions tuned for `gpt-5.*-codex` models.

### 7.4 `store: false` is mandatory (or at least safest)

```ts
// provider/transform.ts
if (providerID === "openai" || model.api.npm === "@ai-sdk/openai") {
  result["store"] = false
}
```

`store: true` on the Responses API means "persist the response on OpenAI's servers for later retrieval." For subscription traffic this is at best useless and at worst has privacy implications — opencode forces it off.

### 7.5 Authorization header strip

The AI SDK's fetch inserts `Authorization: Bearer opencode-oauth-dummy-key` before calling the plugin's custom fetch. The wrapper has to **explicitly delete it** (both `authorization` and `Authorization` — `Headers` is case-insensitive but plain objects aren't) before setting the real one. A leftover dummy header would be used as a second `Authorization`, and most servers reject multi-valued `Authorization`.

---

## 8. Model / cost plumbing

The plugin filters the list of models visible on the `openai` provider when OAuth is active:

```ts
const allowedModels = new Set([
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-5.4-mini",
])
for (const [id, model] of Object.entries(provider.models)) {
  if (id.includes("codex")) continue
  if (allowedModels.has(model.api.id)) continue
  delete provider.models[id]
}
```

Only Codex-eligible models survive. This is the server-side reality: a ChatGPT Pro subscription gets you `gpt-5.*-codex` through the Codex endpoint, nothing else. Exposing, say, `gpt-4o` would just produce confusing 403s.

After filtering, it zeroes out pricing:

```ts
for (const model of Object.values(provider.models)) {
  model.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }
}
```

Inference is "free" in the sense that it's covered by the flat-rate ChatGPT subscription — there's no per-token billing, so the UI should not pretend there is one. Cost is zeroed, not deleted, so the downstream accounting code that reads `model.cost` still works.

---

## 9. Error codes unique to subscription mode

From `provider/error.ts`. The Codex endpoint returns OpenAI-style `{error: {code, message}}` bodies, with at least one code you won't see on the public API:

| `code`                   | Meaning                                                                 |
|--------------------------|-------------------------------------------------------------------------|
| `context_length_exceeded` | Normal: prompt is too long for the chosen model.                       |
| `insufficient_quota`      | Subscription quota exhausted — not a top-up problem, a wait problem.   |
| `usage_not_included`      | **Codex-specific.** User is on Free, not Plus/Pro. opencode surfaces this as "To use Codex with your ChatGPT plan, upgrade to Plus." |
| `invalid_prompt`          | Request body is structurally wrong (e.g., `max_output_tokens` present, or a `role: "system"` message snuck in alongside `instructions`). |

`usage_not_included` is the one to watch for if you're rolling your own integration — it's the signal that the OAuth flow succeeded but the account doesn't have Codex entitlement.

---

## 10. What this means for ask-markdown

ask-markdown today is a **tool server** for `claude` (the CLI) — it speaks JSON-RPC / MCP over a WebSocket and waits for Claude to call `tools/call`. That's a completely different shape from what opencode does, and the two integrations shouldn't be forced into one abstraction.

If we ever want to support Codex in ask-markdown, the realistic architectures are:

### Option A: Treat Codex like Claude and wait for an MCP client

Be a tool server, let a Codex-aware CLI connect to us over MCP. **This doesn't work today** because the `codex` CLI (OpenAI's official one) doesn't speak MCP the same way Claude Code does — and more importantly, it ships prompts text-only to a terminal. That's the same wall [johnseth97/codex.nvim](https://github.com/johnseth97/codex.nvim) ran into: the integration is "send keystrokes to a subprocess," not a protocol.

### Option B: Become the client

Build a minimal Codex client inside ask-markdown, following the opencode recipe:

1. **OAuth PKCE flow** against `auth.openai.com` (~150 lines of code, covered in §2).
2. **Local credential store** at `~/Library/Application Support/ask-markdown/auth.json` mode 0o600 (or anywhere else, just keep it out of the workspace and out of git).
3. **Custom fetch or raw `node-fetch`** pointing at `https://chatgpt.com/backend-api/codex/responses`, with the exact headers from §7.1.
4. **Manually-built Responses-API body**: `{model, input: [messages], instructions, store: false}`. Don't pull in `@ai-sdk/openai` just for this — the body shape is small and the SDK adds weight.
5. **Streaming** via SSE (`text/event-stream`) — the Codex endpoint supports streaming the same way the public Responses API does.
6. **UI:** some place for the user to paste their selected markdown + their question, and a panel to render the streaming response. The existing webview infrastructure (`src/previewProvider.ts`) is a head start on the rendering side.

This is meaningful new surface area (OAuth callback server, token refresh, SSE parsing, a real chat UI) and it makes ask-markdown a bigger thing than it is today.

### Option C: Defer and let the user bring their own

Keep ask-markdown focused on Claude-via-MCP and just make it easy for users to launch `codex` or `opencode` in an adjacent terminal against the current selection. Zero auth complexity on our side. Least surface area, most honest about what this extension is.

**My read:** Option B is technically clean and the opencode code is a good enough reference that writing the client isn't scary (the whole plugin is ~600 lines). But it's a different product than "a markdown preview that integrates with Claude Code." If we do it, it should be a conscious pivot, not a silent feature bolt-on.

### If we do go Option B, the punch list

- `src/openaiAuth.ts` — PKCE generation, authorize URL builder, local 1455 callback server, `/oauth/token` exchange (~150 lines).
- `src/openaiAuthStorage.ts` — read/write `auth.json` with mode 0o600, expiry tracking, refresh-on-expired.
- `src/codexClient.ts` — fetch wrapper: header injection (`authorization`, `ChatGPT-Account-Id`, `originator`, `session_id`, `User-Agent`), POST to `CODEX_API_ENDPOINT`, SSE parser for streaming responses.
- `src/codexChat.ts` — higher-level "ask Codex about this markdown selection" function that wraps body construction + calls `codexClient`. System prompt goes in `instructions`. `store: false`. `maxOutputTokens` absent.
- A new webview or VS Code chat participant for rendering the answer. Probably the biggest unknown.
- A `ask-markdown.codexLogin` command for triggering the OAuth flow (opens browser to the authorize URL, waits for callback).

None of it touches the existing Claude MCP server in `src/claudeServer.ts`. The two integrations would live side by side.

---

## 11. Wire format reference

### 11.1 Authorize URL (interactive)

```
https://auth.openai.com/oauth/authorize
  ?response_type=code
  &client_id=app_EMoamEEZ73f0CkXaXp7hrann
  &redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback
  &scope=openid+profile+email+offline_access
  &code_challenge=<BASE64URL(SHA-256(verifier))>
  &code_challenge_method=S256
  &id_token_add_organizations=true
  &codex_cli_simplified_flow=true
  &state=<random 32 bytes, base64url>
  &originator=opencode
```

### 11.2 Token exchange (interactive)

```http
POST /oauth/token HTTP/1.1
Host: auth.openai.com
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=<callback code>
&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback
&client_id=app_EMoamEEZ73f0CkXaXp7hrann
&code_verifier=<verifier>
```

```json
{
  "id_token":      "eyJhbGciOi...",
  "access_token":  "eyJhbGciOi...",
  "refresh_token": "rt_...",
  "expires_in":    3600
}
```

### 11.3 Token refresh

```http
POST /oauth/token HTTP/1.1
Host: auth.openai.com
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&refresh_token=rt_...
&client_id=app_EMoamEEZ73f0CkXaXp7hrann
```

Response shape identical to the exchange response. Note that **`refresh_token` rotates** — the response's `refresh_token` is (usually) a new one and you should persist it.

### 11.4 Device auth: start

```http
POST /api/accounts/deviceauth/usercode HTTP/1.1
Host: auth.openai.com
Content-Type: application/json
User-Agent: opencode/<version>

{"client_id": "app_EMoamEEZ73f0CkXaXp7hrann"}
```

```json
{
  "device_auth_id": "da_...",
  "user_code":      "ABCD-1234",
  "interval":       "5"
}
```

### 11.5 Device auth: poll

```http
POST /api/accounts/deviceauth/token HTTP/1.1
Host: auth.openai.com
Content-Type: application/json
User-Agent: opencode/<version>

{"device_auth_id": "da_...", "user_code": "ABCD-1234"}
```

- **403 / 404** → pending, sleep `interval + 3s`, retry.
- **200** → `{authorization_code, code_verifier}`, continue to the standard token exchange with `redirect_uri=https://auth.openai.com/deviceauth/callback`.
- **Anything else** → fail.

### 11.6 Codex Responses call

```http
POST /backend-api/codex/responses HTTP/1.1
Host: chatgpt.com
Authorization: Bearer <access token>
ChatGPT-Account-Id: <account id from JWT, if present>
originator: opencode
session_id: <stable uuid/session id>
User-Agent: opencode/0.x.x (darwin 24.0.0; arm64)
Content-Type: application/json
Accept: text/event-stream

{
  "model": "gpt-5.1-codex",
  "input": [
    { "role": "user", "content": [{ "type": "input_text", "text": "…" }] }
  ],
  "instructions": "<system prompt goes here, NOT in input[]>",
  "store": false,
  "stream": true,
  "reasoning": { "effort": "medium", "summary": "auto" },
  "include": ["reasoning.encrypted_content"]
}
```

- **No `max_output_tokens`** — omit it entirely.
- **No `role: "system"` entries in `input[]`** — use `instructions`.
- **`store: false`** — not optional in practice.
- **`stream: true`** — SSE back; events are `response.*` deltas mirroring the public Responses API.

### 11.7 Error shape

```json
{
  "error": {
    "code":    "usage_not_included",
    "message": "Your ChatGPT plan does not include Codex usage."
  }
}
```

Ordinary HTTP status codes ride along (400/401/403/429/500). `401` specifically means the access token has been invalidated server-side — refresh before retrying.

---

## Appendix: file map for future you

| Concept                     | File in opencode                                             |
|-----------------------------|--------------------------------------------------------------|
| OAuth + fetch wrapper       | `packages/opencode/src/plugin/codex.ts`                       |
| Credential storage schema   | `packages/opencode/src/auth/index.ts`                         |
| OAuth ↔ system prompt swap  | `packages/opencode/src/session/llm.ts` (`isOpenaiOauth`)      |
| `store: false` default      | `packages/opencode/src/provider/transform.ts`                 |
| Codex system prompt text    | `packages/opencode/src/session/prompt/codex.txt`              |
| Error code translations     | `packages/opencode/src/provider/error.ts`                     |
| Plugin registration         | `packages/opencode/src/plugin/index.ts` (`INTERNAL_PLUGINS`)  |

The whole integration is ~700 lines of code once you exclude the generic AI-SDK / provider glue. Reproducing it in ask-markdown would be roughly the same order of magnitude — the expensive part isn't the wire protocol, it's the UI surface to actually talk to Codex.
