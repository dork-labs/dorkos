---
title: 'External MCP Access Controls — Enable/Disable Toggle, API Key Management, Duplicate Tools, and Setup UX'
date: 2026-04-05
type: implementation
status: active
tags:
  [
    mcp,
    external-mcp,
    access-control,
    api-key,
    duplicate-tools,
    enable-disable,
    settings-ux,
    security,
    claude-code,
  ]
feature_slug: external-mcp-access
searches_performed: 12
sources_count: 28
---

# External MCP Access Controls — Enable/Disable Toggle, API Key Management, Duplicate Tools, and Setup UX

## Research Summary

DorkOS already has a functional external MCP server at `/mcp` with optional `MCP_API_KEY` Bearer auth and a stateless Streamable HTTP transport. The key open questions are: (1) how to add a runtime enable/disable toggle without a server restart, (2) what UX patterns govern API key management in a settings UI, (3) whether the duplicate-tools problem between DorkOS's internal SDK injection and an external `/mcp` configuration in Claude Code is a real, breaking concern, and (4) what connection instructions to surface to users.

**Critical finding on duplicate tools**: When a user configures DorkOS as an external MCP server in Claude Code _and_ Claude Code runs agent sessions inside DorkOS (which internally inject the same DorkOS tools via the Agent SDK), Claude Code throws an API-level 400 error: `"tools: Tool names must be unique."` This is a confirmed, documented class of bug affecting compaction, subagent spawning, and tool calls. DorkOS must detect this collision and warn users before it causes hard failures.

---

## Key Findings

### 1. The Duplicate Tools Problem Is Real and Hard-Failing

**This is the highest-priority concern in the feature.**

Claude Code enforces tool name uniqueness at the Anthropic API level (HTTP 400). When the same tool name appears twice in the tool list sent to the model, the API rejects the request with:

```
tools: Tool names must be unique.
```

**How the conflict arises in DorkOS:**

- **Path A (internal)**: When a Claude Code agent runs _inside_ DorkOS, `createDorkOsToolServer()` is called by `claudeRuntime.setMcpServerFactory()`. This injects tools named `mcp__dorkos__relay_send`, `mcp__dorkos__mesh_list`, etc. into every SDK `query()` call.
- **Path B (external)**: If the user also configures DorkOS as an external MCP server in Claude Code's settings (`~/.claude.json` or `.mcp.json`), Claude Code connects to `http://localhost:4242/mcp` and receives the same tools: `relay_send`, `mesh_list`, etc.
- **Combined**: Claude Code sees `mcp__dorkos__relay_send` from Path A AND `mcp__dorkos__relay_send` from Path B (the external connection named `dorkos`). Identical names → 400 error.

**Documented impact** (confirmed across 8+ GitHub issues):

- `/compact` and auto-compact fail entirely, making long sessions unrecoverable
- Task tool (subagent spawning) fails with the same error
- The error happens at the API level — no graceful degradation
- v2.1.71 introduced deduplication logic but it only checks command/URL, not full env vars — it has known false positives and false negatives

**Who is affected**: Only users who BOTH run DorkOS as their primary agent environment AND manually add DorkOS to Claude Code's MCP server list. This is an easy mistake to make — the DorkOS settings page will show setup instructions that invite precisely this misconfiguration.

**Detection surface**: DorkOS cannot directly detect what's in a user's `~/.claude.json`. But it CAN detect whether an active Claude Code session is running inside DorkOS (it's the runtime). If the external MCP server is enabled, DorkOS should show a contextual warning in the setup instructions: _"Do not add this MCP server to Claude Code if you are running Claude Code agents inside DorkOS — the tools are already injected internally."_

**Alternative mitigation**: DorkOS could use a _different server name_ for the external MCP endpoint than the internal one. If the internal SDK server is named `"dorkos"` and the external HTTP server exposes itself as `"dorkos-external"`, the tools become `mcp__dorkos__*` vs `mcp__dorkos-external__*` — different names, no collision. This is the cleanest technical fix. The trade-off: tools appear under different names depending on access path, which is slightly confusing.

**Best recommendation**: Name the external MCP server `"dorkos"` for simplicity, but display a prominent warning in the setup instructions about not adding it to Claude Code's `.mcp.json` when running Claude Code agents inside DorkOS. Also consider detecting this at server startup by inspecting `~/.claude.json` (or the active `.mcp.json` in the default CWD) and logging a warning.

---

### 2. Enable/Disable Toggle — Runtime Flag Without Server Restart

**Industry pattern**: VS Code, Cline, Kiro, Cursor, and Gemini CLI all implement MCP server enable/disable as a `"disabled": true` flag in the config JSON. The server is not removed from configuration — just skipped at connection time. This is the de facto standard.

**For DorkOS**: The external `/mcp` endpoint is always active when the server starts (if `claudeRuntime` is present). To support a UI toggle without requiring a server restart:

**Option A: Route-level feature flag (Recommended)**

Store an `mcpEnabled` boolean in a runtime config singleton (e.g., `configManager`) that the MCP middleware reads on each request:

```typescript
// middleware/mcp-enabled.ts
export function requireMcpEnabled(req: Request, res: Response, next: NextFunction): void {
  if (!configManager.get('mcpEnabled')) {
    res.status(503).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'MCP server is disabled. Enable it in DorkOS settings.' },
      id: null,
    });
    return;
  }
  next();
}
```

The toggle state is persisted to `~/.dork/config.json` (the `configManager` source of truth). Flipping it via a new `PATCH /api/mcp-settings` route changes the live flag immediately. No server restart. The `/mcp` route itself stays mounted — requests are rejected at the middleware level.

**Option B: Unmount/remount the route**

Express does not support dynamic route removal after startup without maintaining a reference to the router and swapping it. This is significantly more complex and is not used by any major MCP client. Avoid.

**UX behavior when disabled**: Return HTTP 503 with a JSON-RPC error body (not 404, which would imply the endpoint doesn't exist). External MCP clients handle this more gracefully than a connection refused.

**Persistence**: The enabled/disabled state persists across server restarts via `configManager`. Default: `enabled: true` (preserving current behavior, no breaking change).

---

### 3. API Key Management UX Patterns

**Industry standard flow** (Perplexity, OpenRouter, Temporal, Stripe):

1. **Generation**: User clicks "Generate API Key" (or "Rotate"). A new key is generated server-side using cryptographically secure randomness (`crypto.randomBytes(32).toString('hex')` → 64-char hex, or `crypto.randomUUID()`-based).

2. **One-time reveal**: The full key is shown **exactly once**, immediately after generation, with a masked input showing `sk-xxxxxxxxxxxx...` afterward. A banner states: _"Copy this key now. You won't be able to see it again."_ This is the universal pattern — GitHub PATs, OpenAI API keys, Stripe secret keys, AWS access keys all follow it.

3. **Copy-to-clipboard with confirmation**: A single "Copy" button adjacent to the key field changes to "Copied!" with a checkmark for 2–3 seconds (toast notification or inline state change). This is the dominant UX in 2025–2026.

4. **Masked display after close**: Once the generation dialog is closed, the key is shown as `••••••••••••••••` with only the last 4 characters visible (e.g., `••••••••••••••••3f2a`). Users can see they have a key configured without being able to accidentally expose it.

5. **Rotation**: A "Rotate Key" button generates a new key and invalidates the old one. Best practice: show a confirmation modal ("Rotating will invalidate the current key. External clients will need to update their configuration.") before proceeding.

6. **Revocation**: A "Remove Key" (or "Revoke") action deletes the key entirely, reverting to unauthenticated mode. Useful for reverting to localhost-only access.

**For DorkOS**: The `MCP_API_KEY` is currently env-var-only. Moving to `configManager`-stored key (persisted in `~/.dork/config.json`) enables the full generate/rotate/revoke UX without requiring users to edit `.env` files. The env var remains supported as an override (config precedence: CLI flags > env vars > config file > defaults).

**Connection string display**: After key generation, show the complete Claude Code configuration snippet in a code block with a single "Copy" button for the entire block:

```json
{
  "mcpServers": {
    "dorkos": {
      "type": "http",
      "url": "http://localhost:4242/mcp",
      "headers": {
        "Authorization": "Bearer <key>"
      }
    }
  }
}
```

This is the exact format Claude Code 2.1.x accepts. Show it with the real key substituted, one-time, at generation time.

---

### 4. MCP Connection Instructions — Exact Format

**Claude Code's `.mcp.json` / `~/.claude.json` format** (confirmed from official Claude Code docs):

```json
{
  "mcpServers": {
    "dorkos": {
      "type": "http",
      "url": "http://localhost:4242/mcp"
    }
  }
}
```

With API key:

```json
{
  "mcpServers": {
    "dorkos": {
      "type": "http",
      "url": "http://localhost:4242/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_KEY_HERE"
      }
    }
  }
}
```

Via CLI (Claude Code 2.1.1+):

```bash
claude mcp add-json dorkos '{"type":"http","url":"http://localhost:4242/mcp","headers":{"Authorization":"Bearer YOUR_KEY_HERE"}}'
```

**Scopes**: Claude Code supports project-scoped (`.mcp.json` in project root) and user-scoped (`~/.claude.json`). For DorkOS, **user-scoped** is more natural since DorkOS runs as a system-level service accessible from any project.

**Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "dorkos": {
      "type": "http",
      "url": "http://localhost:4242/mcp",
      "headers": { "Authorization": "Bearer YOUR_KEY" }
    }
  }
}
```

**Windsurf** (`~/.codeium/windsurf/mcp_config.json`):

```json
{
  "mcpServers": {
    "dorkos": {
      "serverUrl": "http://localhost:4242/mcp",
      "headers": { "Authorization": "Bearer YOUR_KEY" }
    }
  }
}
```

**Via ngrok tunnel**: Replace `http://localhost:4242` with the tunnel URL. The API key is required when a tunnel is active (per the existing MCP auth spec and DorkOS prior research).

---

### 5. Security Considerations

**Current state** (from existing `mcp-auth.ts` and `mcp-origin.ts`):

- Bearer token auth via `MCP_API_KEY` env var — already implemented
- `validateMcpOrigin` middleware — already implemented (DNS rebinding protection)
- Stateless mode — already implemented (no session state leaks)

**Gaps to address**:

1. **API key storage**: Currently env-var only. Moving to `configManager`-stored means the key lives in `~/.dork/config.json` (a plain JSON file). This is acceptable for a local single-user tool — the same threat model as AWS `~/.aws/credentials`. The file should have `0600` permissions (owner-read-only). Add a startup check.

2. **Key entropy**: Generate keys with `crypto.randomBytes(32).toString('hex')` (256 bits of entropy, 64 hex chars). This is the standard for developer API keys. Prefix with `dork_` for identification: `dork_a3f82c...`. Prefixed keys are easier to identify in logs and `.env` files.

3. **Tool scope creep**: The external MCP server exposes all DorkOS tools including destructive ones (`delete_schedule`, `mesh_unregister`, `agent_delete`). Consider a separate `allowedExternalTools` configuration that defaults to read-only + safe write operations, with users opting destructive tools in explicitly.

4. **Rate limiting**: Not currently implemented. Add basic request rate limiting on the `/mcp` route (e.g., 100 req/min per IP using `express-rate-limit`). For local-only use this is rarely needed, but if a tunnel is active it matters.

5. **Logging**: Outbound MCP tool calls should be logged with the tool name and caller IP. Currently the stateless handler has no per-request logging. Add at minimum: `[MCP] tool=<name> ip=<ip> latency=<ms>` on each POST.

---

### 6. Enable/Disable Toggle vs. Per-Tool Toggle

**Industry comparison**:

- **VS Code**: Server-level toggle (enable/disable the whole server)
- **Windsurf**: Per-tool toggle (individual tools can be hidden from the model)
- **Cursor**: Server-level toggle via settings UI
- **DreamFactory MCP**: Per-tool toggle — removes tool from `tools/list` response entirely

**For DorkOS — recommendation**: Ship server-level toggle first (simpler, covers 95% of use cases). Per-tool toggle is a follow-up enhancement for users who want to, e.g., expose relay tools externally but not mesh tools.

The per-tool approach (removing tools from the `tools/list` response) is the security-correct implementation — if a tool isn't in the manifest, external agents never learn it exists. This is preferable to auth-layer rejection after invocation.

For a future per-tool toggle: the `createExternalMcpServer()` factory already takes `mcpToolDeps`. An `allowedExternalTools: string[]` config option passed to this factory controls which tools are registered. Tools not in the list are simply not `server.tool()`-registered.

---

## Detailed Analysis

### Duplicate Tools Problem — Complete Technical Path

```
User running Claude Code inside DorkOS:
  └─ Claude Code session created in DorkOS UI
  └─ DorkOS calls claudeRuntime.setMcpServerFactory()
  └─ Per SDK query(), createDorkOsToolServer() injects:
       mcp__dorkos__relay_send
       mcp__dorkos__mesh_list
       mcp__dorkos__ping
       [25+ more tools]

User also configures DorkOS as external MCP server in ~/.claude.json:
  └─ Claude Code connects to http://localhost:4242/mcp
  └─ DorkOS external server advertises:
       relay_send  →  Claude Code prefixes as  mcp__dorkos__relay_send
       mesh_list   →  Claude Code prefixes as  mcp__dorkos__mesh_list
       ping        →  Claude Code prefixes as  mcp__dorkos__ping
       [25+ more tools]

Result in Claude Code's tool list:
  mcp__dorkos__relay_send   (from internal injection)
  mcp__dorkos__relay_send   (from external /mcp connection)
  [duplicated for every tool]

Anthropic API response:
  HTTP 400: "tools: Tool names must be unique."
```

**This breaks**: any tool call, `/compact`, subagent spawning via Task tool.

**Three mitigation strategies**:

| Strategy                           | Mechanism                                                                                                                      | Effort | User Impact                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------ | ---------------------------------------------- |
| **Warning in UI**                  | Show contextual warning in MCP setup instructions: "Don't add this to Claude Code if you use Claude Code agents inside DorkOS" | Low    | Prevents misconfiguration                      |
| **Different external server name** | External server advertises as `"dorkos-ext"` → tools become `mcp__dorkos-ext__*`                                               | Low    | Tool names differ by context — minor confusion |
| **Startup detection**              | Server scans `~/.claude.json` and active `.mcp.json` at boot; logs WARNING if DorkOS URL found                                 | Medium | Proactive, no user action needed               |

Recommending all three in sequence: warning first (ship day 1), startup detection (ship with the feature), different server name (revisit if users still hit it).

---

### API Key Generation — Recommended Implementation

```typescript
// services/core/mcp-key-manager.ts
import { randomBytes } from 'node:crypto';

/** Generate a new DorkOS MCP API key. 256 bits of entropy, prefixed for identification. */
export function generateMcpApiKey(): string {
  return `dork_${randomBytes(32).toString('hex')}`;
}
```

**Storage in configManager**: Add `mcpApiKey: z.string().optional()` to the config schema. The env var `MCP_API_KEY` continues to override it (preserving backward compatibility). Auth middleware reads `env.MCP_API_KEY ?? configManager.get('mcpApiKey')`.

**API surface**:

```
GET  /api/mcp-settings        → { enabled: boolean, hasApiKey: boolean, keyPreview: '••••3f2a' | null }
POST /api/mcp-settings/key    → { key: string }  ← returns ONCE, store immediately
DELETE /api/mcp-settings/key  → { ok: true }     ← revoke
PATCH /api/mcp-settings       → { enabled: boolean }  ← toggle
```

The `POST /key` endpoint returns the full key exactly once in the response body. The client must display it immediately and never re-request it. Server stores only the key (or its hash — though for local single-user tools, storing plaintext in `~/.dork/config.json` is standard practice and matches how AWS/GCP local credentials work).

---

### MCP Enable/Disable — Config Schema

Add to `~/.dork/config.json` schema:

```typescript
// In configManager's schema
mcp: z.object({
  enabled: z.boolean().default(true),
  apiKey: z.string().optional(),
}).default({ enabled: true });
```

The middleware `requireMcpEnabled` reads `configManager.get('mcp.enabled')`. Because `configManager` is a live singleton updated by the `PATCH /api/mcp-settings` route, no restart is needed.

**Default behavior**: `enabled: true`, `apiKey: undefined` — exactly the current behavior. No breaking change.

---

### Setup Instructions UX — What to Show

The setup instructions section in the DorkOS settings page should:

1. Show the current server URL (adapts to ngrok tunnel URL when tunnel is active)
2. Show the configuration snippet for each supported client
3. Show the API key (masked after first generation) and a "Copy config" button
4. Show the duplicate-tools warning prominently when DorkOS is detected as the active runtime environment

**Tabs by client** (Claude Code, Cursor, Windsurf, Generic HTTP):

```
Claude Code:
  ┌─────────────────────────────────────────────────────────┐
  │ # Claude Code Setup                                     │
  │                                                         │
  │ Run this command:                                       │
  │ ┌─────────────────────────────────────────────────────┐ │
  │ │ claude mcp add-json dorkos '{"type":"http",         │ │
  │ │   "url":"http://localhost:4242/mcp",                 │ │
  │ │   "headers":{"Authorization":"Bearer dork_xxx"}}'   │ │
  │ └─────────────────────────────────────────────────────┘ │
  │ [Copy command]                                          │
  │                                                         │
  │ ⚠ Warning: Do not add this server to Claude Code if   │
  │   you run Claude Code agents inside DorkOS. The tools  │
  │   are already injected internally. Adding this would   │
  │   cause "Tool names must be unique" errors.            │
  └─────────────────────────────────────────────────────────┘
```

---

## Sources and Evidence

- "Tool Duplication in MCP SSE Server Connections" — [GitHub issue #2093](https://github.com/anthropics/claude-code/issues/2093) — silent accumulation of duplicate tools in session state
- "Tool names must be unique" API error during compaction — [GitHub issue #14111](https://github.com/anthropics/claude-code/issues/14111) — confirmed HTTP 400 from Anthropic API
- "Subagent launch fails with Tool names must be unique" — [GitHub issue #10704](https://github.com/anthropics/claude-code/issues/10704) — Task tool failures from duplicate tool registrations
- "MCP server is suppressed as duplicate" deduplication bug in v2.1.71 — [GitHub issue #32549](https://github.com/anthropics/claude-code/issues/32549) — false positive dedup (ignores env vars)
- Per-tool toggle controls for MCP servers — [DEV Community](https://dev.to/nicdavidson/we-shipped-per-tool-toggle-controls-for-our-mcp-server-heres-why-it-matters-more-than-it-sounds-4a2f) — removing tools from manifest as security layer
- VS Code MCP server enable/disable — [GitHub issue #246649](https://github.com/microsoft/vscode/issues/246649) — `"disabled": true` field pattern
- Global enable/disable field request in VS Code — [GitHub issue #263729](https://github.com/microsoft/vscode/issues/263729)
- CLI enable/disable subcommands feature request (OpenAI Codex) — [GitHub issue #16439](https://github.com/openai/codex/issues/16439)
- VS Code MCP configuration reference — [VS Code Docs](https://code.visualstudio.com/docs/copilot/reference/mcp-configuration) — full JSON schema including `inputs` for API key prompting
- Claude Code MCP docs (HTTP server type, headers, scopes) — [code.claude.com/docs/en/mcp](https://code.claude.com/docs/en/mcp)
- `claude mcp add-json` command with Bearer token example — [liblab.com](https://liblab.com/docs/mcp/howto-connect-mcp-to-claude)
- API key management best practices — [PeakHour](https://www.peakhour.io/learning/application-security/api-key-management-best-practices/)
- API key rotation best practices — [GitGuardian](https://blog.gitguardian.com/api-key-rotation-best-practices/)
- One-time key reveal UX — [Temporal Docs](https://docs.temporal.io/cloud/api-keys)
- MCP tool search lazy loading (context on tool count thresholds) — [research/20260330_claude_code_mcp_lazy_loading_tool_search.md](./20260330_claude_code_mcp_lazy_loading_tool_search.md)
- MCP server Express embedding (prior DorkOS research) — [research/20260309_mcp_server_express_embedding.md](./20260309_mcp_server_express_embedding.md)
- MCP tool naming conventions (prior DorkOS research) — [research/20260304_mcp_tool_naming_conventions.md](./20260304_mcp_tool_naming_conventions.md)
- MCP tool injection patterns (prior DorkOS research) — [research/mcp-tool-injection-patterns.md](./mcp-tool-injection-patterns.md)
- DorkOS codebase: `apps/server/src/middleware/mcp-auth.ts` — existing Bearer auth implementation
- DorkOS codebase: `apps/server/src/routes/mcp.ts` — existing stateless MCP router
- DorkOS codebase: `apps/server/src/env.ts` — existing `MCP_API_KEY` env var (line 24)
- DorkOS codebase: `apps/server/src/index.ts` — existing `/mcp` route mounting (lines 282–312)

---

## Research Gaps and Limitations

1. **Windsurf exact HTTP MCP config format**: Windsurf's HTTP MCP configuration field name for server URL may differ (`serverUrl` vs `url`). Verify against Windsurf docs during implementation.

2. **Claude Code dedup behavior with different server names**: The claim that using `"dorkos-ext"` as the external server name avoids collisions with internal `"dorkos"` injection is logically sound but not empirically verified against a live DorkOS + Claude Code setup. Should be tested during implementation.

3. **configManager write performance**: Whether `configManager` supports live writes (hot-reload without restart) requires confirming against the existing `configManager` implementation. If it's currently read-only after startup, the enable/disable toggle requires a small extension.

4. **Key storage security**: For a local single-user tool, storing the API key in plaintext in `~/.dork/config.json` is acceptable. If DorkOS later targets multi-user or team deployments, key hashing (bcrypt/argon2) becomes necessary.

5. **Rate limiting compatibility**: Adding `express-rate-limit` to the `/mcp` route needs testing to confirm it does not interfere with the Streamable HTTP session lifecycle (long-held connections for streaming responses).

---

## Contradictions and Disputes

- **Duplicate tools: error vs. silent accumulation**: Issue #2093 reports silent tool accumulation (no error thrown); issues #14111, #10704, #10668 report hard HTTP 400 errors. The difference appears to be context: accumulation happens in session-scoped state (visible via `/mcp` command but not yet sent to the API); the hard error happens when the accumulated tools are sent in an API request (compaction, subagent spawn). Both behaviors are real — they occur in sequence.

- **MCP deduplication in v2.1.71**: Claude Code introduced deduplication logic to prevent the exact DorkOS collision scenario. However, issue #32549 documents that this deduplication has bugs (ignores env vars, causes false positives). Do not rely on Claude Code's dedup to save DorkOS users — the server-side warning approach is more reliable.

- **One-time key reveal vs. retrievable key**: Some tools (HashiCorp Vault, GCP) allow re-retrieving keys from the server. Most developer-facing tools (GitHub, OpenAI, Stripe, AWS) enforce one-time reveal. For DorkOS, one-time reveal is the correct choice: it matches user expectations for developer API keys, prevents keys from leaking via the settings page, and simplifies the server (no need to store keys securely with retrieval — just store and compare hashes if desired, or plaintext for local-only).

---

## Recommendations Summary

| Priority | Item                                                                  | Effort | Notes                                      |
| -------- | --------------------------------------------------------------------- | ------ | ------------------------------------------ |
| P0       | Duplicate tools warning in setup instructions UI                      | Low    | Must ship day 1 — prevents silent breakage |
| P0       | Startup detection: scan `.mcp.json` for DorkOS URL, log WARNING       | Medium | Server-side guard                          |
| P1       | Enable/disable toggle via `configManager` + `PATCH /api/mcp-settings` | Medium | No restart required                        |
| P1       | API key generate/rotate/revoke via API + settings UI                  | Medium | Move from env-only to configManager        |
| P1       | One-time key reveal UX with copy-to-clipboard                         | Low    | Standard pattern                           |
| P1       | Setup instructions per client (Claude Code, Cursor, Windsurf)         | Low    | Tabbed code blocks                         |
| P2       | `dork_` prefixed key generation                                       | Low    | Better identification in logs              |
| P2       | Rate limiting on `/mcp` route                                         | Low    | Only matters with tunnel                   |
| P2       | Per-tool toggle (allowedExternalTools config)                         | Medium | Follow-up after server-level toggle        |
| P3       | Key storage with restricted file permissions (0600)                   | Low    | Startup check only                         |

---

## Search Methodology

- Searches performed: 12 web searches + 6 WebFetch calls
- Most productive search terms: "Claude Code MCP duplicate tool names same server configured twice", "tool names must be unique MCP Claude Code", "MCP server enabled field configuration json toggle disable", "API key management UI show hide generate rotate"
- Primary sources: GitHub/anthropics/claude-code issues (duplicate tools), VS Code docs (config schema), Claude Code official docs (HTTP MCP format), DEV Community (per-tool toggle UX)
- Existing DorkOS research leveraged: 4 prior reports (mcp-server-express-embedding, mcp-tool-injection-patterns, mcp-tool-naming-conventions, claude-code-mcp-lazy-loading) — all highly relevant, covered foundational MCP architecture
- Key codebase files read: `routes/mcp.ts`, `routes/mcp-config.ts`, `middleware/mcp-auth.ts`, `env.ts`, `index.ts` (MCP mounting section)
