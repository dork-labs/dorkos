---
slug: mcp-local-auth-posture
id: 260717-003523
created: 2026-07-16
status: specified
linearIssue: DOR-278
parent: DOR-272
---

# MCP local-auth posture: close the unauthenticated localhost surface

**Status:** Draft (frozen for DECOMPOSE)
**Author:** Rivest (SPECIFY stage, /flow drain)
**Date:** 2026-07-16
**Tracker:** DOR-278 (HIGH · posture · under the DOR-272 security umbrella)

## Overview

The external MCP endpoint (`/mcp`) and the A2A gateway (`/a2a`) share one auth
middleware, `mcpApiKeyAuth` (`apps/server/src/middleware/mcp-auth.ts`). Its
fourth and last branch is an **unconditional passthrough**: when no
`MCP_API_KEY` is set, no legacy config key lingers, and login is off (the
default), every request is allowed. On loopback that means any local process —
a sandboxed dependency, a malicious `postinstall`, a compromised package in
another project — can call **every** DorkOS MCP tool tokenlessly, including the
in-process code-execution trio (`create_extension`, `test_extension`,
`reload_extensions`) and the human-impersonating `relay_send` family, and can
drive **any** agent via A2A prompt execution.

This spec freezes the fix decided in ideation (Decisions §6): ship an
**auto-generated, per-instance local MCP token** (the Jupyter pattern), stored
`0600` under the dork home, and **delete the passthrough**. When login is off,
the token is required as `Authorization: Bearer` on every mutating call; the
one carve-out is tools annotated `readOnlyHint: true`, which stay tokenless so
health checks, introspection, and `curl` demos still work with no config. The
carve-out keys off `readOnlyHint` because it is the **only** annotation that
fails safe — an unannotated or mis-annotated tool is _not_ read-only, so it
lands on the guarded side by construction. A2A has no read/write annotation, so
its JSON-RPC execution surface is **always** token-gated (discovery cards stay
open). The token composes with ADR-0320: it exists only in login-off mode and
yields to per-user API keys the moment login is enabled.

The blast radius is transport-layer and additive. The cockpit SPA, DorkOS-driven
agents (in-process Claude Agent SDK path), and the Obsidian `DirectTransport`
path never touch HTTP `/mcp`, so nothing internal breaks. The only legitimate
HTTP `/mcp` callers are third-party MCP clients the operator deliberately
configures — already at a config step — so the DX cost is one pasted header.

## Background / Problem Statement

Verified against the codebase (2026-07-16):

- **The bug is `mcp-auth.ts:65-68`.** Four acceptors resolve auth first-wins:
  (1) `env.MCP_API_KEY` exact match, (2) a per-user Better Auth identity via
  `verifyRequestAuth`, (3) the legacy `config.mcp.apiKey` compat key, (4)
  `if (!envKey && !legacyKey && !authEnabled) { next(); }` — the passthrough.
  The constant-time compare (`constantTimeEquals`, `mcp-auth.ts:85-90`) was
  already fixed by the audit; only branch 4 is the posture hole.
- **One middleware, two surfaces.** `mcpApiKeyAuth` guards `/mcp`
  (`index.ts:806`), `/a2a` (`index.ts:1040`), and the fleet agent-card
  well-known GETs (`index.ts:1036-1037`). On `/mcp` the app-wide session gate
  401s unauthenticated requests _before_ this middleware when
  `config.auth.enabled` is true, so the tokenless path only exists in login-off
  mode. On `/a2a` there is no session gate — `mcpApiKeyAuth` is the sole auth,
  so the passthrough leaves A2A prompt execution against every agent open on
  loopback.
- **The middleware can see the tool being called.** The `/mcp` router calls
  `transport.handleRequest(req, res, req.body)` (`routes/mcp.ts:29`), and
  `express.json({ limit: '1mb' })` is mounted app-wide (`app.ts:105`) _before_
  the `/mcp` mount is added in `index.ts` (line 806, after `createApp()` at
  763). So `req.body` — the parsed JSON-RPC message — is available inside
  `mcpApiKeyAuth`. This is what makes the per-tool carve-out possible at the
  Express layer without dropping into the MCP dispatch.
- **The stateless transport gives one JSON-RPC message per POST.** The server
  runs stateless (`sessionIdGenerator: undefined`, `routes/mcp.ts:26`); each
  POST is a standalone call (or a JSON-RPC batch array), so a per-request method
  peek is sufficient — there is no cross-request session to track.
- **`readOnlyHint` is a reliable, already-reviewed signal.** Every tool is
  registered via `server.registerTool(name, { annotations }, handler)` with a
  preset from `ToolAnnotationPresets` (`services/core/mcp-tool-metadata.ts`).
  The two presets that carry `readOnlyHint: true` are `readOnlyLocal` and
  `readOnlyOpenWorld`; the other five carry `readOnlyHint: false`. The audit in
  §"readOnlyHint audit" confirms all 48 registrations are already correct for
  the carve-out — no mutating/RCE tool is mis-marked read-only.
- **The 0600-token-file precedent already exists.** `services/core/auth/secret.ts`
  resolves the Better Auth signing secret with exactly the pattern this token
  needs (env override → read persisted `0600` file → generate + persist `0600`,
  with a lax-permission repair pass). DOR-242 established it; ADR-0315 and
  `CREDENTIAL_REF_PATTERN` (`config-schema.ts:29`) codify the rule that raw
  secrets live in files, never in `config.json`. The local token follows this
  precedent — it is **not** a new Zod config field.

## Operator Decisions (LOCKED)

Pinned before specifying; not reopened here (ideation Decisions §6 + the
rollout fork §7, resolved on the issue).

1. **Default-on, per-instance local MCP token (Jupyter-style).** Auto-generated,
   stored `0600` under the dork home, required as `Authorization: Bearer` on
   `/mcp` **and** `/a2a` whenever login is off. The zero-config passthrough
   branch is **deleted**.
2. **Capability split keyed off `readOnlyHint: true` only.** Read-only tools
   work tokenless; every other tool (mutating / destructive / RCE) requires the
   token. Fail-closed: a tool without the hint is gated.
3. **Hard 401 cut — no warn-then-enforce** (ideation §7, resolved). Pre-launch
   alpha carries near-zero migration debt; a warn-then-enforce release would
   double the work and ship a known hole for a cycle. Error responses must be
   helpful: state exactly where the token lives and how to add it to an MCP
   client config.
4. **Token surfaces in the existing Server settings tab** as ready-to-paste MCP
   client config. Composes with ADR-0320: the token is active only in login-off
   mode; per-user keys take over when login is on.
5. **Keep the marketplace confirmation gate.** It is orthogonal (UX consent, not
   auth) and stays unchanged.

## Goals

- Delete the passthrough (`mcp-auth.ts:63-68`); a request in login-off mode is
  either token-authenticated or restricted to the read-only carve-out.
- Resolve a per-instance local token from a `0600` dork-home file, mirroring
  `secret.ts` (env override → persisted file → generate + persist), read once at
  boot.
- Gate every non-read-only `/mcp` `tools/call` and every `/a2a` JSON-RPC
  execution behind a valid token in login-off mode; keep read-only tools,
  discovery/handshake methods, and A2A card discovery tokenless.
- Add `READ_ONLY_MCP_TOOL_NAMES` as the single source of truth for the carve-out,
  guarded by a drift test that cross-checks it against the live server's
  `tools/list` annotations.
- Helpful 401 bodies (JSON-RPC shape for `/mcp`, A2A error shape for `/a2a`) that
  name the token's file path and show how to add the header.
- Surface the token in the Server settings tab: display, copy-to-config, and a
  rotate action; honest states for the env-override and login-on modes where the
  local token does not apply.
- Preserve zero code impact on the cockpit SPA, DorkOS-driven agents, and the
  Obsidian embedded path.

## Non-Goals

- **Network / tunnel bind changes.** The exposure guard (`exposure-guard.ts`,
  `process.exit(1)` on a non-loopback bind without an owner) and the independent
  A2A exposure check (`checkA2aExposure`, `index.ts:994`) own network exposure.
  This spec changes only who may reach the loopback port.
- **Login-on flows and per-user API keys** (ADR-0320). This fills the login-off
  gap 0320 left; it does not touch the session gate, the Better Auth `apiKey`
  plugin, or the owner-account model.
- **Marketplace confirmation redesign.** `TokenConfirmationProvider` and the
  out-of-band approval flow stay exactly as they are (Decision 5).
- **Sandboxing extension / plugin code.** This gates _who can reach_ the RCE
  tools, not _what those tools may do_.
- **The relay `canInitiate` bypass (DOR-277)** and **marketplace symlink /
  integrity (DOR-279)** — sibling issues under the same umbrella.
- **Retiring the legacy `config.mcp.apiKey`** — acceptor 3 stays as the
  self-retiring compat window; `seedLegacyMcpApiKey` already folds it into a
  Better Auth key.

## Technical Dependencies

- No new external dependencies. `randomBytes` (`node:crypto`) and `fs` for the
  token file, exactly as `secret.ts` uses them.
- `@modelcontextprotocol/sdk` — the middleware reads the parsed JSON-RPC `method`
  / `params.name` off `req.body`; the drift test reads `tools/list` annotations
  off a live `createExternalMcpServer` instance.
- `lib/dork-home.ts` `resolveDorkHome()` — the token file path is
  `<dorkHome>/mcp-local-token`. `os.homedir()` is banned (Hard Rule 3); the
  resolver takes `dorkHome: string` like `resolveBetterAuthSecret(dorkHome)`.

## Detailed Design

### 1. The local token substrate — `services/core/auth/mcp-local-token.ts` (new)

A near-clone of `secret.ts`, resolving the per-instance MCP token:

```ts
/** File name of the persisted local MCP token under the dork home (0600). */
const TOKEN_FILE_NAME = 'mcp-local-token';
/** Owner-only file mode (rw-------). */
const TOKEN_FILE_MODE = 0o600;
/** 32 random bytes → 64 hex chars, prefixed for provenance in client configs. */
const TOKEN_PREFIX = 'dork_mcp_local_';

/**
 * Resolve this instance's local MCP token. Never throws for the missing-token
 * case — it generates and persists one. Precedence:
 *   1. `env.MCP_API_KEY` — when set, that env override IS the bearer clients use
 *      (existing acceptor 1); the local-token file is neither read nor written.
 *   2. A persisted `<dorkHome>/mcp-local-token` file — read (and permission-
 *      repaired) if it exists, so the token is stable across restarts.
 *   3. A freshly generated `dork_mcp_local_<hex>` — written 0600 and returned.
 *
 * Only meaningful in login-off mode; per ADR-0320 the token is inactive when
 * `config.auth.enabled` is true.
 *
 * @param dorkHome - Resolved DorkOS data directory (`resolveDorkHome()`).
 */
export function resolveMcpLocalToken(dorkHome: string): string | null;

/** Regenerate the token file (rotation), returning the new value. */
export function rotateMcpLocalToken(dorkHome: string): string;
```

- **Generation timing:** resolved once during server startup (in the boot
  sequence in `index.ts`, alongside `initAuth` / `seedLegacyMcpApiKey`) **only
  when login is off and `MCP_API_KEY` is unset**. When `MCP_API_KEY` is set,
  the env key is the bearer and the file is not created (env wins, like
  `secret.ts`). The resolved value is held in a module-level accessor (e.g.
  `getMcpLocalToken()`) so the middleware compares against it without a per-
  request file read. Rotation clears and re-reads that cache.
- **Format:** `dork_mcp_local_` + 32 random bytes hex (64 chars). The prefix is
  self-describing and greppable in a client config, and distinguishes it from
  the legacy global `dork_mcp_*` key and per-user Better Auth keys.
- **Permissions:** written `0600`, re-`chmod` after write (umask defense), and a
  `repairTokenPermissions` pass on read that tightens a lax-permission file back
  to `0600` and warns — copied verbatim in shape from `secret.ts:124-142`. No-op
  on Windows.
- **Never logged:** only the file path is logged, never the value.

### 2. Config schema — NO persisted-config change (decision, with rationale)

The token is a generated secret, so per the `secret.ts` precedent, ADR-0315
("never persist plaintext"), and `CREDENTIAL_REF_PATTERN` (which keeps raw
secrets out of `config.json`), it lives in a `0600` file — **not** a
`UserConfigSchema` field. Therefore:

- **`packages/shared/src/config-schema.ts` (`UserConfigSchema`) is unchanged.**
  No new field, and **no semver-keyed `conf` migration** — the schema-change
  path in `contributing/configuration.md` does not apply because no persisted
  field is added, renamed, retyped, or removed. (`mcp.enabled`,
  `mcp.apiKey`, `mcp.rateLimit` all stay as-is.)
- The ideation's mention of a "new local-token field or file" resolves to the
  **file** side of that either/or, matching the codebase's own secret-handling
  rule. This is called out explicitly so DECOMPOSE does not scaffold a phantom
  migration.

What _does_ change is the **`ServerConfig` API response DTO** (`schemas.ts`,
§4 below) — that is an OpenAPI response shape, regenerated with `pnpm`'s
openapi step, not a `conf` migration.

### 3. Middleware rewrite — `mcp-auth.ts` becomes a small factory

`mcpApiKeyAuth` becomes `createMcpAuth({ surface })` where `surface ∈
{'mcp','a2a'}`, so the `/mcp` mount gets the read-only carve-out and the `/a2a`
mount gets the execution-always-gated rule. Common acceptors run first on both.

**Common acceptors (any surface, any method) — allow on first match:**

1. `env.MCP_API_KEY` exact match (constant-time) — unchanged acceptor 1.
2. `verifyRequestAuth(req)` identity (per-user key / session) — unchanged
   acceptor 2; the login-on path.
3. Legacy `config.mcp.apiKey` exact match (constant-time) — unchanged acceptor 3.
4. **NEW:** local token exact match (constant-time) against `getMcpLocalToken()`,
   **only when login is off** — replaces the deleted passthrough.

**If no acceptor matched:**

- **Login ON (`config.auth.enabled === true`):** 401. There is no tokenless
  path when login is on (on `/mcp` the session gate has usually already 401'd;
  on `/a2a` this middleware is the gate). The local token is never consulted.
- **Login OFF, `surface: 'mcp'`:** apply the **capability carve-out** by peeking
  `req.body`:
  - Discovery / handshake method → allow.
  - `tools/call` whose `params.name ∈ READ_ONLY_MCP_TOOL_NAMES` → allow.
  - `tools/call` on any other (or unknown) tool → 401.
  - Any other method (`resources/read`, `prompts/get`, `completion/*`, unknown)
    → 401. **Fail-closed.**
  - JSON-RPC **batch** (array body) → allow only if **every** element is
    independently allowed; any mutating or unrecognized element → 401 for the
    whole batch.
  - Unparseable / missing body → 401.
- **Login OFF, `surface: 'a2a'`:** every A2A JSON-RPC POST is prompt execution
  and has no read/write distinction, so **execution is always token-gated**:
  - `GET` (agent-card discovery — well-known + per-agent card) → allow
    (rate-limited public metadata, the analogue of `tools/list`).
  - `POST` (JSON-RPC RPC) → 401.

### The middleware logic table (compact)

| Login | Surface | Request                                                                                                                             | Valid token?        | Result    |
| ----- | ------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------- | --------- |
| off   | mcp     | discovery/handshake (`initialize`,`ping`,`tools/list`,`resources/list`,`resources/templates/list`,`prompts/list`,`notifications/*`) | —                   | **allow** |
| off   | mcp     | `tools/call`, tool ∈ read-only set                                                                                                  | no                  | **allow** |
| off   | mcp     | `tools/call`, tool ∉ read-only set (mutating/RCE/unknown)                                                                           | no                  | **401**   |
| off   | mcp     | `resources/read`, `prompts/get`, `completion/*`, unknown method                                                                     | no                  | **401**   |
| off   | mcp     | batch with any mutating/unknown element                                                                                             | no                  | **401**   |
| off   | mcp     | any of the above                                                                                                                    | **yes**             | **allow** |
| off   | a2a     | agent-card `GET` (discovery)                                                                                                        | —                   | **allow** |
| off   | a2a     | JSON-RPC `POST` (execution)                                                                                                         | no                  | **401**   |
| off   | a2a     | JSON-RPC `POST` (execution)                                                                                                         | **yes**             | **allow** |
| on    | mcp/a2a | anything                                                                                                                            | no identity         | **401**   |
| on    | mcp/a2a | anything                                                                                                                            | env/user/legacy key | **allow** |

"Valid token" = acceptor 1, 3, or 4 match (env override, legacy key, or local
token). In login-on mode only acceptors 1–3 apply (the local token is inactive).

### The read-only carve-out SSOT — `READ_ONLY_MCP_TOOL_NAMES`

A `ReadonlySet<string>` of exactly the 23 read-only tool names, exported from a
new `services/core/external-mcp/tool-security.ts` (co-located with the tool
registrations, importable by the middleware). The middleware treats any name
**not** in the set as gated — an added tool defaults to guarded (fail-closed).

A **drift-guard test** instantiates `createExternalMcpServer` (with mock
`McpToolDeps` + marketplace deps), issues a `tools/list` over an in-memory
transport, and asserts `READ_ONLY_MCP_TOOL_NAMES` equals exactly the set of
tools whose returned `annotations.readOnlyHint === true` — both directions, so
the constant can never silently drift from the annotations it mirrors.

### Helpful 401 bodies (Decision 3)

The 401 must tell the operator where the token is and how to use it. `/mcp`
keeps the JSON-RPC error shape; `/a2a` uses its error shape. Message copy
(`writing-for-humans`), e.g.:

> `Unauthorized. This DorkOS tool needs your local MCP token. Find it in`
> `Settings → Server → External MCP, or in <dorkHome>/mcp-local-token, and`
> `send it as "Authorization: Bearer <token>".`

The message names the **path**, not the token value (never log/echo the secret
in an error). The path is the resolved dork-home path.

### 4. Config DTO + client Server settings tab

**Server DTO (`apps/server/src/routes/config.ts:162-183` + `schemas.ts:2190`):**

- Extend `authSource` from `'env' | 'user-keys' | 'none'` to add
  `'local-token'`. In login-off mode with no `MCP_API_KEY`, `authSource` is now
  `'local-token'` (the passthrough's `'none'` disappears — the surface is always
  gated). `'none'` remains only as the degenerate can't-generate fallback.
- Add an optional `localToken: string | null` to the `mcp` DTO, populated **only
  when `authSource === 'local-token'`** (i.e. login off, no env key), so the
  settings tab can render a ready-to-paste block. This is the deliberate Jupyter
  move: in login-off mode `/api/config` is already loopback-only under the same
  trust boundary, and the token has no meaning once login is on (it is never
  emitted then). `authConfigured` is `true` for `'local-token'`.
- `mcp.apiKey` / the token value stays in `SENSITIVE_CONFIG_KEYS` behavior — the
  local token is only ever emitted through this purpose-built field, never
  through a generic config dump.

**Server rotate route (`routes/config.ts` or a small `routes/mcp-config.ts`):**
`POST /api/config/mcp/rotate-token` — calls `rotateMcpLocalToken(dorkHome)`,
refreshes the cached value, returns `{ localToken }`. Thin handler; 409/400 when
login is on or `MCP_API_KEY` is set (the local token does not apply there).

\*\*Client — `ExternalMcpCard` (`.../settings/ui/external-mcp/ExternalMcpCard.tsx`

- `external-mcp-snippets.ts`):\*\*

* `McpAuthRow` gains a `'local-token'` branch: show a `KeyRound` "Local MCP
  token" row with the token in a copy field, a **Copy** button, and a **Rotate**
  button (confirm — rotating breaks existing configured clients until they are
  re-pasted). Below it, the per-client paste-ready block from `buildSnippets`.
* `buildSnippets(endpoint, apiKey)` is called with the real `localToken` (today
  it is passed `null`, `ExternalMcpCard.tsx:125`), so the `Authorization: Bearer
<token>` header is pre-filled instead of the `dork_mcp_YOUR_API_KEY`
  placeholder. Update the placeholder comment/fallback to reference the local
  token path when no token is available.
* Honest states:
  - `authSource === 'env'`: keep the existing "Environment variable" badge — the
    local token does not apply; clients use `MCP_API_KEY`.
  - `authSource === 'user-keys'` (login on): keep the existing "personal API key"
    guidance — the local token does not apply; no token is shown.
  - `authSource === 'local-token'`: show the token + snippets + rotate.
  - `authConfigured` false only in the degenerate `'none'` fallback → an honest
    "couldn't generate a local token" note (should not occur in normal boot).
* The header status badge: `'local-token'` reads as **Enabled** (green) — the
  surface is gated. Only the degenerate `'none'` shows the amber "No auth".

## API / data model changes

- **New file:** `services/core/auth/mcp-local-token.ts` (`resolveMcpLocalToken`,
  `rotateMcpLocalToken`, `getMcpLocalToken`) + `0600` token file at
  `<dorkHome>/mcp-local-token`.
- **New file:** `services/core/external-mcp/tool-security.ts`
  (`READ_ONLY_MCP_TOOL_NAMES`).
- **Changed:** `middleware/mcp-auth.ts` — `createMcpAuth({ surface })` factory,
  passthrough deleted, local-token acceptor + carve-out added; wired at the
  `/mcp`, `/a2a`, and card mounts in `index.ts` with the right `surface`.
- **Changed:** `routes/config.ts` + `schemas.ts` `ServerConfig.mcp` — `authSource`
  gains `'local-token'`, new `localToken` field; OpenAPI regenerated.
- **New route:** `POST /api/config/mcp/rotate-token`.
- **Changed:** `ExternalMcpCard.tsx`, `external-mcp-snippets.ts` (+ barrel/types).
- **No `UserConfigSchema` change, no `conf` migration, no SQLite change.**

## User Experience

- **Third-party MCP client (Claude Code / Cursor / Codex), login off:** the
  operator opens Settings → Server → External MCP, copies the pre-filled config
  block (URL + `Authorization: Bearer dork_mcp_local_…`), pastes it once. Tools
  work. A tokenless `curl` health probe (`ping`, `get_server_info`,
  `tools/list`) still works with no header.
- **Tokenless mutating call, login off:** a `create_extension` or `relay_send`
  with no header gets a 401 that names the token file and the header to add — a
  helpful dead-end, not a silent success.
- **Rotate:** clicking Rotate (with a confirm) issues a fresh token; the
  displayed block updates; previously configured clients 401 until re-pasted —
  the confirm copy says so plainly.
- **Login on:** the local-token row disappears; the card shows the existing
  "personal API key" guidance (ADR-0320). No behavior change for env-override
  deployments.
- **Cockpit, DorkOS agents, Obsidian:** unchanged — none call HTTP `/mcp`.

## readOnlyHint audit (the carve-out's integrity depends on it)

All 48 externally-registered tools were read at source and classified by their
`ToolAnnotationPresets` value. `readOnlyLocal` and `readOnlyOpenWorld` carry
`readOnlyHint: true`; the other five presets carry `readOnlyHint: false`.

**Result: 23 read-only (tokenless), 25 guarded. Zero mis-annotations in the
security-critical direction — no mutating/destructive/RCE tool is marked
read-only. The carve-out is sound with the current annotations; NO hint fixes
are required in scope.**

**Read-only (`readOnlyHint: true`) — 23, tokenless:** `ping`, `get_server_info`,
`get_session_count`, `get_agent` (core); `tasks_list`, `tasks_get_run_history`
(tasks); `binding_list`; `get_extension_api`, `list_extensions`,
`get_extension_errors` (agent-extension); `mesh_list`, `mesh_status`,
`mesh_inspect`, `mesh_query_topology` (mesh); `relay_list_endpoints`,
`relay_list_adapters`, `relay_get_trace`, `relay_get_metrics` (relay);
`marketplace_search`, `marketplace_get`, `marketplace_recommend`,
`marketplace_list_marketplaces`, `marketplace_list_installed` (marketplace).

**Guarded (`readOnlyHint: false`) — 25, token required:** `tasks_create`,
`tasks_update`, `tasks_delete`; `binding_create`, `binding_delete`;
`create_agent`, `create_extension`, `reload_extensions`, `test_extension`;
`mesh_discover`, `mesh_register`, `mesh_deny`, `mesh_unregister`; `relay_send`,
`relay_inbox`, `relay_register_endpoint`, `relay_send_and_wait`,
`relay_send_async`, `relay_unregister_endpoint`, `relay_enable_adapter`,
`relay_disable_adapter`, `relay_reload_adapters`; `marketplace_install`,
`marketplace_uninstall`, `marketplace_create_package`.

**Judgment calls verified correct (all already carry the right hint):**

- `relay_inbox` → `mutateUpdateLocal` (guarded). Correct: `ack:true` marks
  messages read (`relay-tools.ts:108`). A naïve "inbox = read" would have leaked
  it; it does not.
- `mesh_discover` → `mutateUpdateLocal` (guarded). Correct: auto-imports found
  `.dork/agent.json` as a scan side effect (`mesh-tools.ts:58-59`). Guarded.
- `create_extension` / `test_extension` / `reload_extensions` → `mutateCreate/
UpdateLocal` (guarded). Correct: these compile + execute code in-process — the
  sharpest un-gated RCE edge today — and are now token-gated.
- `marketplace_search` / `marketplace_get` / `marketplace_recommend` →
  `readOnlyOpenWorld` (**tokenless**). Accepted residual: they fetch from
  _operator-configured_ marketplace sources and may refresh a local cache, but
  they are genuinely read-only for the caller and expose nothing beyond what the
  operator already trusts. Leaving them tokenless honors Decision 2 and keeps
  tokenless search working; the fetch target set is operator-controlled, so
  there is no open SSRF surface. No change.

Because the annotations are already correct, the work here is to **lock** that
correctness with `READ_ONLY_MCP_TOOL_NAMES` + the drift test, not to re-annotate.

## Security Considerations

- **Threat closed:** a local non-operator process (sandboxed dep, malicious
  `postinstall`, socket-only reach) can no longer call mutating/RCE MCP tools or
  drive agents over A2A on loopback without the `0600` token it cannot read.
- **Residual, accepted:** read-only tools and MCP discovery/handshake stay
  tokenless (Decision 2) — a local process can still probe health and list tools.
  `resources/read` (session/agent/skill `dorkos://` data) is **gated**
  (fail-closed on data reads), a deliberate tightening beyond the tool decision
  since transcripts can hold sensitive content.
- **Token exposure:** the token is emitted only through the purpose-built
  login-off `localToken` DTO field over loopback (same trust boundary as the
  cockpit); it is never emitted in login-on mode, never logged, and stored
  `0600` with a lax-permission repair pass.
- **Fail-closed by construction:** unknown tools, unknown methods, unparseable
  bodies, and mixed batches all require the token. A new tool defaults to
  guarded.
- **No downgrade of ADR-0320:** the token is inactive when login is on; this is
  not a return of a global key on exposure (the exposure guard still governs
  network binds).

## Documentation (flag demo-claim-gate wording)

- **`docs/` self-hosting / MCP integration pages** (whichever documents adding
  the DorkOS MCP to an external client): add the one-time `Authorization: Bearer`
  header step and where to find the token (Settings → Server, or the
  `mcp-local-token` file). Follow `writing-for-humans`.
- **A2A docs:** note that A2A JSON-RPC now needs the same token in login-off
  mode. Do **not** assert Mesh+Relay / A2A works end-to-end — it is behind the
  demo-claim gate (AGENTS.md); document the auth requirement, not a working
  multi-agent demo.
- **Changelog fragment** (`changelog/unreleased/`, timestamp-id + slug): a
  breaking-change note — external MCP/A2A clients now need the local token in
  login-off mode; where to find it; hard cut (no grace period).
- **Draft ADR** (see Related ADRs) capturing the posture decision.

## Testing Strategy

Transport-layer only — `FakeAgentRuntime` is **untouched** (no `AgentRuntime`
method changes).

**Unit — token substrate (`services/core/auth/__tests__/mcp-local-token.test.ts`):**
mirror `secret.test.ts` — env override wins; persisted file is read stably;
first boot generates + persists `0600`; lax permissions are repaired to `0600`;
`rotateMcpLocalToken` writes a new value; the value is never returned when login
is on. Assert the `dork_mcp_local_` prefix + hex length.

**Unit — middleware matrix (`middleware/__tests__/mcp-auth.test.ts`, extend):**
drive the full table — for `surface: 'mcp'` login-off: discovery methods allow
tokenless; a read-only `tools/call` allows tokenless; a mutating `tools/call`
401s tokenless and allows with the token; `resources/read` / unknown method
401s tokenless; a mixed batch 401s; each acceptor (env, legacy, local token)
allows. For `surface: 'a2a'` login-off: `GET` allows, `POST` 401s tokenless /
allows with token. Login-on: no tokenless path on either surface. Use the
existing `createMockReq/Res` + `mockConfig` harness; add `req.body` and
`req.method` to the mock.

**Unit — carve-out drift guard (`services/core/external-mcp/__tests__/
tool-security.test.ts`):** build `createExternalMcpServer` with mock deps +
marketplace deps, `tools/list` over an in-memory transport, assert
`READ_ONLY_MCP_TOOL_NAMES` equals exactly `{ tools with readOnlyHint === true }`
(both directions) — the guarantee that the constant can't drift.

\*\*Integration — end-to-end auth (`middleware/__tests__/mcp-auth.integration.test.ts`

- `routes/__tests__/mcp-integration.test.ts`, extend):\*\* through the real
  `/mcp` mount with the live auth wired: a tokenless read-only call succeeds; a
  tokenless mutating call 401s with the helpful body; the same call with the
  local token succeeds. This is the existing MCP test harness — no new harness.

**Route — rotate + DTO (`routes/__tests__/config-mcp.test.ts`, extend):**
`authSource` is `'local-token'` in login-off mode; `localToken` is present then
and absent under env-key / login-on; `POST /api/config/mcp/rotate-token` returns
a new token and 409s when login is on or `MCP_API_KEY` is set.

**Client — `ExternalMcpCard` (`.../settings/__tests__/ExternalMcpCard.test.tsx`,
extend):** the `'local-token'` branch renders the token, Copy, and Rotate; the
snippet embeds the real token; env / user-keys branches hide the token and show
the existing guidance; the degenerate `'none'` shows the honest fallback.
Snippet shape unit-tested in `external-mcp-snippets` (token vs placeholder).

Each test carries a purpose comment; no always-pass tests.

## Implementation Phases

- **Phase 1 — token substrate:** `mcp-local-token.ts` (resolve / rotate / cached
  accessor) + boot wiring in `index.ts`; unit tests. Compiles standalone.
- **Phase 2 — middleware + carve-out SSOT:** `tool-security.ts`
  (`READ_ONLY_MCP_TOOL_NAMES`) + drift test; `createMcpAuth({ surface })` with
  the passthrough deleted, local-token acceptor, carve-out, helpful 401s;
  re-wire `/mcp`, `/a2a`, card mounts in `index.ts`; middleware matrix +
  integration tests.
- **Phase 3 — config DTO + client:** `authSource` `'local-token'` + `localToken`
  field in `config.ts` + `schemas.ts` (OpenAPI regen); rotate route;
  `ExternalMcpCard` + `external-mcp-snippets` changes + honest states; route +
  client tests.
- **Phase 4 — docs + changelog + ADR:** docs pages, changelog fragment
  (breaking-change), draft ADR; demo-claim-gate wording check.

## Acceptance Criteria

- [ ] The passthrough branch (`mcp-auth.ts:63-68`) is deleted; no request path
      reaches `next()` without a token or the read-only carve-out in login-off
      mode.
- [ ] A per-instance `dork_mcp_local_<hex>` token is generated `0600` at
      `<dorkHome>/mcp-local-token` on first boot (login off, no `MCP_API_KEY`),
      stable across restarts, permission-repaired on read.
- [ ] Login-off `/mcp`: a mutating/RCE `tools/call` (e.g. `create_extension`,
      `relay_send`) 401s tokenless and succeeds with the token; a read-only
      `tools/call` and the discovery methods succeed tokenless; `resources/read`
      and unknown methods 401 tokenless; a mixed batch 401s.
- [ ] Login-off `/a2a`: a JSON-RPC `POST` 401s tokenless and succeeds with the
      token; an agent-card `GET` succeeds tokenless.
- [ ] Every acceptor works: `MCP_API_KEY`, legacy `config.mcp.apiKey`, and the
      local token each authorize a mutating call.
- [ ] Login on: neither surface has a tokenless path; the local token is
      inactive; per-user keys / env key authorize (ADR-0320 unchanged).
- [ ] The 401 body names the token file path and the `Authorization: Bearer`
      header; it never echoes the token value.
- [ ] `READ_ONLY_MCP_TOOL_NAMES` equals exactly the 23 tools with
      `readOnlyHint === true`, enforced by the drift-guard test against
      `tools/list`.
- [ ] Server settings tab (login off) shows the token, a Copy button, a
      pre-filled paste-ready client config, and a Rotate action (with a
      breaks-existing-clients confirm); env / login-on modes hide it honestly.
- [ ] `UserConfigSchema` is unchanged and no `conf` migration ships (the token
      is a file); OpenAPI reflects the `ServerConfig.mcp` DTO additions.
- [ ] Docs updated (self-hosting / MCP + A2A auth step); changelog fragment
      records the breaking hard-cut; `FakeAgentRuntime` untouched.

## Open Questions

All resolved — the direction is fully pinned by the LOCKED operator decisions
and the code verification.

- ~~**Rollout — hard cut vs warn-then-enforce** (ideation §7).~~ **(RESOLVED —
  LOCKED Decision 3.)** Hard 401 cut, no grace period. Rationale: pre-launch
  alpha carries near-zero migration debt; the only HTTP `/mcp` callers are
  deliberately-configured third-party clients already at a config step; a
  warn-then-enforce release would ship a known hole for a cycle and double the
  work.
- ~~**Where does the token live — config field or file?**~~ **(RESOLVED.)** A
  `0600` dork-home file, per the `secret.ts` precedent, ADR-0315, and
  `CREDENTIAL_REF_PATTERN`. No `UserConfigSchema` field, no `conf` migration.
- ~~**Is A2A "always token-gated"?**~~ **(RESOLVED — refined from the code.)**
  A2A JSON-RPC execution is always token-gated in login-off mode (no read/write
  annotation to carve on — every RPC executes a prompt); agent-card `GET`
  discovery stays tokenless (rate-limited public metadata, the `tools/list`
  analogue).
- ~~**Do read-only _resources_ stay tokenless like read-only tools?**~~
  **(RESOLVED.)** No — `resources/read` (session/agent/skill data) is gated
  (fail-closed on data reads), a deliberate tightening beyond the tool decision.
  Discovery (`resources/list`) stays open.

No floor-level blockers remain.

## Related ADRs

- **ADR-0320** (optional-by-default login, per-user keys) — this fills the
  login-off gap 0320 left; the token is inactive once login is on. Not a return
  of the global `dork_mcp_*` key on exposure.
- **ADR-0103** (optional `MCP_API_KEY`) — the posture decision supersedes the
  zero-config passthrough branch of 0103's model; `MCP_API_KEY` stays as the
  headless override (acceptor 1).
- **ADR-0227** (middleware-gated MCP toggle) — `requireMcpEnabled` + the
  always-mount / 503 pattern is unchanged; the auth middleware sits beside it.
- **ADR-0315** (CredentialProvider port, "never persist plaintext") — the reason
  the token is a `0600` file, not a config field.
- **ADR-0311** (Better Auth as single identity core) — the login-on identity
  path the local token yields to.
- **Proposed ADR (extract at `/adr:from-spec`):** _"Default-on local MCP token
  with a `readOnlyHint` capability carve-out"_ — the per-instance `0600` token,
  the fail-safe read-only carve-out keyed off `readOnlyHint`, the hard-cut
  rollout, and A2A execution always-gated. Supersedes ADR-0103's passthrough
  branch and extends ADR-0320's login-off path.

## References

- DOR-278 (issue) — HIGH posture, DOR-272 umbrella.
- `specs/mcp-local-auth-posture/01-ideation.md` — ideation, decisions, blast-radius inventory.
- `apps/server/src/middleware/mcp-auth.ts:63-68` — the passthrough (deleted).
- `apps/server/src/services/core/auth/secret.ts` — the `0600`-token-file precedent.
- `apps/server/src/routes/mcp.ts:29` + `apps/server/src/app.ts:105` — `req.body` availability.
- `apps/server/src/services/core/mcp-tool-metadata.ts` — the annotation presets.
- `apps/server/src/services/core/external-mcp/*.ts` + `services/marketplace-mcp/marketplace-mcp-tools.ts` — the 48 tool registrations audited.
- `apps/server/src/index.ts:806,1036-1040` — `/mcp`, `/a2a`, and card mounts.
- `apps/server/src/routes/config.ts:162-183` + `packages/shared/src/schemas.ts:2190-2212` — the `ServerConfig.mcp` DTO.
- `apps/client/src/layers/features/settings/ui/external-mcp/ExternalMcpCard.tsx` + `.../lib/external-mcp-snippets.ts` — the settings surface.
- ADR-0320, ADR-0103, ADR-0227, ADR-0315, ADR-0311.
  </content>
  </invoke>
