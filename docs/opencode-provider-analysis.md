# opencode Provider Analysis — Codex vs Claude Code

Distilled notes on how [anomalyco/opencode](https://github.com/anomalyco/opencode) integrates with its two primary AI providers: **OpenAI Codex** (ChatGPT subscription auth) and **Anthropic Claude** (standard API key), plus the community [opencode-claude-auth](https://github.com/griffinmartin/opencode-claude-auth) plugin that bridges Claude Code's subscription credentials into opencode.

The Codex integration lives in [`packages/opencode/src/plugin/codex.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/codex.ts). The Claude integration is spread across the generic provider system — there is no Claude-specific plugin at all, which is the point. The opencode-claude-auth plugin adds ~1200 lines of protocol compliance to use Claude Code's OAuth tokens instead of an API key — the Claude equivalent of the Codex plugin.

---

## Contents

**Part I — Codex (ChatGPT subscription)**

1. [The trick, in one paragraph](#1-the-trick-in-one-paragraph)
2. [OAuth flow — PKCE + local callback](#2-oauth-flow--pkce--local-callback)
3. [OAuth flow — headless device code](#3-oauth-flow--headless-device-code)
4. [Credential storage](#4-credential-storage)
5. [Account ID extraction from JWT](#5-account-id-extraction-from-jwt)
6. [The fetch wrapper — where requests get rewritten](#6-the-fetch-wrapper--where-requests-get-rewritten)
7. [Request-time quirks that actually matter](#7-request-time-quirks-that-actually-matter)
8. [Model / cost plumbing](#8-model--cost-plumbing)
9. [Error codes unique to subscription mode](#9-error-codes-unique-to-subscription-mode)

**Part II — Claude Code (Anthropic API)**

10. [How opencode handles Claude — the anti-Codex](#10-how-opencode-handles-claude--the-anti-codex)
11. [Auth: one env var, no plugin](#11-auth-one-env-var-no-plugin)
12. [Provider loader: a header and nothing else](#12-provider-loader-a-header-and-nothing-else)
13. [System prompt: role messages, not instructions](#13-system-prompt-role-messages-not-instructions)
14. [Message normalization and caching](#14-message-normalization-and-caching)
15. [Reasoning / extended thinking](#15-reasoning--extended-thinking)
16. [Model parameters and transform quirks](#16-model-parameters-and-transform-quirks)
17. [Error handling: standard overflow detection](#17-error-handling-standard-overflow-detection)

**Part III — Comparison and implications**

18. [Side-by-side: Codex vs Claude in opencode](#18-side-by-side-codex-vs-claude-in-opencode)
19. [What this means for ask-markdown](#19-what-this-means-for-ask-markdown)
20. [Wire format reference (Codex)](#20-wire-format-reference-codex)

**Part IV — opencode-claude-auth (community plugin)**

21. [Plugin architecture — same pattern as Codex](#21-plugin-architecture--same-pattern-as-codex)
22. [Credential sourcing — Keychain and fallback](#22-credential-sourcing--keychain-and-fallback)
23. [Request interception — the fetch wrapper](#23-request-interception--the-fetch-wrapper)
24. [Billing header signing — the non-obvious part](#24-billing-header-signing--the-non-obvious-part)
25. [System prompt validation — identity splitting and relocation](#25-system-prompt-validation--identity-splitting-and-relocation)
26. [Tool name translation — the `mcp_` prefix](#26-tool-name-translation--the-mcp_-prefix)
27. [Token refresh — two strategies](#27-token-refresh--two-strategies)
28. [Effort and model-specific transforms](#28-effort-and-model-specific-transforms)
29. [Side-by-side: Codex plugin vs Claude Auth plugin](#29-side-by-side-codex-plugin-vs-claude-auth-plugin)
30. [What this means for ask-markdown (updated)](#30-what-this-means-for-ask-markdown-updated)

---

# Part I — Codex (ChatGPT subscription)

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

---

# Part II — Claude Code (Anthropic API)

## 10. How opencode handles Claude — the anti-Codex

The Codex integration is a 600-line plugin with its own OAuth server, fetch interceptor, URL rewriting, and half a dozen header injections. The Claude integration is... nothing. There is no `claudePlugin.ts`. There is no auth plugin. Anthropic is treated as the most generic provider in the system.

This isn't neglect — it's a reflection of API design. Anthropic's Messages API is a standard HTTPS endpoint authenticated by a static API key passed in the `x-api-key` header. There's no subscription-mode backdoor endpoint to discover, no OAuth dance to replicate, no undocumented headers that make the difference between 200 and 400. The SDK (`@ai-sdk/anthropic`) handles all of it. opencode's job is to supply the key and get out of the way.

The entire Anthropic-specific code in opencode lives in:

- **4 lines in the custom provider loader** (`provider.ts:175-182`) — setting an `anthropic-beta` header.
- **~40 lines in `transform.ts`** — message normalization (empty content filtering, tool call ID scrubbing, prompt caching).
- **1 prompt file** (`prompt/anthropic.txt`) — the system prompt for Claude models.
- **~30 lines in `transform.ts`** — reasoning/thinking variant configuration.

That's it. No plugin. No auth interceptor. No fetch wrapper.

---

## 11. Auth: one env var, no plugin

Claude authentication in opencode takes exactly one of two paths:

**Path 1: Environment variable.** Set `ANTHROPIC_API_KEY` in the shell environment. opencode's provider discovery scans `Env.all()` for each provider's registered env vars, finds the key, and marks the `anthropic` provider as `source: "env"`. Done.

**Path 2: Stored API key.** Run `opencode auth anthropic` and paste the key. opencode stores it in `auth.json` as:

```json
{
  "anthropic": {
    "type": "api",
    "key": "sk-ant-..."
  }
}
```

Same `auth.json` file as Codex, same mode `0o600`, but the `api` type instead of `oauth`. No refresh logic, no expiry tracking, no JWT parsing, no account ID extraction. The key is static and doesn't rotate.

Compare to Codex, which needs the `oauth` type with five fields, a token refresh cycle, account ID extraction from JWT claims, and a 250-line callback server.

The `INTERNAL_PLUGINS` array in `plugin/index.ts` lists six built-in plugins:

```ts
const INTERNAL_PLUGINS = [
  CodexAuthPlugin,        // OpenAI Codex OAuth
  CopilotAuthPlugin,      // GitHub Copilot OAuth
  GitlabAuthPlugin,       // GitLab OAuth
  PoeAuthPlugin,          // Poe OAuth
  CloudflareWorkersAuthPlugin,
  CloudflareAIGatewayAuthPlugin,
]
```

Anthropic is not on this list. It doesn't need a plugin because there's nothing to intercept.

---

## 12. Provider loader: a header and nothing else

Each provider can register a custom loader in `provider.ts` that runs at initialization time. The Anthropic loader is minimal:

```ts
anthropic: () =>
  Effect.succeed({
    autoload: false,
    options: {
      headers: {
        "anthropic-beta": "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14",
      },
    },
  }),
```

Two things to note:

1. **`autoload: false`** — the provider isn't automatically loaded. It only activates when an API key is present via env var or `auth.json`. Compare to Amazon Bedrock which sets `autoload: true` when credentials are found.

2. **`anthropic-beta` header** — this opts into two beta features:
   - `interleaved-thinking-2025-05-14` — allows the model to interleave thinking/reasoning tokens with output tokens.
   - `fine-grained-tool-streaming-2025-05-14` — enables streaming of tool call results at a finer granularity.

That's the entirety of the custom Anthropic provider configuration. Compare to the OpenAI custom loader:

```ts
openai: () =>
  Effect.succeed({
    autoload: false,
    async getModel(sdk, modelID) {
      return sdk.responses(modelID)  // force Responses API, not Chat Completions
    },
    options: {},
  }),
```

OpenAI needs a custom `getModel` to select the Responses API path. Anthropic doesn't even need that — the SDK's default `languageModel()` path is correct.

---

## 13. System prompt: role messages, not instructions

This is the sharpest architectural difference between the two providers.

For **Codex** (OpenAI OAuth mode), the system prompt goes into a top-level `instructions` field and system messages are *excluded* from the input array:

```ts
// session/llm.ts
const isOpenaiOauth = provider.id === "openai" && auth?.type === "oauth"

if (isOpenaiOauth) {
  options.instructions = system.join("\n")
}

const messages = isOpenaiOauth
  ? input.messages                     // NO system messages
  : [...system.map(s => ({ role: "system", content: s })), ...input.messages]
```

For **Claude** (and every other non-Codex-OAuth provider), the system prompt goes as standard `role: "system"` messages prepended to the conversation. The Anthropic SDK (`@ai-sdk/anthropic`) handles converting these into the `system` field in the Claude API's native format. opencode doesn't need to know about this translation — the SDK does it automatically.

The Codex endpoint actively rejects `role: "system"` messages when `instructions` is also present. The Claude API accepts system messages natively. This is why Codex needs the `isOpenaiOauth` branch — it's working around a server-side restriction that Claude doesn't have.

### The prompt texts themselves

opencode uses different system prompts per model family, selected in `system.ts`:

```ts
function provider(model: Provider.Model) {
  if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
    return [PROMPT_BEAST]
  if (model.api.id.includes("gpt")) {
    if (model.api.id.includes("codex")) return [PROMPT_CODEX]
    return [PROMPT_GPT]
  }
  if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
  if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
  ...
  return [PROMPT_DEFAULT]
}
```

The **Codex prompt** (`codex.txt`, ~80 lines) is tuned for terminal-based code editing — it emphasizes `apply_patch` for edits, detailed formatting rules for response channels (`commentary` vs `final`), and frontend design aesthetics.

The **Anthropic prompt** (`anthropic.txt`, ~106 lines) is structurally similar but adapted for Claude's strengths — it emphasizes the `TodoWrite` tool for task management, the `Task` tool for delegating codebase exploration to subagents, and professional objectivity ("prioritize technical accuracy and truthfulness over validating the user's beliefs"). It doesn't mention `apply_patch` (Claude uses different edit tools) and its formatting instructions are simpler.

Both prompts share the same core identity: "You are OpenCode, the best coding agent on the planet."

---

## 14. Message normalization and caching

`provider/transform.ts` has Claude-specific logic in two places.

### 14.1 Empty content filtering

```ts
if (model.api.npm === "@ai-sdk/anthropic" || model.api.npm === "@ai-sdk/amazon-bedrock") {
  msgs = msgs
    .map((msg) => {
      if (typeof msg.content === "string") {
        if (msg.content === "") return undefined
        return msg
      }
      if (!Array.isArray(msg.content)) return msg
      const filtered = msg.content.filter((part) => {
        if (part.type === "text" || part.type === "reasoning") {
          return part.text !== ""
        }
        return true
      })
      if (filtered.length === 0) return undefined
      return { ...msg, content: filtered }
    })
    .filter((msg) => msg !== undefined && msg.content !== "")
}
```

Anthropic's API rejects messages with empty string content. OpenAI's doesn't. This filter runs only for Anthropic and Bedrock (which uses Anthropic models behind the scenes).

### 14.2 Tool call ID scrubbing

```ts
if (model.api.id.includes("claude")) {
  const scrub = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_")
  // ... applied to tool-call and tool-result parts
}
```

Claude's API restricts tool call IDs to `[a-zA-Z0-9_-]`. Other providers are more permissive. opencode scrubs invalid characters only for Claude models.

### 14.3 Prompt caching

opencode applies Anthropic's prompt caching to the first two system messages and the last two conversation messages:

```ts
const providerOptions = {
  anthropic: {
    cacheControl: { type: "ephemeral" },
  },
  // ... also bedrock, openrouter, copilot
}
```

This is applied only when the model is identified as Anthropic-family:

```ts
if (
  model.providerID === "anthropic" ||
  model.providerID === "google-vertex-anthropic" ||
  model.api.id.includes("anthropic") ||
  model.api.id.includes("claude") ||
  ...
) {
  msgs = applyCaching(msgs, model)
}
```

The caching logic is provider-aware but not invasive — it annotates existing messages with `providerOptions` metadata rather than restructuring the message array.

---

## 15. Reasoning / extended thinking

opencode configures Claude's extended thinking through the `variants` system in `transform.ts`. The configuration differs based on whether the model supports **adaptive thinking** (Claude 4.6 Opus/Sonnet) or the older **budget-based thinking** (Claude 3.5, etc.).

### Adaptive thinking (Claude 4.6)

```ts
const isAnthropicAdaptive = ["opus-4-6", "opus-4.6", "sonnet-4-6", "sonnet-4.6"].some((v) =>
  model.api.id.includes(v),
)
const adaptiveEfforts = ["low", "medium", "high", "max"]

if (isAnthropicAdaptive) {
  return Object.fromEntries(
    adaptiveEfforts.map((effort) => [
      effort,
      {
        thinking: { type: "adaptive" },
        effort,
      },
    ]),
  )
}
```

Adaptive thinking lets the model decide how much to think based on problem difficulty, with the `effort` level as a hint.

### Budget-based thinking (older Claude models)

```ts
return {
  high: {
    thinking: {
      type: "enabled",
      budgetTokens: Math.min(16_000, Math.floor(model.limit.output / 2 - 1)),
    },
  },
  max: {
    thinking: {
      type: "enabled",
      budgetTokens: Math.min(31_999, model.limit.output - 1),
    },
  },
}
```

Only two variants (`high` and `max`), with explicit token budgets clamped to model output limits.

Compare to **Codex reasoning variants**:

```ts
// OpenAI Codex models
const openaiEfforts = iife(() => {
  if (id.includes("codex")) {
    if (id.includes("5.2") || id.includes("5.3")) return [...WIDELY_SUPPORTED_EFFORTS, "xhigh"]
    return WIDELY_SUPPORTED_EFFORTS  // ["low", "medium", "high"]
  }
  ...
})
return Object.fromEntries(
  openaiEfforts.map((effort) => [
    effort,
    {
      reasoningEffort: effort,
      reasoningSummary: "auto",
      include: ["reasoning.encrypted_content"],
    },
  ]),
)
```

Different shape entirely: `reasoningEffort` vs `thinking.type`, `reasoningSummary` vs nothing, `include: ["reasoning.encrypted_content"]` (encrypted reasoning is an OpenAI-specific feature). The reasoning APIs have zero overlap.

---

## 16. Model parameters and transform quirks

### Temperature

```ts
export function temperature(model: Provider.Model) {
  if (id.includes("claude")) return undefined
  ...
}
```

opencode sends no temperature for Claude models — it lets the API use its default. For comparison, Gemini gets `1.0`, Qwen gets `0.55`, and GPT models also get `undefined`.

### Top-P and Top-K

Both are `undefined` for Claude. Some providers (Qwen, MiniMax, Gemini) get explicit values.

### `store: false`

Applied to OpenAI and GitHub Copilot models, *not* to Anthropic:

```ts
if (model.providerID === "openai" || model.api.npm === "@ai-sdk/openai" || model.api.npm === "@ai-sdk/github-copilot") {
  result["store"] = false
}
```

Anthropic's API doesn't have a `store` parameter — conversations aren't persisted server-side by default.

### `maxOutputTokens`

For Codex (OAuth mode), `maxOutputTokens` is stripped entirely (`undefined`). For Claude, it's set to `Math.min(model.limit.output, 32_000)` via the standard `OUTPUT_TOKEN_MAX` path.

---

## 17. Error handling: standard overflow detection

opencode's error handling in `provider/error.ts` has no Claude-specific error codes. Anthropic errors are caught by the generic overflow detection patterns:

```ts
const OVERFLOW_PATTERNS = [
  /prompt is too long/i,              // Anthropic's overflow message
  /context_length_exceeded/i,          // Generic fallback
  ...
]
```

Compare to Codex, which has three endpoint-specific error codes (`insufficient_quota`, `usage_not_included`, `invalid_prompt`) with dedicated handling in `parseStreamError()`.

The `isRetryable` logic for OpenAI includes a special case for 404s (OpenAI sometimes returns 404 for available models). Anthropic uses the SDK's default `isRetryable` without any override.

---

# Part III — Comparison and implications

## 18. Side-by-side: Codex vs Claude in opencode

| Dimension | Codex (ChatGPT subscription) | Claude (Anthropic API) |
|---|---|---|
| **Auth mechanism** | OAuth PKCE flow against `auth.openai.com`, refresh token rotation, JWT account ID extraction | `ANTHROPIC_API_KEY` env var or stored `api` key |
| **Plugin required** | Yes — `codex.ts`, 608 lines, registered in `INTERNAL_PLUGINS` | No — zero plugin code |
| **Fetch wrapper** | Yes — intercepts every request, rewrites URL from `api.openai.com` to `chatgpt.com`, swaps auth headers | No — uses `@ai-sdk/anthropic` SDK directly |
| **Custom headers** | `originator`, `session_id`, `User-Agent`, `ChatGPT-Account-Id` | `anthropic-beta` (via provider loader, 4 lines) |
| **System prompt delivery** | Top-level `instructions` field, system messages excluded from `input[]` | Standard `role: "system"` messages prepended to conversation |
| **`maxOutputTokens`** | Stripped entirely (endpoint rejects it) | Set to `min(model.limit.output, 32000)` |
| **`store` parameter** | `false` (mandatory) | Not applicable (no such parameter in Claude API) |
| **Model filtering** | Plugin filters to Codex-eligible models only when OAuth active | None — all models from `models.dev` are available |
| **Cost model** | Zeroed out (flat-rate subscription) | Per-token billing, costs from `models.dev` |
| **Token refresh** | Lazy refresh on every request, writes back through `auth.set()` | None — static API key |
| **Reasoning config** | `reasoningEffort` + `reasoningSummary` + `include: ["reasoning.encrypted_content"]` | `thinking: { type: "adaptive" }` or `{ type: "enabled", budgetTokens }` |
| **Message normalization** | None (OpenAI is permissive) | Empty content filtering, tool call ID scrubbing to `[a-zA-Z0-9_-]` |
| **Prompt caching** | `promptCacheKey: sessionID` (OpenAI-style) | `cacheControl: { type: "ephemeral" }` on system + last 2 messages |
| **Error codes** | `usage_not_included`, `insufficient_quota`, `invalid_prompt` (endpoint-specific) | Standard overflow pattern matching |
| **Endpoint** | `chatgpt.com/backend-api/codex/responses` (subscription) or `api.openai.com/v1/responses` (API key) | `api.anthropic.com/v1/messages` (via SDK) |

### The asymmetry, explained

The difference is not about which provider opencode prefers — it treats both as first-class. The difference is about **API design philosophy**:

- **Anthropic** ships one API, one endpoint, one auth mechanism. The SDK handles the protocol. Clients supply a key and call the API. There is no "subscription mode" with a shadow endpoint, no undocumented headers that the server silently requires, no fields that must be absent or the request fails.

- **OpenAI Codex** has two authentication worlds: the public API (`sk-...` keys, billed per token) and the ChatGPT subscription API (OAuth, flat-rate, different endpoint). The second world is essentially an internal API that first-party clients (Codex CLI) use, and third-party clients (opencode) reverse-engineer. This is what creates the 600-line plugin — it's not complexity for its own sake, it's the cost of bridging between the SDK's assumptions and the subscription endpoint's requirements.

### What opencode's architecture tells us about MCP

opencode consumes MCP servers as a **client** — it connects to external MCP servers (configured in `opencode.json`) and exposes their tools to whichever LLM is active. The MCP layer is provider-agnostic:

```ts
// mcp/index.ts — standard MCP client connecting over stdio, SSE, or streamable HTTP
const client = new Client(...)
const transport = new StdioClientTransport(...)  // or SSE, or StreamableHTTP
```

This means opencode can use ask-markdown's MCP tools regardless of which provider is active — Claude, Codex, Gemini, whatever. The MCP connection is between opencode and the tool server; the LLM never talks to MCP directly.

This is the same pattern Claude Code uses (Claude Code connects to our MCP server, our tools are provider-agnostic), but opencode generalizes it to any provider. The MCP server doesn't need to know or care which LLM is on the other side.

---

## 19. What this means for ask-markdown

ask-markdown today is a **tool server** for Claude Code — it speaks JSON-RPC / MCP over a WebSocket and waits for Claude to call `tools/call`. opencode's architecture shows us three things about how other clients approach the same problem space.

### Lesson 1: MCP is the right abstraction for tool servers

opencode confirms that the MCP-as-tool-server pattern works across providers. opencode's MCP client connects to external tool servers and exposes their tools to whatever LLM is active. Our MCP server doesn't need to change to support opencode as a client — it would just connect to us the same way Claude Code does. The tool definitions and responses are provider-agnostic.

### Lesson 2: Becoming a direct LLM client is expensive for Codex, trivial for Claude

If we ever want ask-markdown to call an LLM directly (instead of being called by one), the opencode comparison is instructive:

- **Adding a direct Claude client** would be simple: `npm install @ai-sdk/anthropic`, supply an API key, call the Messages API. Maybe 50 lines of code. The entire Anthropic integration in opencode is essentially this — no plugin, no fetch wrapper, no auth dance.

- **Adding a direct Codex client** would require the full opencode recipe: OAuth PKCE flow (~150 lines), credential storage (~50 lines), fetch wrapper with URL rewriting and header injection (~200 lines), plus SSE parsing for streaming. And it would need to track OpenAI's undocumented quirks (no `max_output_tokens`, system prompt via `instructions`, etc.) as they evolve.

### Lesson 3: opencode is already a potential consumer of our MCP server

opencode supports MCP servers in its config (`opencode.json`). Users could point opencode at ask-markdown's MCP endpoint today, and opencode would expose our markdown tools to whichever model the user has configured — Claude, Codex, Gemini, whatever. We don't need to do anything on our side for this to work.

### Updated architecture options

**Option A: Stay as a Claude Code MCP tool server (current state).** Zero changes needed. opencode users could connect to us today if they configure MCP.

**Option B: Add a lightweight direct Anthropic client.** Following opencode's lead, this would be trivially simple — no plugin architecture needed. Would let ask-markdown talk to Claude without Claude Code as an intermediary. Small surface area (~50-100 lines).

**Option C: Add a Codex client.** Following opencode's `codex.ts` as a reference. 400-600 lines of auth + fetch plumbing, plus UI surface for the chat interaction. A conscious product expansion.

**Option D: Defer direct LLM integration entirely.** Keep ask-markdown as a tool server. Document how to connect opencode (which supports Codex, Claude, and 20+ other providers) to our MCP endpoint. Let the user choose their client.

**My updated read:** The opencode comparison makes Option D more attractive than before. opencode already solves the "use any LLM with tools" problem, and it consumes MCP servers natively. Instead of building our own LLM client, we could focus on making our MCP tools excellent and let opencode/Claude Code/any-future-MCP-client be the orchestration layer. If we do build a direct client, Claude (Option B) is the sane first choice — the integration cost is an order of magnitude lower than Codex.

---

## 20. Wire format reference (Codex)

### 20.1 Authorize URL (interactive)

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

### 20.2 Token exchange (interactive)

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

### 20.3 Token refresh

```http
POST /oauth/token HTTP/1.1
Host: auth.openai.com
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&refresh_token=rt_...
&client_id=app_EMoamEEZ73f0CkXaXp7hrann
```

Response shape identical to the exchange response. Note that **`refresh_token` rotates** — the response's `refresh_token` is (usually) a new one and you should persist it.

### 20.4 Device auth: start

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

### 20.5 Device auth: poll

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

### 20.6 Codex Responses call

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

### 20.7 Error shape

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

# Part IV — opencode-claude-auth (community plugin)

The [griffinmartin/opencode-claude-auth](https://github.com/griffinmartin/opencode-claude-auth) plugin is the **Claude equivalent of opencode's built-in Codex plugin**. It solves the same problem — using a *subscription* instead of a billed API key — but for Anthropic's Claude instead of OpenAI's Codex. Where opencode's native Claude integration is trivially simple (Part II: env var, 4 lines of config), this plugin adds the full auth interception layer that makes it architecturally parallel to the 608-line Codex plugin.

The core trick: read Claude Code's existing OAuth credentials (from macOS Keychain or `~/.claude/.credentials.json`), impersonate Claude Code when talking to Anthropic's API, and handle all the undocumented validation that Anthropic's server performs on OAuth-authenticated requests.

---

## 21. Plugin architecture — same pattern as Codex

The plugin registers via `auth.provider: "anthropic"` and returns a custom `auth.loader` — the identical hook mechanism that the Codex plugin uses:

```ts
// index.ts — same pattern as codex.ts
app.register("auth.loader", "anthropic", async (input) => {
  const creds = await getOrRefreshCredentials(account)
  return {
    apiKey: creds.accessToken,  // OAuth token as "API key"
    fetch: customFetchFn,       // intercepts every request
  }
})
```

The `auth.loader` contract is the same for both plugins: return `{ apiKey, fetch }` and the SDK never knows it's talking through a subscription. This is the plugin system's core abstraction — provider-agnostic auth interception.

---

## 22. Credential sourcing — Keychain and fallback

The plugin reads credentials that Claude Code has *already stored*, rather than running its own OAuth flow. This is a key architectural difference from the Codex plugin (which runs its own PKCE flow).

### macOS: Keychain Access

```ts
// keychain.ts — reads Claude Code's stored credentials
const raw = execSync(
  `security find-generic-password -s "Claude Code-credentials" -w`,
  { encoding: "utf-8" }
)
```

The stored value is a JSON object wrapped in a `claudeAiOauth` envelope:

```json
{
  "claudeAiOauth": {
    "accessToken": "eyJ...",
    "refreshToken": "...",
    "expiresAt": "2026-04-13T..."
  }
}
```

### Multi-account support

The plugin discovers all Claude Code keychain entries by dumping the keychain and matching against `"Claude Code-credentials(?:-[0-9a-f]+)?"`. Each match is a separate account. When multiple accounts exist, the plugin offers a selection prompt via `auth.methods`.

### Linux/Windows fallback

On non-macOS platforms, reads `~/.claude/.credentials.json` directly — same JSON structure, no Keychain.

### Write-back

After refreshing tokens, the plugin writes updated credentials *back* to the Keychain or credentials file. This keeps Claude Code's own credential store in sync.

---

## 23. Request interception — the fetch wrapper

Like the Codex plugin, the fetch wrapper intercepts every outgoing request and rewrites it. But where Codex rewrites the *URL* (from `api.openai.com` to `chatgpt.com/backend-api/codex/responses`), this plugin keeps the same URL and rewrites *headers and body*.

### Header injection

```ts
function buildRequestHeaders(model: string): Record<string, string> {
  return {
    "authorization": `Bearer ${accessToken}`,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": computeBetas(model).join(","),
    "x-app": "cli",
    "user-agent": `claude-cli/${config.ccVersion} (external, cli)`,
    "X-Claude-Code-Session-Id": sessionId,
  }
}
```

The `x-api-key` header (which the SDK normally sets) is explicitly deleted — OAuth-authenticated requests must use `Authorization: Bearer` instead.

### Beta header computation

Beta headers are model-aware, matching what Claude Code itself would send:

| Model | Base betas | Additional |
|---|---|---|
| All | `claude-code-20250219`, `oauth-2025-04-20`, `prompt-caching-scope-2026-01-05`, `context-management-2025-06-27` | — |
| Non-haiku | `interleaved-thinking-2025-05-14` | — |
| 4.6 models | (base) | `effort-2025-11-24` |
| 1M context | `context-1m-2025-08-07`, `interleaved-thinking-2025-05-14` | Replaces base set |

---

## 24. Billing header signing — the non-obvious part

Anthropic's API validates a billing header on OAuth-authenticated requests. This is the part that has no public documentation — the plugin reverse-engineers Claude Code's internal `K19()` function.

### The header format

```
x-anthropic-billing-header: cc_version=2.1.90.a3f; cc_entrypoint=cli; cch=7b2e1;
```

Three components, each computed differently:

### `cc_version` — version with suffix

The base version (`2.1.90`) comes from config. The 3-character suffix is computed by:

1. Sample characters at indices 4, 7, 20 from the first user message text (pad with `"0"` if shorter)
2. Concatenate: `{BILLING_SALT}{sampled}{version}` where salt is `59cf53e54c78`
3. SHA-256 hash, take first 3 hex characters

```ts
// signing.ts
const sampled = [4, 7, 20]
  .map((i) => (i < messageText.length ? messageText[i] : "0"))
  .join("")
const input = `${BILLING_SALT}${sampled}${version}`
return createHash("sha256").update(input).digest("hex").slice(0, 3)
```

### `cc_entrypoint`

Always `"cli"` (can be overridden via `CLAUDE_CODE_ENTRYPOINT` env var).

### `cch` — content hash

First 5 hex characters of SHA-256 of the first user message's first text block:

```ts
function computeCch(messageText: string): string {
  return createHash("sha256").update(messageText).digest("hex").slice(0, 5)
}
```

### Insertion

The billing header is injected as `system[0]` — the first entry in the system prompt array, *without* `cache_control` (to avoid hitting the 4-entry cache control limit).

---

## 25. System prompt validation — identity splitting and relocation

OAuth-authenticated requests that claim Claude Code billing are validated server-side: the system prompt must contain the Claude Code identity prefix as a *separate* system entry. This requires two transforms that don't exist in opencode's native Claude integration.

### Transform 1: Identity prefix splitting

OpenCode concatenates all system entries into a single text block. But Anthropic's API requires the identity string as a separate entry:

```ts
// Before: one entry
[{ type: "text", text: "You are Claude Code, Anthropic's...\n\n<opencode system prompt>" }]

// After: split into two
[
  { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
  { type: "text", text: "<opencode system prompt>", cache_control: { type: "ephemeral" } }
]
```

The `cache_control` property is preserved only on the remainder block — not the identity block — to stay under the 4-block cache control limit.

### Transform 2: Non-core system prompt relocation

Even after splitting, opencode's own system prompt in the `system[]` array triggers a 400 "out of extra usage" rejection. The work-around: keep only the billing header and identity prefix in `system[]`, and move everything else to the first user message:

```ts
// system[] keeps only:
//   [0] x-anthropic-billing-header: ...
//   [1] You are Claude Code, Anthropic's official CLI for Claude.

// Everything else → prepended to first user message as text blocks
```

This is functionally equivalent (the LLM sees the same text) but avoids the server-side validation check.

---

## 26. Tool name translation — the `mcp_` prefix

Anthropic's API requires MCP tool names to carry a `mcp_` prefix for OAuth-authenticated requests. The plugin adds this prefix on the way out and strips it on the way back.

### Outbound (request body)

```ts
// All tool definitions
tools = tools.map(tool => ({ ...tool, name: `mcp_${tool.name}` }))

// All tool_use blocks in message history
if (block.type === "tool_use") block.name = `mcp_${block.name}`
```

### Inbound (response stream)

```ts
function stripToolPrefix(text: string): string {
  return text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"')
}
```

The response transform buffers SSE at event boundaries (`\n\n`) to avoid splitting a tool name across chunks.

### Orphan repair

After tool name translation, orphaned tool pairs (tool_use without a matching tool_result, or vice versa) can appear — especially when conversation history is truncated. The plugin repairs these by scanning for unmatched IDs and filtering them out:

```ts
function repairToolPairs(messages: Message[]): Message[] {
  // Collect all tool_use ids and tool_result tool_use_ids
  // Filter any that don't have a matching partner
  // Remove messages with empty content arrays after filtering
}
```

---

## 27. Token refresh — two strategies

### Strategy 1: Direct OAuth refresh (preferred)

```ts
POST https://claude.ai/v1/oauth/token
Content-Type: application/json

{
  "grant_type": "refresh_token",
  "refresh_token": "<refresh_token>",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
}
```

The `client_id` is Claude Code's registered OAuth client. The response returns a new `accessToken`, `refreshToken`, and `expiresIn` (defaults to 36000s / 10 hours if not provided — matching Claude's actual token lifetime).

### Strategy 2: CLI fallback

If direct refresh fails, the plugin spawns `claude -p . --model haiku` as a subprocess. This forces Claude Code to refresh its own tokens (and consumes a small amount of Haiku tokens as a side effect). The plugin then re-reads the refreshed credentials from Keychain.

### Credential caching

Credentials are cached with a 30-second TTL per account. A background sync timer runs every 5 minutes (with `unref()` so it doesn't prevent process exit) to write refreshed tokens back to storage.

### 401 retry

On a 401 response, the plugin force-refreshes credentials and retries the request once. On 429/529 (rate limit / overloaded), it uses exponential backoff with jitter, respecting the `retry-after` header.

---

## 28. Effort and model-specific transforms

### Effort stripping for Haiku

Haiku doesn't support the `effort` parameter. OpenCode sends `{ output_config: { effort: "high" } }` globally, which causes Haiku to reject with a 400. The plugin strips `effort` from both `output_config` and `thinking` for models matching `"haiku"`:

```ts
if (override?.disableEffort) {
  delete parsed.output_config.effort
  delete parsed.thinking.effort
}
```

### Long-context beta exclusion

When Anthropic returns a 400 or 429 for a long-context request, the plugin tries removing beta headers one at a time and retrying — a brute-force approach to finding which beta the server rejects for the current model/context combination.

---

## 29. Side-by-side: Codex plugin vs Claude Auth plugin

Both plugins solve the same problem — subscription auth instead of API keys — with structurally similar solutions. The differences reflect the two providers' API designs.

| Dimension | Codex plugin (built-in) | Claude Auth plugin (community) |
|---|---|---|
| **Auth source** | Runs own OAuth PKCE flow against `auth.openai.com` | Reads Claude Code's stored credentials from Keychain |
| **URL rewriting** | Yes — `api.openai.com` → `chatgpt.com/backend-api/codex/responses` | No — same Anthropic endpoint, different headers |
| **Header injection** | `originator`, `session_id`, `ChatGPT-Account-Id` | `authorization`, `anthropic-beta`, `x-app`, `user-agent`, `X-Claude-Code-Session-Id` |
| **Body transforms** | Strip `max_output_tokens`, move system to `instructions` | Inject billing header, split identity prefix, relocate system prompts, add `mcp_` prefix, strip effort, repair tool pairs |
| **Billing verification** | None — OAuth token is sufficient | SHA-256 based billing header with salt, version suffix, content hash |
| **System prompt** | Moves to `instructions` field (OpenAI Responses API quirk) | Splits identity prefix, relocates non-core prompts to user messages |
| **Tool name handling** | None needed | `mcp_` prefix on all tool names (required for OAuth) |
| **Token refresh** | Lazy refresh on every request via `auth.openai.com/oauth/token` | Direct OAuth refresh to `claude.ai/v1/oauth/token` + CLI fallback |
| **Cost model** | Zeroed (flat-rate subscription) | Zeroed (subscription) |
| **Lines of code** | ~608 (single file) | ~1200+ across 7 files |
| **Maintenance** | Built-in, maintained by opencode team | Community, must track Claude Code's internal protocol changes |

### The 2:1 complexity ratio, explained

The Claude Auth plugin is roughly twice the code of the Codex plugin. The extra complexity comes from three sources:

1. **Billing header signing** (~100 lines) — Anthropic validates a computed header on OAuth requests. OpenAI doesn't have an equivalent.
2. **System prompt manipulation** (~80 lines) — Anthropic's server validates that the identity prefix is a separate system entry and that no third-party system prompts appear in `system[]`. OpenAI's Codex endpoint has no such validation.
3. **Tool name translation** (~70 lines including SSE buffering) — Anthropic requires `mcp_` prefixed tool names for OAuth requests. OpenAI doesn't prefix tool names.

Without these three Anthropic-specific requirements, the plugin would be roughly the same size as the Codex plugin. The base architecture (custom fetch, auth interception, cost zeroing, credential management) is essentially identical.

---

## 30. What this means for ask-markdown (updated)

The opencode-claude-auth plugin reveals what it would actually take to use Claude Code's subscription credentials from a third-party tool.

### The credential reuse story

ask-markdown could, in theory, read Claude Code's OAuth tokens from Keychain and talk to Anthropic's API directly — the opencode-claude-auth plugin proves this works. But the cost is high:

1. **Billing header computation** — must replicate the SHA-256 signing protocol exactly, including the salt, character sampling indices, and version string
2. **System prompt compliance** — must present the Claude Code identity prefix as a separate system entry and keep third-party system prompts out of `system[]`
3. **Tool name translation** — must add/strip `mcp_` prefix on all tool names
4. **Token refresh** — must handle OAuth refresh against `claude.ai/v1/oauth/token` with Claude Code's client_id
5. **Version tracking** — must update `ccVersion`, beta headers, and signing parameters whenever Claude Code ships a new version

This is roughly 1200 lines of protocol compliance code that must be maintained in lockstep with Claude Code's releases. Any mismatch in billing header computation, beta headers, or identity prefix results in a 400 rejection.

### Revised architecture options

The original assessment (section 19) noted that direct Claude API integration via API key is trivially simple. The opencode-claude-auth analysis adds a new dimension:

**Option B (API key):** Still ~50-100 lines. Still the simplest path. Requires the user to have an API key with billing.

**Option B′ (subscription auth):** ~1200 lines of protocol compliance. Uses the user's existing Claude Code subscription — no separate billing. But creates a maintenance burden tracking Claude Code's internal protocol. The opencode-claude-auth plugin is a working reference implementation.

**Option D (stay as MCP tool server):** Strengthened by this analysis. Users who want subscription-based Claude access through opencode can install the opencode-claude-auth plugin and connect to our MCP server. We get the benefit without any of the protocol compliance burden.

**Updated read:** The opencode-claude-auth plugin is impressive engineering, but it also demonstrates *why* Option D is attractive — it pushes the protocol compliance burden onto the client (opencode + plugin) rather than the tool server (us). If a user wants to use their Claude subscription with ask-markdown, the path is: install opencode, install opencode-claude-auth, point opencode's MCP config at ask-markdown. We maintain zero lines of auth code.

---

## Appendix: file map for future you

### Codex-specific files

| Concept                     | File in opencode                                             |
|-----------------------------|--------------------------------------------------------------|
| OAuth + fetch wrapper       | `packages/opencode/src/plugin/codex.ts`                       |
| Credential storage schema   | `packages/opencode/src/auth/index.ts`                         |
| OAuth ↔ system prompt swap  | `packages/opencode/src/session/llm.ts` (`isOpenaiOauth`)      |
| `store: false` default      | `packages/opencode/src/provider/transform.ts`                 |
| Codex system prompt text    | `packages/opencode/src/session/prompt/codex.txt`              |
| Error code translations     | `packages/opencode/src/provider/error.ts`                     |
| Plugin registration         | `packages/opencode/src/plugin/index.ts` (`INTERNAL_PLUGINS`)  |

### Claude-specific files

| Concept                          | File in opencode                                             |
|----------------------------------|--------------------------------------------------------------|
| Provider loader (beta header)    | `packages/opencode/src/provider/provider.ts` (lines 175-182) |
| Message normalization + caching  | `packages/opencode/src/provider/transform.ts` (lines 54-103, 192-238) |
| Reasoning / thinking variants    | `packages/opencode/src/provider/transform.ts` (lines 550-582) |
| System prompt selection          | `packages/opencode/src/session/system.ts` (line 30)           |
| Claude system prompt text        | `packages/opencode/src/session/prompt/anthropic.txt`          |
| System prompt delivery (role)    | `packages/opencode/src/session/llm.ts` (lines 150-167)       |
| SDK import                       | `packages/opencode/src/provider/provider.ts` (line 29: `createAnthropic`) |

### opencode-claude-auth plugin files

| Concept                         | File in opencode-claude-auth                                 |
|---------------------------------|--------------------------------------------------------------|
| Plugin entry + fetch wrapper    | `src/index.ts` (492 lines)                                    |
| OAuth credential reading        | `src/credentials.ts` (refresh, caching, sync)                 |
| Keychain / file access          | `src/keychain.ts` (macOS Keychain, cross-platform fallback)   |
| Request/response transforms     | `src/transforms.ts` (billing header, identity split, mcp_ prefix) |
| Billing header computation      | `src/signing.ts` (SHA-256 signing, salt, version suffix)      |
| Model-aware config + betas      | `src/model-config.ts` (version, betas, model overrides)       |
| Plugin settings (1M context)    | `src/plugin-config.ts` (env var + opencode.json config)       |
| Debug logging                   | `src/logger.ts` (file/stream logging with redaction)          |

### Shared infrastructure (provider-agnostic)

| Concept                     | File in opencode                                             |
|-----------------------------|--------------------------------------------------------------|
| Provider loading + merging  | `packages/opencode/src/provider/provider.ts` (1700+ lines)   |
| Model catalog (models.dev)  | `packages/opencode/src/provider/models.ts`                    |
| LLM streaming orchestration | `packages/opencode/src/session/llm.ts`                        |
| MCP client                  | `packages/opencode/src/mcp/index.ts`                          |
| Plugin hook system           | `packages/opencode/src/plugin/index.ts`                       |
| Auth storage                | `packages/opencode/src/auth/index.ts`                         |

The Codex integration is ~700 lines of plugin-specific code. The Claude integration is ~70 lines of provider-specific code spread across the generic infrastructure. The 10:1 ratio in integration complexity reflects the difference in API design — not in capability or treatment within opencode.
