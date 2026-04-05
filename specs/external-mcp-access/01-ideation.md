---
slug: external-mcp-access
number: 215
created: 2026-04-05
status: ideation
---

# External MCP Access Controls

**Slug:** external-mcp-access
**Author:** Claude Code
**Date:** 2026-04-05
**Branch:** preflight/external-mcp-access

---

## 1) Intent & Assumptions

- **Task brief:** Add visibility and control for the external MCP server (`/mcp`) to the Settings Tools tab. Users should be able to toggle external access on/off, manage API keys, see setup instructions for connecting external agents, configure rate limiting, and understand the duplicate-tool risk when running DorkOS agents that also connect externally.

- **Assumptions:**
  - The external MCP server already works (stateless Streamable HTTP at `/mcp`, ADR-0101/0102/0103)
  - All tools are always registered in the external server; feature-gated handlers return errors when their subsystem is disabled
  - The existing `configManager` (conf package) and `PATCH /api/config` API handle persistence and validation
  - API key will be stored in `config.json` (consistent with tunnel auth pattern), with env var as override
  - Hot toggle via middleware gate — no server restart required
  - Per-tool external filtering is out of scope (future spec)

- **Out of scope:**
  - Per-tool filtering for external MCP clients (`allowedExternalTools` config)
  - MCP protocol changes (Streamable HTTP transport works as-is)
  - External agent session management (server is stateless by design)
  - OAuth 2.1 flow (appropriate for public servers, not local/self-hosted)

## 2) Pre-reading Log

- `apps/server/src/services/core/mcp-server.ts`: External MCP server factory, registers 41 tools across 9 domains. Uses `@modelcontextprotocol/sdk` McpServer class. All tools always registered, feature-gated at handler level.
- `apps/server/src/routes/mcp.ts`: Stateless route — each POST creates fresh McpServer + StreamableHTTPServerTransport. GET/DELETE return 405.
- `apps/server/src/middleware/mcp-auth.ts`: Optional Bearer token auth. When `MCP_API_KEY` set, validates header; when unset, passes all requests.
- `apps/server/src/middleware/mcp-origin.ts`: DNS rebinding protection. Allows localhost origins + active tunnel URL. Non-browser clients (no Origin header) pass through.
- `apps/server/src/index.ts` (lines 284-312): MCP mounted only when ClaudeCodeRuntime available. Logs auth mode. Same `mcpToolDeps` shared with internal SDK path.
- `apps/server/src/env.ts` (line 24): `MCP_API_KEY: z.string().optional()` — only MCP-related env var.
- `packages/shared/src/config-schema.ts`: No `mcp` section currently. Tunnel section stores sensitive auth data in config already.
- `apps/server/src/services/runtimes/claude-code/tool-filter.ts`: Tool filtering uses `allowedTools` array in SDK `query()` call. Does NOT apply to external MCP server.
- `apps/server/src/services/runtimes/claude-code/message-sender.ts` (line 238): Internal tools prefixed as `mcp__dorkos__<tool>`. External MCP tools get prefixed by the client (e.g., `mcp__dorkos__<tool>` if the user names their server "dorkos" in `.mcp.json`).
- `apps/client/src/layers/features/settings/ui/ToolsTab.tsx`: Recently redesigned — 5 tool group rows (Core, Tasks, Relay, Mesh, Adapter) with toggles, tool count badges, init errors, override counts. Tasks group is expandable with scheduler config.
- `apps/client/src/layers/features/settings/ui/ServerTab.tsx`: Already shows MCP endpoint URL as a ConfigRow. Click-to-copy pattern.
- `apps/client/src/layers/features/settings/ui/TunnelDialog.tsx`: State machine for tunnel setup — landing, setup, connecting, connected, error. Good pattern reference for security-sensitive configuration.
- `packages/relay/src/rate-limiter.ts`: Per-sender sliding window rate limiter for Relay messages. Domain-specific, not reusable for HTTP rate limiting.
- `research/20260309_mcp_server_express_embedding.md`: Comprehensive research on MCP server architecture, transport options, auth patterns.
- `research/mcp-tool-injection-patterns.md`: Internal vs external tool injection patterns.
- `research/20260405_external_mcp_access_controls.md`: Fresh research on duplicate tool collision, enable/disable patterns, API key UX, setup instructions.
- `decisions/` ADR-0101 (MCP server in Express), ADR-0102 (stateless transport), ADR-0103 (optional API key auth).

## 3) Codebase Map

**Primary components/modules:**

- `apps/server/src/services/core/mcp-server.ts` — External MCP server factory (will need: enabled check passthrough)
- `apps/server/src/routes/mcp.ts` — Route handler (will need: rate limiting middleware)
- `apps/server/src/middleware/mcp-auth.ts` — Auth middleware (will need: read API key from config, not just env var)
- `apps/server/src/index.ts` — Mount point (will need: always mount, let middleware gate)
- `packages/shared/src/config-schema.ts` — Config schema (will need: `mcp` section)
- `apps/server/src/routes/config.ts` — Config API (will need: expose MCP status)
- `packages/shared/src/schemas.ts` — ServerConfig schema (will need: `mcp` section in response)
- `apps/client/src/layers/features/settings/ui/ToolsTab.tsx` — Tools tab (will need: External MCP Access section)

**Shared dependencies:**

- `apps/server/src/services/core/config-manager.ts` — Config persistence (conf package)
- `packages/shared/src/config-schema.ts` — Zod validation for all config
- `@modelcontextprotocol/sdk` — MCP server implementation
- `express-rate-limit` — New dependency for HTTP rate limiting

**Data flow:**

1. User toggles MCP enabled/API key in ToolsTab → `transport.updateConfig()` → `PATCH /api/config` → `configManager.set()` → persisted to `~/.dork/config.json`
2. External MCP request → `validateMcpOrigin` → `requireMcpEnabled` (new) → `mcpApiKeyAuth` (updated) → `rateLimitMcp` (new) → `createMcpRouter`
3. Config API response → `GET /api/config` returns `mcp: { enabled, authConfigured, endpoint, rateLimit }` → ToolsTab displays status

**Feature flags/config:**

- New: `mcp.enabled` (boolean, default: true)
- New: `mcp.apiKey` (string | null, default: null)
- New: `mcp.rateLimit` (object: { enabled, maxPerWindow, windowSecs })
- Existing: `MCP_API_KEY` env var (overrides config apiKey when set)

**Potential blast radius:**

- Direct: 8 files (config schema, server config route, mcp route, mcp auth middleware, new mcp enabled middleware, ServerConfig schema, ToolsTab, package.json)
- Indirect: ServerTab (currently shows MCP endpoint — may want to link to Tools tab)
- Tests: mcp-auth tests, config route tests, ToolsTab tests (none exist yet but should be added)

## 4) Root Cause Analysis

Not applicable — this is a feature, not a bug fix.

## 5) Research

### Potential Solutions

**1. Middleware-gated hot toggle with config-stored API key**

- Description: Add `mcp` section to config schema. New `requireMcpEnabled` middleware checks `configManager.get('mcp')?.enabled` on each request. Auth middleware reads API key from config (with env var override). `express-rate-limit` middleware added to `/mcp` mount.
- Pros:
  - No server restart needed for any MCP config change
  - Consistent with existing tunnel auth pattern (sensitive data in config.json)
  - `express-rate-limit` is battle-tested (18M+ weekly npm downloads)
  - Config-driven means UI can show/change everything
- Cons:
  - API key in plaintext in `~/.dork/config.json` (mitigated: local-only server, same as tunnel authtoken)
  - Per-request config read (mitigated: configManager uses in-memory cache)
- Complexity: Medium
- Maintenance: Low

**2. Environment-variable-only auth with restart-based toggle**

- Description: Keep `MCP_API_KEY` as env-var only. Add `mcp.enabled` to config but conditionally mount route at startup.
- Pros:
  - No plaintext key in config file
  - Truly unmounts route when disabled
- Cons:
  - Requires server restart to toggle
  - Can't manage API key from UI
  - Inconsistent with tunnel auth pattern
- Complexity: Low
- Maintenance: Low

### Critical Research Finding: Duplicate Tool Collision

The Anthropic API returns **HTTP 400 `"Tool names must be unique"`** when the same DorkOS MCP tools appear from both:

1. Internal SDK injection (tools prefixed as `mcp__dorkos__<tool>`)
2. External MCP connection configured in Claude Code's `.mcp.json` (tools prefixed as `mcp__<server-name>__<tool>`)

If the user names their server "dorkos" in `.mcp.json`, the prefixes collide exactly. Even with different names, the SDK may encounter issues during compaction and subagent spawning.

**Sources:** GitHub issues #2093, #32549, #14111, #10704 on anthropics/claude-code.

**Mitigation strategy (three layers):**

1. **Setup UI warning**: Clear documentation that external MCP is for agents running OUTSIDE DorkOS, not for DorkOS-managed agents
2. **Instructions clarity**: Setup snippets use a distinct server name (e.g., `dorkos-external`) to avoid prefix collision
3. **Future**: Startup detection scan of `.mcp.json` in the working directory (deferred — out of scope for this feature)

### Security Considerations

- API key stored with `0600` permissions on config file (conf package default)
- Rate limiting critical when tunnel is active (exposes `/mcp` to internet)
- Origin validation already blocks DNS rebinding attacks
- Bearer token auth is the MCP standard for pre-shared secrets
- Add `mcp.apiKey` to `SENSITIVE_CONFIG_KEYS` for PATCH warning

### Recommendation

**Recommended Approach:** Solution 1 — Middleware-gated hot toggle with config-stored API key.

**Rationale:** Consistent with the tunnel auth pattern already in the codebase. Hot toggle provides instant feedback in the UI. Config storage enables full API key lifecycle management from Settings without requiring shell access.

## 6) Decisions

| #   | Decision                  | Choice                                                                                                                                            | Rationale                                                                                                                        |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | API key storage           | Config.json (with env var override)                                                                                                               | Consistent with tunnel auth pattern. Enables full UI management. Local-only server mitigates plaintext risk.                     |
| 2   | Enable/disable mechanism  | Hot toggle via middleware gate                                                                                                                    | No restart needed. Matches relay/tasks feature flag pattern. Instant UI feedback.                                                |
| 3   | Rate limiting library     | `express-rate-limit` (new dependency)                                                                                                             | Battle-tested (18M+ downloads), Express-native, minimal footprint. Existing relay rate limiter is domain-specific, not reusable. |
| 4   | Scope                     | Items 1-8: toggle, API key, instructions, endpoint URL, auth status, duplicate warning, per-client tabs, rate limiting. Defer per-tool filtering. | Per-tool filtering (Windsurf-style allowedExternalTools) is a meaningful feature deserving its own spec.                         |
| 5   | TanStack Pacer            | Not applicable                                                                                                                                    | Pacer is client-side throttling for React. MCP rate limiting is server-side HTTP protection. Different concern entirely.         |
| 6   | Duplicate tool mitigation | Warning in UI + distinct server name in setup snippets                                                                                            | Hard API failure (400) when tools collide. Three-layer mitigation: UI warning, instructions clarity, future startup detection.   |
| 7   | Documentation             | Add to `docs/` (Fumadocs) alongside UI instructions                                                                                               | Per-client setup instructions should live in both the ToolsTab (inline) and the external docs site.                              |
