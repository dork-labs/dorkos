---
slug: connect-claude-code-account
number: 260
created: 2026-06-25
status: ideation
---

# Connect Your Claude Code Account — Runtime Credential Authentication

**Slug:** connect-claude-code-account
**Author:** Dorian
**Date:** 2026-06-25

> **Stage:** IDEATE (`/flow`). Next stage is SPECIFY (`/flow:specify`) — **but
> gated**: per Decision #2, no SPECIFY/DECOMPOSE/EXECUTE work proceeds until the
> blocking ToS re-verification (the first sub-issue) clears.

> **Tracker:** Linear project **Connect Claude Code Account** · umbrella **DOR-157**
> (this work) · **blocked by DOR-158** (re-verify Anthropic ToS — gates all
> execution). DorkOS team (key `DOR`). All tracker I/O routes through the
> `linear-adapter` skill.

---

## 1) Intent & Assumptions

- **Task brief:** Let DorkOS users _authenticate the agent runtime's LLM
  provider_ instead of relying purely on ambient host credentials. The headline
  is "connect your Claude Code account"; the seam generalizes to other providers
  (API key, gateway) and to MCP-server OAuth. DorkOS today injects **no** auth —
  every session rides whatever `claude login` the host already did
  (`message-sender.ts:282-287` spreads `process.env` wholesale). That is fine for
  one operator on one machine and breaks the moment you want a connected-account
  UX, an org key vs a personal subscription, a gateway, or per-workspace creds.

- **Assumptions:**
  - DorkOS uses the official **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk@0.3.177`)
    and delegates to the host `claude` binary via `pathToClaudeCodeExecutable`.
    The SDK exposes **no** third-party `login()`; auth is env/credential-driven;
    `query().accountInfo()` returns `{ email, subscriptionType, apiProvider, … }`
    for status display.
  - Persistent config is `~/.dork/config.json` via `conf` + a Zod `UserConfigSchema`
    with semver-keyed migrations (the `adding-config-fields` lifecycle applies).
  - The React console exists (FSD layers); `WorkspaceManager` + `workspaceKey`
    exist; `lib/dork-home.ts` is the single source of truth for `~/.dork`.
  - All Claude SDK contact is confined to `services/runtimes/claude-code/`
    (ESLint-enforced, ADR-0089).

- **Out of scope (hard lines):**
  - Re-implementing a **claude.ai browser-OAuth** flow — ToS-prohibited for
    distributed products; excluded **by construction** (no `subscription`
    authType in the schema).
  - **Distributing / multiplexing subscription OAuth tokens** (`CLAUDE_CODE_OAUTH_TOKEN`)
    — the exact pattern Anthropic blocked (OpenCode/Cline/Roo/aider, Jan-2026).
    A self-host single-operator `setup-token` escape hatch may be reconsidered in
    SPECIFY, behind a ToS warning, but is not a marketed path.
  - A full multi-provider **HTTP client stack** (e.g. opencode's 22-adapter AI-SDK
    registry) — DorkOS delegates to the `claude` binary, which already speaks
    Anthropic + gateways via env vars. We need the **config + credential seam**,
    not a second HTTP client.

## 2) Pre-reading Log

- `research/20260625_agent_auth_patterns_meta_harnesses.md` — **primary fuel.**
  Source-level audit of 10 harnesses (Hermes, OpenClaw, Paperclip, omnigent,
  ruflo, oh-my-hermes, OpenCode, Codex, crush, claude-code). Conclusions:
  delegate-to-host is the only ToS-safe Claude path; provider-registry +
  credential-port is the convergent architecture; MCP OAuth is a separate
  reusable subsystem; full recommendation + 7-step plan + DorkOS seam.
- `research/anthropic-tos-compliance.md` (dated **2026-02-15**) — **the gating
  constraint.** Anthropic blocked third-party tools for multiplexing Claude Max
  subscription OAuth tokens. **Must be re-verified before any execution (Decision #2).**
- `apps/server/src/services/runtimes/claude-code/messaging/message-sender.ts:282-287`
  — the env seam where a `CredentialProvider` injects (verified by source read).
- `packages/shared/src/agent-runtime.ts` — narrow-port precedent
  (`AgentRegistryPort` `:49`, `RelayPort` `:65`, `SessionSettingsPort` `:75`).
- `packages/shared/src/config-schema.ts` — `UserConfigSchema`; **no `providers`
  block today**; `SENSITIVE_CONFIG_KEYS` would extend.

## 3) Codebase Map

- **Primary components/modules:**
  - `ClaudeCodeRuntime` env seam — `…/claude-code/messaging/message-sender.ts:282-287`
    (the single behavior-change point; merge resolved `env`/`baseUrl` here).
  - `UserConfigSchema` + `ConfigManager` (`apps/server/src/services/core/config-manager.ts`,
    `conf` v15.1.0, `z.toJSONSchema` bridge, semver migrations).
  - `AgentRuntime` interface + ports (`packages/shared/src/agent-runtime.ts`) — add a
    `CredentialProvider` narrow port alongside the existing three.
  - `lib/dork-home.ts` — `~/.dork` location for any fallback secret/MCP-token store.
  - `WorkspaceManager` + `workspaceKey` — the future per-workspace scoping hook.
  - MCP client connection path (for the MCP-OAuth subsystem) — wrap
    `@modelcontextprotocol/sdk/client/auth` `OAuthClientProvider`.
- **Shared dependencies:** `conf`, Zod (`z.toJSONSchema`), `@modelcontextprotocol/sdk`,
  the Claude Agent SDK (confined).
- **Data flow:** `~/.dork/config.json` → `ConfigManager` → runtime → `CredentialProvider.resolve(providerId)`
  → merged `env`/`baseUrl` into the SDK subprocess at the `message-sender.ts` seam.
- **Feature flags/config:** new `providers` block in `UserConfigSchema`;
  `SENSITIVE_CONFIG_KEYS` extension; conf migration keyed to the next config semver.
- **Potential blast radius:** the SDK-confinement ESLint boundary; config migration
  (every `~/.dork/config.json` on upgrade); client settings UI (FSD layer placement);
  the MCP client connection lifecycle; security review (credential handling).

## 5) Research

(Full detail in `research/20260625_agent_auth_patterns_meta_harnesses.md` — summarized.)

- **Four candidate Claude-auth approaches & ToS posture:** (1) shell-out / inherit
  host login → **safest**, adopt as default; (2) `setup-token` →
  `CLAUDE_CODE_OAUTH_TOKEN` → **risky** (the blocked pattern), self-host escape
  hatch only; (3) **API key** (`ANTHROPIC_API_KEY`) → **fully compliant**,
  recommended explicit option; (4) **gateway** (`ANTHROPIC_BASE_URL` +
  `ANTHROPIC_AUTH_TOKEN` / Bedrock / Vertex) → compliant, enterprise.
- **Host Claude credential contract** (agreed by 3 independent impls): macOS
  Keychain service `"Claude Code-credentials"` → file `~/.claude/.credentials.json`
  → `claudeAiOauth.{accessToken, refreshToken, expiresAt}`. **Read-only;
  fingerprint, never copy** (hermes "borrowed-vs-owned").
- **Convergent architecture:** provider = _data_ (a registry of kind-typed
  entries), credentials = _references_ (`keychain:`/`env:`/`file:`, never inline),
  auth strategy = a discriminated union. OpenRouter & Vercel AI Gateway are just
  `baseURL + apiKey` on an OpenAI-compatible adapter — not new auth strategies.
- **MCP server OAuth** is a separate, near-verbatim-reusable subsystem (opencode's
  `oauth-provider.ts`/`oauth-callback.ts` pair is the closest TS transplant):
  wrap the SDK's `OAuthClientProvider`, dedicated `mcp-oauth.json` (0o600, keyed by
  SHA-256(name+url)), loopback callback (send both `127.0.0.1` and `localhost`
  spellings), CSRF-state, absolute `expires_at` + proactive refresh, cross-process
  file-lock + disk-watch (DorkOS is multi-agent).

- **Recommendation:** keep delegating to the host `claude` binary (compliant base);
  build outward — a Zod `providers` block (no `subscription` authType) + a
  `CredentialProvider` narrow port at `message-sender.ts:282` + a
  read-host-login-first / borrowed-vs-owned resolution chain + keyring-with-0o600-fallback
  `SecretRef` storage. OpenRouter/Vercel fall out as `protocol:'openai-compatible',
baseUrl, credentialRef`. MCP OAuth is orthogonal and reuses production-grade code.

## 6) Decisions

| #   | Decision                | Choice                                                                                                    | Rationale                                                                                                                                 |
| --- | ----------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | v1 scope                | **Full** — host-login detection + API key + gateway + MCP server OAuth + UX                               | User chose full scope. Realized as a **Linear project with phased sub-issues**, not a single task — too large for one slice.              |
| 2   | ToS prerequisite gating | **Block all work** until Anthropic's current ToS stance is re-verified                                    | User chose the hard gate (safest). A blocking ToS re-verification issue precedes SPECIFY/DECOMPOSE/EXECUTE; everything is `blockedBy` it. |
| 3   | Credential scoping      | **Global** (UserConfig) for v1; seam designed so per-workspace can be added later                         | Matches today's single-operator-per-host model; `WorkspaceManager`/`workspaceKey` extension deferred to avoid upfront complexity.         |
| 4   | Primary auth surface    | **Both** — backend credential seam **and** a React settings panel in v1                                   | DorkOS has a real client; the quality bar wants a crafted connect-account UX, not config-only.                                            |
| 5   | Claude auth mechanism   | Detect/inherit host login (read-only, fingerprinted) + API key + gateway; **never** claude.ai OAuth       | ToS-safe; corroborated by 3 independent implementations in the research.                                                                  |
| 6   | Architecture seam       | Zod `providers` block (no `subscription` authType) + `CredentialProvider` port at `message-sender.ts:282` | Excludes the ToS-risky path **by construction**; mirrors the existing `AgentRegistryPort`/`RelayPort`/`SessionSettingsPort` narrow ports. |

## 7) Open Questions (carry into SPECIFY)

1. **ToS re-verification outcome (the gate, Decision #2)** — confirm Anthropic's
   current stance on (a) read-only host-`.credentials.json` access and (b) any
   `setup-token` self-host use. Blocks everything.
2. **`subscriptionType` field stability** for the tier badge — undocumented field
   with prior format fixes; treat as best-effort display, never load-bearing.
3. **Linux/Windows keychain reality** for Claude creds — file tier is the
   cross-platform fallback; confirm non-macOS storage before relying on a keyring.
4. **Gateway credential-leak guard** — add a test that a host/subscription
   credential is **never** forwarded to a non-Anthropic `baseUrl` (claude-code
   shipped exactly this regression in 2.1.153).
5. **Per-workspace resolution precedence** — when per-workspace lands, where does
   the override live (session vs agent vs workspace) and how does it rank?
6. **Multi-account UX** (personal vs org Claude side by side) — net-new; no
   surveyed tool ships a great Claude account switcher.

## 8) Recommended Next Step

**Resolve the blocking ToS re-verification issue FIRST.** Per Decision #2, hold
SPECIFY / DECOMPOSE / EXECUTE until it clears. Once unblocked, run `/flow:specify`
on this slug to produce `02-specification.md` (the seam design + phased sub-issue
breakdown: ① host-login detection + status, ② API key, ③ gateway, ④ MCP-server
OAuth subsystem, ⑤ React settings-panel UX), then `/flow:decompose`.

**Durable context for any later pickup:** this file + `research/20260625_agent_auth_patterns_meta_harnesses.md`

- the Linear project/umbrella issue (links back here) are ground truth. The model
  is amnesiac by design — resume from these artifacts, not from chat history.
