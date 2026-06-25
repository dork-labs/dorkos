---
title: 'Agent & LLM Authentication Patterns Across Meta-Harnesses — A Survey for DorkOS'
date: 2026-06-25
type: external-best-practices
status: active
tags:
  [
    auth,
    oauth,
    credentials,
    claude-code,
    mcp,
    multi-provider,
    pkce,
    keychain,
    agent-runtime,
    anthropic-tos,
  ]
sources_count: 10
searches_performed: 'source-level audit of 10 repos (opensrc-fetched 2026-06-25)'
feature_slug: connect-claude-code-account
---

# Agent & LLM Authentication Patterns Across Meta-Harnesses — A Survey for DorkOS

**Research date:** 2026-06-25
**Research depth:** Deep — source-level audit of 10 agent systems, fetched and read on 2026-06-25
**Purpose:** Guide the design of a "let users authenticate their Claude Code account" feature (and, later, other providers) for DorkOS's hexagonal `AgentRuntime`.

> **Priority dimensions for this survey:** (1) Claude Code account auth, (2) auth UI/UX, (3) MCP server OAuth, (4) multi-provider abstraction.

---

## Related prior art

This builds on and should be read alongside existing DorkOS research. Cross-links (paths only):

- [`research/anthropic-tos-compliance.md`](anthropic-tos-compliance.md) — **the load-bearing constraint for this doc.** Anthropic's Jan-2026 crackdown on third-party tools (OpenCode, Cline, Roo Code, aider) that routed requests through Claude Max subscription OAuth tokens; the SDK's "API key only" stance; DorkOS's LOW-but-nonzero risk posture. Every recommendation below is filtered through it.
- [`research/20260217_claude_code_architecture.md`](20260217_claude_code_architecture.md) — Claude Code's real architecture (the CLI we delegate to).
- [`research/claude-code-sdk-agent-capabilities.md`](claude-code-sdk-agent-capabilities.md) — Claude Agent SDK capabilities, including `pathToClaudeCodeExecutable`.
- [`research/20260218_agent-sdk-context-injection.md`](20260218_agent-sdk-context-injection.md) — SDK context injection / `env` passthrough (the same seam this doc proposes to extend).
- [`research/20260405_ai_coding_agent_runtime_landscape.md`](20260405_ai_coding_agent_runtime_landscape.md) — broader coding-agent runtime survey (opencode, codex, etc. as runtimes).
- [`research/20260405_external_mcp_access_controls.md`](20260405_external_mcp_access_controls.md) — external MCP enable/disable + API-key management UX in DorkOS today.
- [`research/20260324_tunnel_passcode_auth_system.md`](20260324_tunnel_passcode_auth_system.md) — DorkOS's own tunnel passcode auth (a different auth surface, but a UX reference).
- [`research/20260611_workspace_strategy_runtimes_symphony.md`](20260611_workspace_strategy_runtimes_symphony.md) — workspace isolation, relevant to per-workspace credential scoping.
- [`research/dorkos-config-file-system.md`](dorkos-config-file-system.md) — the `~/.dork/config.json` (conf) system a `providers` block would extend.

---

## Executive summary

Ten leading open-source agent systems were audited at the source level (one, Claude Code, from CHANGELOG only — it is a closed binary). The seven most important takeaways:

1. **The dominant meta-harness strategy for Claude is to _inherit the host's existing `claude login`_, not to re-drive an OAuth flow.** Five of six meta-harnesses (paperclip, ruflo, oh-my-hermes, hermes-agent, openclaw) read or defer to the host's `~/.claude/.credentials.json` / macOS Keychain as their primary or sole Claude path. **No meta-harness re-drives Claude Code's `/login` programmatically.** This is also the only **ToS-safe** posture (see Anthropic ToS section).

2. **The host Claude Code credential contract is now well-documented by three independent implementations that agree.** macOS Keychain service `"Claude Code-credentials"` (via `security find-generic-password -s "Claude Code-credentials" -w`), then file `~/.claude/.credentials.json` → `claudeAiOauth.{accessToken, refreshToken, expiresAt}`. Corroborated by hermes (`agent/anthropic_adapter.py:917-954`), openclaw (`src/agents/cli-credentials.ts:419-461`), and omnigent (`ambient.py:425-519`).

3. **Provider registry + per-provider auth dispatch is the convergent architecture** — 7 of 10 repos. Claude/Anthropic is _one entry among many_, with auth method as a discriminator field (`auth_type` / `kind` / `type`). DorkOS's `AgentRuntime` is already the upper boundary; what's missing is a provider/credential _port_ one level down.

4. **OpenRouter and Vercel AI Gateway are not special — they are `baseURL + apiKey` on an OpenAI-compatible (or Anthropic-compatible) adapter.** A gateway is not a new auth strategy. If a registry has a `baseUrl` override + a credential reference, both fall out for free. For Claude Code specifically, this is purely env-var: `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (gateway bearer) + optional `apiKeyHelper`.

5. **Full MCP OAuth 2.1 (auth-code + PKCE + dynamic client registration + loopback callback + paste-fallback) is a separate, near-verbatim-reusable subsystem.** Production-grade in opencode (`packages/opencode/src/mcp/oauth-provider.ts`), codex (`codex-rs/rmcp-client/`), hermes (`tools/mcp_oauth.py`), openclaw (`src/agents/mcp-oauth.ts`), and claude-code. All wrap the official SDK's `OAuthClientProvider`; you implement only storage + the callback server + the redirect. Mind the `localhost`-vs-`127.0.0.1` redirect-URI footgun.

6. **The auth-UX bar is set by Claude Code's `/login` (three-tier mental model + per-platform wizards + honest tradeoff messaging) and Codex's flow craft (branded callback page, device-code fallback with anti-phishing copy, revoke-on-logout, layered keyring/age storage).** No surveyed tool ships a unified browser-OAuth + paste-key + gateway picker — DorkOS would be building net-new ground there.

7. **Credential hygiene converges on: 0o600 atomic writes + a `keychain:`/`env:`/`file:` reference scheme so plaintext never lands in human-edited config, plus log/URL redaction.** Hermes's **"borrowed-vs-owned"** model (fingerprint borrowed tokens, store raw only for self-minted OAuth) is the single most valuable hygiene idea for DorkOS specifically.

**The DorkOS recommendation in one line:** keep delegating to the host `claude` binary (ToS-safe, lowest friction), but add (a) a Zod `providers` config block, (b) a `CredentialProvider` narrow port injected into `ClaudeCodeRuntime` at the existing `message-sender.ts:282-287` env seam, (c) a "connect" UX that reads/validates the host Claude Code login and offers API-key / gateway as explicit alternatives — **never** a re-implemented claude.ai browser OAuth, which violates Anthropic's ToS for distributed products.

---

## Methodology & sources

Ten systems were fetched via `opensrc` and read at the source level on **2026-06-25**, except `anthropics/claude-code` (closed-source binary — behavior derived from its public CHANGELOG, issue tracker, and docs/examples). **Cursor was covered from public docs only** (no source access), and appears only where the corpus references it. Findings carry file-path + line citations; a per-repo `corrections` pass caught and fixed ~40 line-number / attribution errors during the audit (notably a fabricated "OpenAI ChatGPT Plus OAuth mode" in opencode, retracted).

Star counts are approximate (not the focus of this survey; provenance and source-level accuracy were). The corpus splits into three classes:

| #   | Repo                        | Class                          | Role in survey                                                                                      |
| --- | --------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------- |
| 1   | `NousResearch/hermes-agent` | meta-harness (Python)          | **Reference** for host-cred reuse, borrowed-vs-owned hygiene, 30+ provider registry, full MCP OAuth |
| 2   | `openclaw/openclaw`         | standalone agent (TS)          | **Reference** for `readClaudeCliCredentials`, MCP OAuth, the `localhost`/`127.0.0.1` gotcha         |
| 3   | `paperclipai/paperclip`     | meta-harness (TS)              | Delegation pattern; reads Claude creds for quota only; AES-256-GCM at rest                          |
| 4   | `omnigent-ai/omnigent`      | meta-harness (Python)          | `apiKeyHelper` injection, keyring + 0o600 fallback, `keychain:`/`env:` refs, ticket-poll OIDC       |
| 5   | `ruvnet/ruflo`              | meta-harness (JS/TS)           | Thin delegation (`claude mcp serve`); 3-way env-var provider dispatch; standalone MCP OAuth module  |
| 6   | `HERMESquant/oh-my-hermes`  | thin orchestrator (TS)         | The floor — no auth, no MCP; dead-code redactor cautionary tale                                     |
| 7   | `anomalyco/opencode`        | standalone agent (TS)          | **Reference** for two-file cred split + full MCP OAuth 2.1; 22-provider AI-SDK registry             |
| 8   | `openai/codex`              | standalone agent (Rust)        | **Reference** for storage tiers (File/Keyring/Auto/Ephemeral + age), MCP OAuth, revoke-on-logout    |
| 9   | `charmbracelet/crush`       | standalone agent (Go)          | Device-code TUI dialog, catwalk/fantasy registry split; **purges** Claude subscription tokens       |
| 10  | `anthropics/claude-code`    | closed binary (CHANGELOG only) | The spec target for both Claude auth and MCP OAuth; the contract everyone else reads                |

> **Honesty note:** "meta-harness" vs "standalone agent" is a soft distinction — several (hermes, openclaw, opencode) make in-process API calls _and_ can ride a host CLI. What matters for DorkOS is the **Claude subprocess auth mechanism**, tabulated explicitly in the Pattern catalog.

---

## Per-system findings

Specific, cited. The four priority dimensions per repo are condensed; key file paths in monospace.

### 1. `NousResearch/hermes-agent` (Python) — the most complete reference

- **Claude Code auth:** `read_claude_code_credentials()` tries macOS Keychain first (`security find-generic-password -s "Claude Code-credentials" -w`), then `~/.claude/.credentials.json`, reading `claudeAiOauth.accessToken/refreshToken` (`agent/anthropic_adapter.py:917-954`). Full resolution chain `resolve_anthropic_token()` (`:1202-1249`): `ANTHROPIC_TOKEN → CLAUDE_CODE_OAUTH_TOKEN → Claude Code creds → Hermes pool OAuth → ANTHROPIC_API_KEY`. Can optionally shell `claude setup-token` interactively (`:1252-1292`).
- **Multi-provider:** `PROVIDER_REGISTRY`, 30+ `ProviderConfig` dataclasses; `auth_type ∈ {api_key, oauth_device_code, oauth_external, oauth_minimax, external_process, aws_sdk}` (`hermes_cli/auth.py:169-438`). Per-provider `CredentialPool` with rotation/cooldown/refresh. OpenRouter is the catch-all gateway. _Honest gap:_ dispatch is `if self.provider == "anthropic"` branches, not a polymorphic class — uniformity is in the pool, not an interface.
- **Subscription OAuth:** `run_hermes_oauth_login_pure()` does PKCE S256 against `claude.ai/oauth/authorize` but uses Anthropic's **console out-of-band redirect** (`console.anthropic.com/oauth/code/callback`) with manual code paste — **no loopback server** (`:1327-1451`). Uses Anthropic's _own published_ Claude Code client ID `9d1c250a-e61b-44d9-88ed-5944d1962f5e` (same OAuth app, not a claude.ai scrape).
- **MCP OAuth:** Full 2.1 via MCP Python SDK `OAuthClientProvider` (subclassed `HermesMCPOAuthProvider`); loopback `HTTPServer` (`tools/mcp_oauth.py:483`) + stdin paste fallback; tokens at `~/.hermes/mcp-tokens/<server>.json` 0o600; cross-process disk-watch via `st_mtime_ns` (`tools/mcp_oauth_manager.py:468-504`); 401 thundering-herd dedup (`:76`).
- **Hygiene (the standout):** `sanitize_borrowed_credential_payload()` (`agent/credential_persistence.py:151-174`) stores only `sha256:<16-hex>` fingerprints for _borrowed_ tokens; only `_PERSISTABLE_PROVIDER_SOURCES` (5 self-minted sources) write raw (`:20-26`). On logout it **suppresses but never deletes** the host Claude creds (`agent/credential_sources.py:194-204`). `auth.json` atomic `O_EXCL` 0o600, parent 0o700, `flock` (`hermes_cli/auth.py:1094-1129`). Redaction on by default, captured at import time so an in-session `export …=false` can't disable it (`agent/redact.py:67`).
- **Auth UX:** all TUI. `hermes model` (curses picker) → Anthropic shows "Use existing / Reauthenticate / Cancel". `hermes auth add/remove/status`. `HERMES_HOME` selects per-profile credential dirs.

### 2. `openclaw/openclaw` (TS) — most directly transplantable Claude-cred reader

- **Claude Code auth:** `readClaudeCliCredentials()` (file) + `readClaudeCliKeychainCredentials()` (Keychain, darwin) at `src/agents/cli-credentials.ts:419-461`; constants `CLAUDE_CLI_KEYCHAIN_SERVICE = "Claude Code-credentials"` (`:21-27`). Read-only consumption.
- **Subscription OAuth:** own browser flow — binds `CALLBACK_HOST` (127.0.0.1) port 53692, but `REDIRECT_URI = http://localhost:53692/callback` (**localhost, not 127.0.0.1**) (`src/llm/utils/oauth/anthropic.ts:46-54`). Scopes include `user:sessions:claude_code`. Setup-token prefix `sk-ant-oat01-` (`src/plugins/provider-auth-token.ts:5`).
- **Multi-provider:** `registerApiProvider()` registry; 8 built-in API adapters (`src/llm/providers/register-builtins.ts`); 27-entry env-key map incl. `openrouter`, `vercel-ai-gateway` (`src/llm/env-api-keys.ts:164`); OAuth abstracted behind `OAuthProviderInterface` (Anthropic, GitHub Copilot, OpenAI Codex).
- **MCP OAuth:** full 2.1 via `@modelcontextprotocol/sdk/client/auth`; DCR + PKCE; per-server token files 0o600 keyed by **SHA-256(serverName + serverUrl)** (`src/agents/mcp-oauth.ts:56-59`); redirect `127.0.0.1:8989` → `localhost` fallback on `invalid_client_metadata` (`:49-50`).
- **Hygiene:** config + log redaction; per-(provider,profile) refresh file lock (`auth-profiles/path-resolve.ts:64-68`); tests assert refresh errors don't echo tokens. Default auth store `~/.openclaw/agents/main/agent/auth-profiles.json`.

### 3. `paperclipai/paperclip` (TS) — pure delegation; reads Claude creds for quota only

- **Claude Code auth:** does **not** manage Claude OAuth. Billing type: `ANTHROPIC_API_KEY` set → `"api"`, else `"subscription"` (inherits host `claude login`) — `resolveClaudeBillingType` (`packages/adapters/claude-local/src/server/execute.ts:132-135`; Bedrock → `"metered_api"`). Reads `~/.claude/.credentials.json` **only for quota polling** (`quota.ts:140-147`). Detects login-required by regex over Claude stderr (`parse.ts:9`).
- **Multi-provider:** `ServerAdapterModule` registry, 13 adapters in `adaptersByType` Map (`server/src/adapters/registry.ts:538-556`); plugins can override at runtime.
- **MCP OAuth:** N/A — its `packages/mcp-server` is a _server_ Claude Code connects _to_, authed by static `Authorization: Bearer ${PAPERCLIP_API_KEY}` over stdio (`packages/mcp-server/src/client.ts:85`).
- **Hygiene:** AES-256-GCM local secrets at rest (`local-encrypted-provider.ts`); strips **all** `ANTHROPIC_*` env from the quota subprocess (`createClaudeQuotaEnv`, `quota.ts:24-31`); per-tenant JWT key derivation (HMAC of master secret + companyId). Board CLI auth: device-code-like challenge/poll → `~/.paperclip/auth.json` 0o600.
- **Auth UX:** only repo with a real **web GUI** for primary auth (`/auth`, email+password via better-auth). CLI `paperclipai auth login`/`connect` device-code-like flow.

### 4. `omnigent-ai/omnigent` (Python) — `apiKeyHelper` injection + keyring-first storage

- **Claude Code auth:** three tiers in `resolve_native_claude_config()` (`omnigent/claude_native.py:1658`): (1) provider config delivers creds via Claude's **`apiKeyHelper`** — static key → `printf %s <key>` (`:1494`), dynamic `auth_command` verbatim (`:1491`), and `ANTHROPIC_API_KEY` is **unset** so the helper is the only path (`:3996-4000`); (2) Databricks ucode profile; (3) `subscription` → returns `None`, Claude Code uses its own creds (`:1633,1654`). Ambient detection: pure file check `claude_auth_has_credential()` (`ambient.py:425-477`) + macOS `claude auth status` fallback `_claude_login_detected()` (`:480-519`). `CLAUDE_CODE_OAUTH_TOKEN` in host→runner allowlist (`host/connect.py:334`).
- **Multi-provider:** kind-typed `ProviderEntry`: `kind ∈ {key, subscription, gateway, local, databricks, cli-config, bedrock}`; `_HARNESS_FAMILY` maps harness→family without embedding provider names (`provider_config.py:140-174`).
- **MCP OAuth:** N/A (static only) — `headers: {Authorization: Bearer …}` or Databricks token-at-connect (`tools/mcp.py:101-122`).
- **Hygiene:** keyring (`keyring` pkg) + 0o600 JSON fallback (`secrets.py:161`); config refs `keychain:<name>`/`env:<VAR>` never plaintext; `MCPServerConfig.__repr__` redacts headers+env; `describe_active_credential()` shows source descriptor, never the secret.
- **Auth UX:** termios arrow-key wizard `omnigent setup`; `omnigent login` ticket-poll OIDC (polls `/auth/cli-poll?ticket=…` every 2s — **loopback-free**, `cli.py:12132-12185`).

### 5. `ruvnet/ruflo` (JS/TS) — thin delegation + 3-way env dispatch

- **Claude Code auth:** delegates entirely — spawns `{command:"claude", args:["mcp","serve"]}` (`ruflo/src/mcp-bridge/index.js:257`). `doctor` reports `Claude Code (managed internally)` when CC env vars present and no Claude key (`doctor.ts:282-291`). Own swarm `agent_execute` is `ANTHROPIC_API_KEY`-only.
- **Multi-provider:** `callAnthropicMessages()` 3-way dispatch: `RUFLO_PROVIDER=openrouter|ollama` > key-presence (`OPENROUTER_API_KEY` > `OLLAMA_API_KEY` > `ANTHROPIC_API_KEY`), normalized to `AnthropicCallResult` (`agent-execute-core.ts:125-233`). Also a formal `ProviderManager` factory (load-balanced) but env dispatch is the hot path.
- **MCP OAuth:** a standalone OAuth 2.1 + PKCE **module** (`v3/@claude-flow/mcp/src/oauth.ts`) with pluggable `TokenStorage` — but **no DCR** and **not wired** to an MCP connection path. A reusable part, not a working feature.
- **Hygiene:** opt-in AES-256-GCM vault (`CLAUDE_FLOW_ENCRYPT_AT_REST`), key from env only. Timing-safe Bearer compare for MCP HTTP transport.

### 6. `HERMESquant/oh-my-hermes` (TS) — the floor

- **Everything auth: N/A.** Detects `claude`/`codex` via `which` (`src/shared/detect.ts:66-73`); `TOOLS` enum is exactly `CLAUDE='claude' | CODEX='codex'` (`src/shared/constants.ts:20-23`). No MCP (string "mcp" absent from the tree). `sanitizeSensitive()` exists but is **dead code, zero call sites** (`src/shared/utils.ts:74-94`). Included only as a contrast: even a thin orchestrator benefits from _naming_ the provider boundary.

### 7. `anomalyco/opencode` (TS) — cleanest two-file separation

- **Claude Code auth:** none — no dependency on the `claude` CLI or `~/.claude/.credentials.json`. Anthropic is `ANTHROPIC_API_KEY` env or a pasted key in `auth.json` (`x-api-key` header), **no OAuth** (`packages/llm/src/providers/anthropic.ts:14-17`). _(The original finding's "ChatGPT Plus OAuth mode" was fabricated and retracted.)_
- **Multi-provider:** `BUNDLED_PROVIDERS` registry, **22** AI-SDK factory entries incl. `@openrouter/ai-sdk-provider`, bedrock×2, vertex×2, gitlab (`packages/opencode/src/provider/provider.ts:107-134`); composable `Credential → Auth → Headers` pipeline with Effect `Redacted` (`packages/llm/src/route/auth.ts`).
- **MCP OAuth (crown jewel):** full 2.1 — `McpOAuthProvider` + loopback callback port 19876, DCR, PKCE, CSRF-state (rejects missing state, `src/mcp/oauth-callback.ts:98-101`), `getForUrl` per-URL credential binding; separate store `mcp-auth.json` 0o600 with `EffectFlock` (`src/mcp/auth.ts:37`). Commands `opencode mcp auth/logout/debug <name>`.
- **Hygiene:** two-file split — provider `auth.json` (`$XDG_DATA_HOME/opencode/auth.json` 0o600) vs `mcp-auth.json`; `OPENCODE_AUTH_CONTENT` env override for CI; `OAUTH_DUMMY_KEY` sentinel bridges OAuth tokens into key-shaped SDK interfaces.
- **Auth UX:** `opencode providers login` (`@clack/prompts` autocomplete; **not** `auth login`); device-code `console login`; web `dialog-connect-provider.tsx`.

### 8. `openai/codex` (Rust) — the storage masterclass

- **Claude Code auth:** N/A (OpenAI tool; zero Anthropic refs). `$CODEX_HOME` default `~/.codex`.
- **Subscription OAuth (ChatGPT):** `codex login` — browser loopback PKCE S256 on `127.0.0.1:1455` (fallback 1457), branded HTML callback page with `missing_codex_entitlement` copy (`codex-rs/login/src/server.rs:1131-1144`). `--device-auth` fallback prints code + **anti-phishing copy** "Device codes are a common phishing target. Never share this code." (`device_code_auth.rs:154-156`). `--with-api-key` reads stdin (CI-friendly).
- **Storage (borrow this):** `AuthCredentialsStoreMode = File|Keyring|Auto|Ephemeral` + `AuthKeyringBackendKind = Direct|Secrets` (age-encrypted `$CODEX_HOME/secrets/codex_auth.age`). Three namespaced `.age` files: `local.age`, `codex_auth.age`, `mcp_oauth.age` (`secrets/src/local.rs`). Auto mode tries keyring, `warn!`s, falls back to file 0o600.
- **Multi-provider:** `ModelProvider` trait + `ModelProviderInfo.env_key`; local providers use `UnauthenticatedAuthProvider`; external `command`-based bearer refresher.
- **MCP OAuth:** full 2.1 in `codex-rs/rmcp-client/`; DCR via `rmcp`, loopback `127.0.0.1:0`, callback path = base64url(SHA-256(url)[:9]); proactive refresh 30s before expiry; keyring service `"Codex MCP Credentials"`; `determine_streamable_http_auth_status` probes `/.well-known/oauth-authorization-server`.
- **Hygiene:** `redact_sensitive_url_parts()` strips `access_token`/`code_verifier`/`refresh_token`/`state` from logs; HTML-escaped error fields; `logout_with_revoke()` **posts to the revoke endpoint** before deleting locally.

### 9. `charmbracelet/crush` (Go) — polished device-code TUI; purges Claude subscription

- **Claude Code auth:** **actively purges** any lingering Anthropic OAuth token on load — `// Claude Code subscription is not supported anymore. Remove to show onboarding.` (`internal/config/load.go:270-277`). Anthropic = `ANTHROPIC_API_KEY` only; clears env to prevent SDK ambient pickup (`coordinator.go:789-803`).
- **Subscription OAuth (non-Anthropic):** Charm Hyper + GitHub Copilot device-code flows, both TUI (Bubble Tea) + CLI; Copilot auto-imports `~/.config/github-copilot/apps.json`.
- **Multi-provider:** two-library split — `catwalk` (remote-fetched provider metadata, cached `~/.local/share/crush/providers.json`, embedded fallback) + `fantasy` (HTTP-protocol SDK). `buildProvider` switch on `Type`: anthropic/openai/openrouter/vercel/azure/bedrock/google/… (`coordinator.go:1023`).
- **MCP OAuth:** N/A (static headers only, via `shellVariableResolver` `$VAR`/`${VAR}`/`$(command)`).
- **Hygiene:** three-phase locked token refresh (`store.go:386-459`); HTTP header redaction; `sanitizeResolveError` never leaks post-expansion secrets. _Weak spot:_ raw OAuth tokens plaintext in `~/.local/share/crush/crush.json`.
- **Auth UX:** `crush login [hyper|copilot]`; `crush logout` with no arg lists logged-in platforms numerically.

### 10. `anthropics/claude-code` (closed binary; CHANGELOG-derived) — the spec target

- **Claude Code auth (three tiers):** (1) **claude.ai subscription OAuth** — `/login` → browser → loopback callback (Windows port 45454, 1.0.54); token → `~/.claude/.credentials.json` + macOS Keychain; `subscriptionType` (`Pro`/`Max`/`Team`/`Enterprise`) in the file; **paste-code fallback** for WSL2/SSH (2.1.126); `CLAUDE_CODE_OAUTH_TOKEN` supplies it directly. (2) **Console API key** — `claude auth login --console` (2.1.79); setting `ANTHROPIC_API_KEY`/`apiKeyHelper`/`ANTHROPIC_AUTH_TOKEN` **disables** Remote Control, `/schedule`, claude.ai MCP connectors even if a claude.ai login coexists (2.1.139). (3) **Third-party** — Bedrock/Vertex/Foundry via env + interactive wizards. CLI `claude auth login/status/logout` (2.1.41).
- **Multi-provider:** env-var driven — `ANTHROPIC_BASE_URL` (gateway), `ANTHROPIC_AUTH_TOKEN` (gateway bearer), `apiKeyHelper` (dynamic keys, 5-min TTL, 0.2.74), `modelOverrides`, `ANTHROPIC_WORKSPACE_ID` (workload identity, 2.1.141). A regression where the user's Anthropic OAuth credential leaked to a custom gateway was fixed in 2.1.153 — a cautionary tale for base-URL overrides.
- **MCP OAuth (the standard):** RFC 9728 Protected Resource Metadata discovery (2.1.85), DCR with **CIMD/SEP-991 fallback**, pre-configured `--client-id`/`--client-secret` for servers without DCR (Slack), loopback + paste-URL SSH fallback, step-up authorization (403 insufficient_scope, 2.1.49), `oauth.authServerMetadataUrl` override (2.1.69), proxy/mTLS through the full flow (2.1.133). `/mcp` TUI shows per-server status; OAuth browser page styled + auto-closes (2.1.181).
- **Hygiene:** `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` strips creds from subprocess envs (2.1.83); `sandbox.credentials` blocks sandboxed commands from reading credential files (2.1.187); `claude mcp list/get/add` redact `${VAR}` refs (2.1.161).

---

## Pattern catalog

Nine cross-cutting patterns, named and weighed. (Condensed from the cross-cutting `patterns` lens; full citations above.)

### Pattern 1 — Reuse host Claude Code credentials (Keychain → `~/.claude/.credentials.json`)

Read the credentials an existing `claude login` already wrote; Keychain (`"Claude Code-credentials"`) first, file second. Used by hermes, openclaw, omnigent (subscription tier), paperclip (quota only), and is the contract claude-code writes. **Pros:** zero re-auth friction, no token-storage liability, honors the user's existing session/refresh. **Cons:** couples to an undocumented on-disk contract that has shifted (corruption/format fixes in the CHANGELOG); refresh races corrupt the Keychain; macOS-only for the Keychain tier. **Fit:** the single most directly transplantable pattern for DorkOS's "connect your Claude Code account" goal — _and_ the only ToS-safe one.

### Pattern 2 — Env-var passthrough to a subprocess coding agent

Forward `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` into the child. Most explicit in omnigent (`host/connect.py:334`); fallback in hermes (`:1226`); CI in openclaw. **Pros:** dead simple, CI-friendly, child owns refresh. **Cons:** env vars leak into process trees/logs unless scrubbed (claude-code's `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`); ambient `ANTHROPIC_API_KEY` can silently override a subscription path (why omnigent/crush _unset_ it). **Fit:** CI/headless and the `setup-token` path — but **`CLAUDE_CODE_OAUTH_TOKEN` is a subscription token, so distributing it is the ToS-risky pattern** (see ToS section).

### Pattern 3 — `apiKeyHelper` / credential-helper shell-out

Configure the agent with a command that _emits_ a credential on demand (5-min TTL). omnigent is the only harness exploiting it (Databricks/enterprise); claude-code defines it; codex has the parallel `ModelProviderAuthInfo.command`. **Fit:** enterprise/gateway (Bedrock SigV4, Databricks ~1h tokens, GCP workload identity). The right primitive for DorkOS _if_ enterprise metered-API billing matters.

### Pattern 4 — Provider registry + per-provider auth dispatch

A first-class registry decouples callers from any backend; auth method is a discriminator. 7 of 10 repos (hermes, openclaw, omnigent, paperclip, opencode, crush, codex). **Disagreement on shape:** opencode/codex/openclaw use a real interface; hermes is honest it uses `if provider == "anthropic"` branches with uniformity only in the pool. Both ship — the registry value is in the _data_, not necessarily a class hierarchy. **Fit:** any system expecting >2 backends; DorkOS's `AgentRuntime` is exactly this seam at the upper level.

### Pattern 5 — Browser OAuth with loopback callback (subscription)

Auth-code + PKCE against `claude.ai/oauth/authorize`, redirect to a localhost listener, paste-URL fallback. claude-code (canonical), openclaw (own flow). **Outlier:** hermes uses Anthropic's console out-of-band redirect, no loopback. Both reuse Anthropic's _own_ Claude Code client ID. **Footgun:** `localhost` vs `127.0.0.1` redirect mismatch. **Fit for DorkOS: AVOID re-implementing** — it's the ToS-violating pattern for distributed products. Borrow the callback/paste mechanics for MCP, not a hand-rolled Anthropic client.

### Pattern 6 — Device-code / ticket-poll (loopback-free)

CLI prints a code/URL, user approves, CLI polls. omnigent ticket-poll OIDC, paperclip board auth, crush (Hyper/Copilot), codex `--device-auth`. None use it for _Claude_ — it's for the harness's own control plane or Hyper/Copilot. **Fit:** authenticating the user to **DorkOS's own server** without a loopback — omnigent's `/auth/cli-poll?ticket=…` is the cleanest reference.

### Pattern 7 — Full MCP OAuth 2.1 (auth-code + PKCE + DCR + loopback)

Complete OAuth 2.1 client for _outbound_ MCP connections. Full: opencode, codex, hermes, openclaw, claude-code. Partial: ruflo (module, no DCR, not wired). None: omnigent/crush (static), paperclip/oh-my-hermes (N/A). All wrap an SDK's `OAuthClientProvider`; you implement storage + callback + redirect. **Convergence:** 0o600 per-server files keyed by hash(name+url), loopback callback, paste fallback, proactive refresh, CSRF-state. **Fit:** directly relevant to DorkOS's _own_ outbound MCP connections.

### Pattern 8 — Thin delegation: shell out, hold nothing

Detect `claude` on PATH, spawn it, trust the host login. oh-my-hermes (purest), ruflo (for Claude). **Pros:** max simplicity, zero credential liability, ToS-safe. **Cons:** no quota visibility, no refresh control, no "connect account" UX. **Fit:** DorkOS today _is_ this — but DorkOS wants more (account-connect UX, status), so delegation alone is insufficient; it's the safe _base_ to build on.

### Pattern 9 — Borrowed-vs-owned credential hygiene (cross-cutting hardening)

Store raw tokens only for OAuth the harness _minted_; fingerprint borrowed tokens. Plus 0o600 atomic writes, log redaction, subprocess env scrubbing. Reference: hermes (`credential_persistence.py:151-174`). **Storage spectrum:** OS-keychain-primary (codex, omnigent) vs plaintext-0o600 (opencode, openclaw, paperclip, hermes, crush) vs none (oh-my-hermes, ruflo). **Fit:** the hardening every credential-holding system should adopt; hermes's borrowed-vs-owned is _the_ idea for DorkOS — reuse host creds without owning them.

### Notable outliers & disagreements

- **`localhost` vs `127.0.0.1`** — openclaw and opencode both independently hit it: bind `127.0.0.1`, but the registered `redirect_uri` must be `localhost`. A real, repeated footgun.
- **crush purges Claude subscription tokens** entirely — "subscription support" is a product decision, not a technical inevitability (and crush chose ToS-safety).
- **Dead-code hygiene (oh-my-hermes)** — a correct `sanitizeSensitive()` regex with zero call sites. Wire in any redactor you borrow.
- **paperclip reads Claude creds for quota only** — a clean separation: defer auth to `claude login`, read the file only to show usage.

---

## Auth UI/UX gallery

Four interaction archetypes recur: **paste-key**, **browser loopback OAuth**, **device-code / ticket-poll**, **out-of-band paste-code**. The best flows treat these as _fallbacks of one another_ (loopback → paste-code when localhost is unreachable), not as separate commands.

**Ranked against the Jobs/Ive bar** (does the user understand what's happening; frictionless happy path; graceful fallbacks; honest errors; finished "back of the fence" — logout, revocation, redaction, status):

- **Tier S — `claude-code /login`** (the bar-setter): one TUI selector cleanly separates three mental models (subscription / console key / 3rd-party), with wizards for the hard ones; one-browser-hop happy path; paste-code SSH fallback; **honest about tradeoffs** (tells you setting an API key _disables_ subscription features); `/doctor` turns auth failures into actionable hints (`security unlock-keychain`). Demerit: one claude.ai account at a time.
- **Tier S — `codex login`** (most crafted terminal flow): loopback PKCE with a _branded, HTML-escaped_ callback page; device-code fallback with **anti-phishing copy**; `--with-api-key` reads stdin for CI; **logout actually revokes server-side**; storage ladder (File/Keyring/Auto/Ephemeral + age) finishes the back of the fence.
- **Tier A — opencode** (`mcp auth` + `console`): cleanest architecture → UX clarity; provider and MCP auth never bleed; CSRF enforced; `console switch` is a real multi-account switcher; web `dialog-connect-provider`. Demerit: provider login is mostly paste-key.
- **Tier A — crush** (`crush login`): most _beautiful_ Bubble Tea dialog; `logout` lists platforms numerically; auto-import existing Copilot token; remote-fetched registry. Demerit: amputated Claude subscription support.
- **Tier B — hermes** (`hermes model`/`hermes auth`): most _powerful_ (30+ providers, pools, profiles) but density over clarity; out-of-band paste (no loopback) is a step down from Codex's loopback; excellent error taxonomy (`relogin_required`, `STATUS_DEAD`).
- **Tier B — omnigent**: keychain-first storage; "connected as `keychain:anthropic`" status that never leaks the secret; termios wizard with check/cross agent detection; loopback-free ticket-poll. Demerit: no interactive account switcher; static-only MCP.
- **Tier B — paperclip**: only real _web GUI_ for primary login; tidy device-code board flow. But Claude auth is entirely _deferred_ (reads `claude` stderr to surface a login URL — fragile).
- **Tier F — ruflo / oh-my-hermes**: not a flow. Env-var dispatch + a `doctor` check; `which claude`. Included as the floor.

**The "connected as X" rendering split:** terminal status commands (`codex login --status`, `hermes auth status`, `paperclipai auth whoami`) vs GUI panels (opencode's `dialog-connect-provider`, paperclip's web UI). **DorkOS, having a real React client, should render a settings panel with the source descriptor + subscription tier** — mirroring claude-code's `subscriptionType` field (`Pro`/`Max`/`Team`/`Enterprise`) persisted in `~/.claude/.credentials.json`.

> **The gap the corpus validates but none ships:** a single Jobs/Ive-grade picker unifying browser-OAuth + paste-key + gateway providers. The closest are claude-code's `/login` (Anthropic-only) and hermes's 30-provider curses list (powerful but uncurated). DorkOS would be building net-new ground.

---

## MCP server OAuth model

**Who's full:** opencode, codex, hermes, openclaw, claude-code. **Partial:** ruflo (module, no DCR, unwired). **None:** omnigent, crush (static headers), paperclip, oh-my-hermes (N/A).

**The convergent design (concrete moving parts):**

1. **Wrap the official SDK's `OAuthClientProvider`** (TS: `@modelcontextprotocol/sdk/client/auth`; Rust: `rmcp`). You implement only storage + callback + redirect; the SDK owns PKCE, DCR, discovery, refresh grant.
2. **Loopback callback on 127.0.0.1** — codex `127.0.0.1:0` (random, path = base64url(SHA-256(url)[:9])); opencode fixed `:19876`; hermes random + stdin paste. **Send both `127.0.0.1` and `localhost` redirect spellings** (opencode falls back on `invalid_client_metadata`). **Always provide a paste-the-URL fallback** for SSH/WSL/containers — non-negotiable for headless hosts.
3. **CSRF/state enforcement** — validate `state` on callback, reject if missing/mismatched (opencode `oauth-callback.ts:98-101`).
4. **Per-server token file at 0o600**, keyed by a hash of **both** name and URL (never URL alone — prevents collisions). Each record stores `tokens`, dynamic `clientInformation`, `codeVerifier`, `oauthState`, `serverUrl`.
5. **Refresh + cache** — persist absolute `expires_at` (not just `expires_in`), refresh proactively (codex 30s, ruflo 60s), recompute remaining lifetime on reload so a restarted process refreshes (hermes `mcp_oauth.py:248-270`).
6. **Concurrency safety** (the part the SDK does _not_ give you) — file locking (opencode `EffectFlock`, hermes `fcntl.flock`), cross-process disk-watch (`st_mtime_ns`), 401 thundering-herd dedup. claude-code's CHANGELOG proves these matter (2.1.69 keychain corruption with multiple OAuth MCP servers; 2.1.136 refresh-token loss under concurrency).
7. **Auth-status discovery** — probe `/.well-known/oauth-authorization-server` or react to `UnauthorizedError`; surface per-server state (Connected / Needs-auth / Failed). In SDK/headless mode, hide an unauthenticated server's tools from the model until authenticated (claude-code 2.1.183).
8. **CLI verbs** — universally `<tool> mcp login <name>` / `mcp logout <name>` with `--no-browser`/`--code <code>`.

**The DorkOS adaptation:** DorkOS is a _server_ with multiple client surfaces (web, Obsidian, desktop, CLI), so the loopback assumption needs one tweak — the callback must land on the DorkOS Express server, and the "this MCP server needs auth" UX must surface in the React console, not just a terminal. Concretely: wrap `OAuthClientProvider` (opencode's `oauth-provider.ts` + `oauth-callback.ts` pair is the closest TS transplant); store a dedicated `mcp-oauth.json` under `~/.dork/` (via `lib/dork-home.ts`), 0o600 + file lock, keyed by SHA-256(name+url), **kept separate** from provider/account credentials (opencode's `auth.json` vs `mcp-auth.json` split); register a loopback callback route on the Express server (send both redirect spellings, validate `state`); adopt hermes's disk-watch + 401 dedup because DorkOS is explicitly multi-agent; surface auth state as first-class console status with a "Connect" action and a paste-code fallback.

---

## Multi-provider abstraction

**Two architectures, and the distinction is the whole story:**

- **In-process API callers** (hermes, openclaw, opencode, crush, codex, omnigent) own the HTTP boundary → they need a real provider registry + credential store + auth-strategy dispatch. Rich, transplantable seams.
- **CLI-delegating orchestrators** (paperclip, ruflo, oh-my-hermes, **and DorkOS today**) shell out to an already-authenticated `claude`/`codex` binary → no provider abstraction of their own; the CLI _is_ the provider boundary; credentials are whatever the host process inherited.

**The clean implementations separate three concerns** naive code conflates: (1) provider identity & wire protocol (Anthropic Messages vs OpenAI Completions, `baseURL`), (2) credential material (the secret), (3) auth strategy (static key / OAuth+PKCE / device code / `apiKeyHelper` / AWS SDK / keyring lookup). Make (1) a registry, (2) a _reference_ never inline plaintext, (3) a discriminated union keyed off the provider entry.

**OpenRouter & Vercel AI Gateway are `baseURL + apiKey` on an OpenAI-compatible adapter** — not a new auth strategy. opencode (dedicated `@openrouter/ai-sdk-provider`), openclaw + crush (env-key/switch entries), hermes (catch-all gateway). For Claude Code: purely `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` + optional `apiKeyHelper`.

**Subscription-OAuth vs API-key coexistence** — the cleanest tools treat them as two `auth_type` values on the _same_ Anthropic provider entry, resolved by a priority chain, not two providers. Hermes's chain is canonical (`anthropic_adapter.py:1202-1249`). claude-code's rule (2.1.139): API-key presence disables subscription-only features even if a claude.ai login coexists — the active credential is chosen by precedence, feature availability follows.

### DorkOS today (verified 2026-06-25)

DorkOS has **no provider abstraction below `AgentRuntime`** — pure CLI-delegating orchestrator:

- The `AgentRuntime` interface (`packages/shared/src/agent-runtime.ts:212`) abstracts _agent backends_, not _providers/credentials_. It already has the narrow-port pattern: `AgentRegistryPort` (`:49`), `RelayPort` (`:65`), `SessionSettingsPort` (`:75`).
- The credential/provider seam is **exactly** `apps/server/src/services/runtimes/claude-code/messaging/message-sender.ts:282-287`, which spreads `process.env` wholesale into the SDK subprocess:

```ts
env: {
  // eslint-disable-next-line no-restricted-syntax -- full env needed for SDK subprocess inheritance
  ...process.env,
  CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
},
...(opts.claudeCliPath ? { pathToClaudeCodeExecutable: opts.claudeCliPath } : {}),
```

There is **zero** `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / `apiKeyHelper` / OpenRouter handling anywhere in `apps/server/src/services/runtimes/`. `UserConfigSchema` has **no `providers` block**. The model is amnesiac-by-host: whatever `claude login` did is what every session uses — fine for one operator on one machine, breaks the moment you want per-agent/per-workspace credentials, an org API key vs a personal subscription, or a gateway.

---

## Emerging best practices (the consensus)

The corpus converges on a recognizable "good" shape:

1. **Prefer reading an existing host login over re-driving an OAuth flow.** Especially for Claude — it's lower-friction _and_ the only ToS-safe posture.
2. **Provider = data, not code.** A registry of named entries with a discriminated `authType`/`kind`/`type`; `baseURL` override makes gateways free.
3. **Credentials are references, never inline plaintext.** `keychain:<name>` / `env:<VAR>` / `file:<path>` in human-edited config; resolve at runtime; secrets to keychain (preferred) or a 0o600 file.
4. **Borrowed-vs-owned:** fingerprint tokens you didn't mint; store raw only for OAuth sessions you own; never delete the host's own credential on logout.
5. **MCP OAuth is a separate subsystem** — wrap the official SDK's `OAuthClientProvider`, separate token store, loopback + paste fallback, both redirect spellings, CSRF-state, proactive refresh, cross-process safety.
6. **Finish the back of the fence:** log/URL redaction, subprocess env scrubbing, `--status`/whoami, logout (with server-side revoke where supported), honest tradeoff messaging.
7. **Two-store separation:** provider/account credentials and MCP-OAuth tokens live in different files (opencode `auth.json`/`mcp-auth.json`; codex `codex_auth.age`/`mcp_oauth.age`).

---

## Recommendations for DorkOS

DorkOS uses the **official Claude Agent SDK** and delegates auth to the host `claude` binary via `pathToClaudeCodeExecutable`. That is the **compliant base** ([`research/anthropic-tos-compliance.md`](anthropic-tos-compliance.md)). Build _outward_ from it; do not replace it.

### The Anthropic ToS constraint (read first — it gates everything below)

Anthropic's Consumer ToS §3 prohibits programmatic access except via the official API. The Agent SDK docs state: _"Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."_ In Jan-2026 Anthropic **server-side-blocked** OpenCode, Cline, Roo Code, and aider for routing requests through Claude Max **subscription OAuth tokens**, and temporarily suspended some accounts.

**Implications for the four candidate Claude-auth approaches:**

| Approach                                                                       | Mechanism                                                                   | ToS posture                                                                                                                                                                                                       | Verdict for DorkOS                                                                                                        |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Shell out to `claude` / inherit host login**                                 | DorkOS reads nothing; the user's own CLI authenticates and the SDK rides it | **Safest.** The user's own CLI install authenticates; DorkOS is self-hosted and offers no "claude.ai login" product. This is what DorkOS does today.                                                              | **ADOPT as the default.** Add only _detection + status_, not a re-implemented flow.                                       |
| **`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`**                           | DorkOS captures/forwards a **subscription** token                           | **Risky.** This is the exact "wrap subscription-authenticated access" pattern Anthropic blocked. Fine for a single self-hosting operator on their own machine; **do not productize / distribute / multiplex it.** | **Allow as an advanced/self-host escape hatch only**, behind a clear ToS warning. Never the default or the marketed path. |
| **API key (`ANTHROPIC_API_KEY`)**                                              | Pay-per-token, the SDK's intended auth                                      | **Fully compliant** — the recommended method per the ToS research.                                                                                                                                                | **ADOPT as the recommended "connect" option** in the UX, with a one-line "fully supported, billed per token" note.        |
| **Gateway (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` / Bedrock / Vertex)** | Points at a compliant proxy / enterprise provider                           | **Compliant** (it's API-billing infrastructure).                                                                                                                                                                  | **ADOPT for enterprise/BYO-gateway**, modeled as `baseUrl + credentialRef`.                                               |

**Bottom line:** "connect your Claude Code account" should mean **detect-and-validate the host's existing `claude login`** (subscription or console), surface it as connected, and offer **API key** + **gateway** as first-class alternatives. It must **not** mean DorkOS drives a claude.ai browser OAuth or distributes subscription tokens.

### Concrete plan

**1. Model the provider as a Zod-schema'd config entry, not code.** Add a `providers` block to `UserConfigSchema` (`packages/shared/src/config-schema.ts`), following omnigent's kind-typed model:

```ts
ProviderEntry = {
  id: string;                                       // "anthropic", "my-gateway", "openrouter"
  protocol: 'anthropic' | 'openai-compatible';      // wire shape
  baseUrl?: string;                                 // gateway/proxy — OpenRouter & Vercel AI Gateway are JUST this
  authType: 'host-cli' | 'api-key' | 'auth-token' | 'helper';  // note: 'subscription' is via host-cli only
  credentialRef?: SecretRef;                        // keychain:<name> | env:<VAR> | file:<path> — NEVER inline plaintext
  helperCommand?: string;                           // apiKeyHelper-style dynamic token
}
```

Follow the established config lifecycle (Zod field → defaults → conf semver migration → docs → test) per the `adding-config-fields` skill / `contributing/configuration.md`; extend `SENSITIVE_CONFIG_KEYS`. Note: `host-cli` deliberately replaces a `subscription` authType so the schema can't express "DorkOS owns a subscription token" — that keeps the ToS-risky path out of the marketed surface by construction.

**2. Introduce a `CredentialProvider` narrow port; inject it into the runtime.** Mirror the existing `AgentRegistryPort`/`RelayPort`/`SessionSettingsPort` pattern (`agent-runtime.ts:49,65,75`):

```ts
interface CredentialProvider {
  resolve(
    providerId: string
  ): Promise<{ env: Record<string, string>; baseUrl?: string; executablePath?: string }>;
}
```

`ClaudeCodeRuntime` stops spreading raw `process.env` and instead asks this port, merging the resolved `env` (e.g. `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`, or _nothing_ for host-CLI) at the **exact** seam that exists today — `message-sender.ts:282-287`. This keeps all SDK contact inside `services/runtimes/claude-code/` (ESLint-enforced) and credential resolution out of it. One line of behavior change, a clean new seam.

**3. Resolution order: read Claude Code's login first, owned credentials second.** Adopt hermes's precedence + borrowed-vs-owned model in spirit:

1. Explicit per-session/agent/workspace provider override (DorkOS already has `WorkspaceManager` + `workspaceKey`).
2. **Host Claude Code login** — read `~/.claude/.credentials.json`, fall back to macOS Keychain `"Claude Code-credentials"` (openclaw's `cli-credentials.ts:419-461` is the most transplantable TS reference; shape `claudeAiOauth.{accessToken, refreshToken, expiresAt}`). **Read-only; store only a fingerprint, never the raw token** (hermes `credential_persistence.py:151-174`). This avoids DorkOS becoming a second copy of a subscription token it has no business owning — which is both a hygiene win _and_ the ToS-defensible posture.
3. DorkOS-owned credential (API key, keyring-backed).
4. `ANTHROPIC_API_KEY`.

**4. Storage: keyring-first with a 0o600 fallback, behind a `SecretRef`.** Use omnigent's two-tier model (`keyring` → 0o600 JSON fallback; `keychain:`/`env:` refs). The fallback store lives under `~/.dork/` (via `lib/dork-home.ts`) at 0o600 — keeping plaintext out of conf-managed `~/.dork/config.json`. Store MCP-OAuth tokens in a _separate_ file (opencode's `auth.json`/`mcp-auth.json` split).

**5. Auth UX — the bar to hit.** Render a **settings panel** in the React console (DorkOS has a real client; don't settle for terminal-only):

- A "connect" card per provider showing **source descriptor + subscription tier** (`Pro`/`Max`/`Team`/`Enterprise` — read from the host `.credentials.json`), mirroring omnigent's "connected as `keychain:anthropic`" that never echoes the secret.
- A method picker mirroring claude-code's three-tier mental model: **Use my Claude Code login (detected)** / **API key** / **Gateway or cloud provider** — with honest tradeoff copy ("API key bills per token; a Claude Pro/Max login is for your own use").
- A `/doctor`-style health check (claude-code's pattern) that surfaces "not logged in — run `claude login`" / keychain-locked hints rather than failing opaquely.
- **Do not** ship a claude.ai browser-OAuth button. If a self-hosting power user wants `setup-token`, gate it behind an "Advanced / self-host" disclosure with the ToS warning inline.

**6. MCP OAuth — adopt the convergent design** (MCP OAuth section above). Wrap `@modelcontextprotocol/sdk/client/auth`'s `OAuthClientProvider` (opencode pair as transplant); dedicated `mcp-oauth.json` 0o600 + lock keyed by SHA-256(name+url); Express-server loopback callback route with both redirect spellings + CSRF-state; absolute `expires_at` + ~30s proactive refresh; hermes's disk-watch + 401-dedup for multi-agent safety; first-class console status + paste-code fallback. This is orthogonal to the LLM-provider seam and reuses code that's already production-grade in opencode/codex.

**7. Don't over-build.** Skip a multi-provider HTTP stack (opencode's 22-adapter AI-SDK registry) — DorkOS delegates to the `claude` binary, which already speaks Anthropic + gateways via env vars. You need the **config + credential seam**, not a second HTTP client. Adopt the _shape_ of opencode's `Credential → Auth → Headers` orthogonality, not its provider count. Do not re-implement subscription browser OAuth (ToS + fragility).

**Net seam in one sentence:** a Zod `providers` config block (omnigent's kind-typed entries) + a `CredentialProvider` narrow port injected into `ClaudeCodeRuntime` at `message-sender.ts:282` (mirroring `RelayPort`/`SessionSettingsPort`) + a hermes-style read-host-Claude-first / borrowed-vs-owned resolution chain + omnigent's keyring-with-0o600-fallback `SecretRef` storage — where OpenRouter and Vercel AI Gateway fall out automatically as `protocol: 'openai-compatible', baseUrl, credentialRef`, and where the ToS line is enforced by _construction_ (no `subscription` authType; host-CLI tokens are read-only + fingerprinted).

---

## Open questions / follow-ups

1. **ToS re-verification.** [`research/anthropic-tos-compliance.md`](anthropic-tos-compliance.md) is dated 2026-02-15. Before shipping, confirm Anthropic's current stance on (a) reading the host `.credentials.json` read-only, and (b) `setup-token` for self-hosted single-operator use. The crackdown targeted _distributed products_ multiplexing subscription tokens; DorkOS's self-hosted posture is materially different, but the boundary is policy, not code.
2. **`subscriptionType` field stability.** Reading the host `.credentials.json` for the tier badge depends on an undocumented field that has had corruption/format fixes (claude-code 2.1.143). Treat it as best-effort display, never load-bearing.
3. **Linux/Windows Keychain reality.** No surveyed repo demonstrates Linux Secret-Service storage of _Claude_ creds in practice — the file tier is the cross-platform fallback everywhere. Confirm Claude Code's own non-macOS storage ("protected credentials file", claude-code 2.1.83) before relying on a keychain there.
4. **PKCE confirmation for claude-code's main flow** is impossible from outside (closed source; CHANGELOG never names PKCE). Not load-bearing for DorkOS since we won't re-drive it.
5. **Per-workspace credential scoping.** DorkOS's `WorkspaceManager` + `workspaceKey` make per-workspace providers feasible; how should resolution precedence interact with workspace binding, and where does the override live (session vs agent vs workspace)? Needs a design pass.
6. **Multi-account UX.** No surveyed tool ships a great interactive Claude account switcher (claude-code is single-account; codex isolates by `$CODEX_HOME`). If DorkOS needs personal-vs-org Claude accounts side by side, that's net-new design.
7. **Gateway credential-leak guard.** claude-code shipped a regression (2.1.153) where the user's Anthropic OAuth credential leaked to a custom gateway. If DorkOS adds `ANTHROPIC_BASE_URL` support, add an explicit test that a host-CLI/subscription credential is _never_ forwarded to a non-Anthropic `baseUrl`.
8. **Low-confidence items flagged:** Cursor was docs-only (no source); several "full MCP OAuth" claims delegate PKCE/DCR to an upstream SDK (verified the wrapper exists, not independent S256 construction); hermes/openclaw "subscription vs API-key coexistence" is resolved cleanly but still dispatches via `if provider == "anthropic"` branches, not polymorphism.
