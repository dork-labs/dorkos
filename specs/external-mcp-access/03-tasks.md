# External MCP Access Controls — Task Breakdown

**Spec:** `specs/external-mcp-access/02-specification.md`
**Generated:** 2026-04-05
**Mode:** Full

---

## Summary

| Phase     | Name                       | Tasks  | Sizes      |
| --------- | -------------------------- | ------ | ---------- |
| 1         | Backend Foundation         | 4      | 2S, 1M, 1S |
| 2         | Backend Middleware & Mount | 3      | 2S, 1M     |
| 3         | Frontend                   | 2      | 1S, 1L     |
| 4         | Tests                      | 4      | 2S, 2M     |
| **Total** |                            | **13** |            |

## Parallel Opportunities

- **Phase 1:** Tasks 1.1 and 1.2 can run in parallel (independent schema files). Tasks 1.3 and 1.4 can run in parallel after 1.1 completes.
- **Phase 2:** Tasks 2.1 and 2.2 can run in parallel (independent new middleware files). Task 2.3 depends on both.
- **Phase 4:** Tasks 4.1, 4.2, and 4.3 can run in parallel (independent test files). Task 4.4 depends on 3.2.

## Dependency Graph

```
1.1 (UserConfigSchema) ──┬──> 1.3 (Config routes) ──┬──> 3.1 (Transport) ──> 3.2 (ExternalMcpCard) ──> 4.4 (Frontend tests)
                         │                          │
                         ├──> 1.4 (mcp-auth) ───────┤──> 4.2 (Auth tests)
                         │                          │
                         ├──> 2.1 (mcp-enabled) ────┤──> 4.1 (Enabled tests)
                         │                          │
                         └──> 2.2 (rate-limit) ─────┘
                                                    │
1.2 (ServerConfigSchema) ──────────────────────────>┤
                                                    │
                                                    └──> 2.3 (index.ts mount) ──> 4.3 (Route tests)
```

---

## Phase 1: Backend Foundation

### Task 1.1 — Add mcp section to UserConfigSchema and SENSITIVE_CONFIG_KEYS

**Size:** Small | **Priority:** High | **Depends on:** none | **Parallel with:** 1.2

**File:** `packages/shared/src/config-schema.ts`

Add `'mcp.apiKey'` to `SENSITIVE_CONFIG_KEYS` and add the `mcp` section to `UserConfigSchema` with `enabled` (boolean, default true), `apiKey` (nullable string, default null), and `rateLimit` (nested object with `enabled`, `maxPerWindow`, `windowSecs`). Follows the `tunnel` section pattern exactly.

**Acceptance Criteria:**

- `SENSITIVE_CONFIG_KEYS` includes `'mcp.apiKey'`
- `UserConfigSchema.parse({ version: 1 })` produces correct defaults
- `pnpm typecheck` passes

---

### Task 1.2 — Add mcp field to ServerConfigSchema

**Size:** Small | **Priority:** High | **Depends on:** none | **Parallel with:** 1.1

**File:** `packages/shared/src/schemas.ts`

Add the `mcp` optional field to `ServerConfigSchema` with `enabled`, `authConfigured`, `authSource` (enum: config/env/none), `endpoint`, and `rateLimit`. Field is `.optional()` for backward compatibility.

**Acceptance Criteria:**

- `ServerConfigSchema` parses with and without the `mcp` field
- `ServerConfig` type includes the correct `mcp?` type
- `pnpm typecheck` passes

---

### Task 1.3 — Add mcp section to config GET response and new POST/DELETE routes

**Size:** Medium | **Priority:** High | **Depends on:** 1.1 | **Parallel with:** 1.4

**File:** `apps/server/src/routes/config.ts`

Three changes:

1. Add `mcp` key to GET `/` response with `enabled`, `authConfigured`, `authSource`, `endpoint`, `rateLimit`
2. Add `POST /mcp/generate-key` — generates `dork_` + 48 hex chars, persists to config, returns plaintext key once
3. Add `DELETE /mcp/api-key` — removes config-stored key, returns `{ success: true }`

**Acceptance Criteria:**

- GET response includes `mcp` section with correct auth detection
- POST returns 201 with 53-char key (`dork_` prefix + 48 hex)
- DELETE removes key and is idempotent

---

### Task 1.4 — Update mcp-auth middleware to read API key from config

**Size:** Small | **Priority:** High | **Depends on:** 1.1 | **Parallel with:** 1.3

**File:** `apps/server/src/middleware/mcp-auth.ts`

Change the key resolution line from `const apiKey = env.MCP_API_KEY;` to `const apiKey = env.MCP_API_KEY ?? configManager.get('mcp')?.apiKey ?? null;`. Add `configManager` import. Env var always takes precedence.

**Acceptance Criteria:**

- Env var overrides config key
- Config key used when env var unset
- No auth when neither set
- Existing tests pass without modification

---

## Phase 2: Backend Middleware & Mount

### Task 2.1 — Create requireMcpEnabled gate middleware

**Size:** Small | **Priority:** High | **Depends on:** 1.1 | **Parallel with:** 2.2

**New file:** `apps/server/src/middleware/mcp-enabled.ts`

Returns 503 with JSON-RPC error body when `mcp.enabled` is false. Defaults to enabled when config undefined. Per-request O(1) in-memory check.

**Acceptance Criteria:**

- 503 with `{ jsonrpc: '2.0', error: { code: -32000, message: 'External MCP access is disabled.' }, id: null }` when disabled
- Calls `next()` when enabled or config undefined

---

### Task 2.2 — Create MCP rate limiter middleware

**Size:** Small | **Priority:** High | **Depends on:** 1.1 | **Parallel with:** 2.1

**New file:** `apps/server/src/middleware/mcp-rate-limit.ts`

Exports `buildMcpRateLimiter()` factory using `express-rate-limit` (already in deps). Returns pass-through when disabled. JSON-RPC error format on rate limit exceeded.

**Acceptance Criteria:**

- Returns configured rate limiter when enabled
- Returns pass-through when disabled
- Rate limit exceeded returns JSON-RPC error with code -32029

---

### Task 2.3 — Update index.ts MCP mount block with new middleware chain

**Size:** Medium | **Priority:** High | **Depends on:** 1.4, 2.1, 2.2

**File:** `apps/server/src/index.ts`

Always mount `/mcp` (remove `if (claudeRuntime)` guard around the mount). Insert `requireMcpEnabled` and `buildMcpRateLimiter()` into the middleware chain. Order: `validateMcpOrigin -> requireMcpEnabled -> mcpApiKeyAuth -> mcpRateLimiter -> createMcpRouter`.

**Acceptance Criteria:**

- `/mcp` route always mounted
- Middleware chain in correct order
- Log line reflects correct auth mode
- Server starts successfully

---

## Phase 3: Frontend

### Task 3.1 — Add generateMcpApiKey and deleteMcpApiKey to Transport interface and HttpTransport

**Size:** Small | **Priority:** High | **Depends on:** 1.2, 1.3

**Files:** `packages/shared/src/transport.ts`, `apps/client/src/layers/shared/lib/transport/system-methods.ts`

Add `generateMcpApiKey()` and `deleteMcpApiKey()` to the Transport interface. Implement in HttpTransport as `fetchJSON` calls to `POST /config/mcp/generate-key` and `DELETE /config/mcp/api-key`. DirectTransport stubs throw errors.

**Acceptance Criteria:**

- Transport interface has both methods
- HttpTransport calls correct endpoints
- `pnpm typecheck` passes across all packages

---

### Task 3.2 — Add ExternalMcpCard to ToolsTab with toggle, auth, rate limiting, setup instructions, and duplicate warning

**Size:** Large | **Priority:** High | **Depends on:** 1.2, 3.1

**Files:** `apps/client/src/layers/features/settings/ui/ExternalMcpCard.tsx` (new), `apps/client/src/layers/features/settings/ui/ToolsTab.tsx` (import + render)

Full External Access card with:

- Collapsible trigger: label + status badge (Enabled/No auth/Disabled) + switch
- Endpoint row: read-only URL with copy button
- Auth section: three states (no key / config key / env var)
- Rate limit section: toggle + conditional numeric inputs
- Setup instructions: tabbed (Claude Code / Cursor / Windsurf) with copy buttons
- Duplicate tool warning: amber callout with AlertTriangle icon

**Acceptance Criteria:**

- Card renders below tool groups in ToolsTab
- All three auth states display correctly
- Rate limit inputs validate bounds
- Setup snippets auto-fill endpoint and API key
- Duplicate warning always visible when expanded
- Files stay under 500 lines each

---

## Phase 4: Tests

### Task 4.1 — Add tests for requireMcpEnabled middleware

**Size:** Small | **Priority:** Medium | **Depends on:** 2.1 | **Parallel with:** 4.2, 4.3

**New file:** `apps/server/src/middleware/__tests__/mcp-enabled.test.ts`

Three test cases: enabled, undefined config (default), disabled. Follows `mcp-auth.test.ts` pattern.

---

### Task 4.2 — Extend mcp-auth tests for config key fallback

**Size:** Small | **Priority:** Medium | **Depends on:** 1.4 | **Parallel with:** 4.1, 4.3

**File:** `apps/server/src/middleware/__tests__/mcp-auth.test.ts`

Four new tests: config key used when env unset, env overrides config, reject invalid token against config key, pass-through when both null.

---

### Task 4.3 — Extend config route tests for MCP GET response and POST/DELETE endpoints

**Size:** Medium | **Priority:** Medium | **Depends on:** 1.3 | **Parallel with:** 4.1, 4.2

**File:** `apps/server/src/routes/__tests__/config.test.ts`

Tests for: GET mcp section shape/defaults, POST generate-key format/persistence/uniqueness, DELETE key removal/idempotency, PATCH rate limit bounds validation.

---

### Task 4.4 — Add frontend tests for ExternalMcpCard

**Size:** Medium | **Priority:** Medium | **Depends on:** 3.2

**New file:** `apps/client/src/layers/features/settings/__tests__/ExternalMcpCard.test.tsx`

Five test cases: renders section, Generate button when no key, Environment variable badge, masked key + Rotate button, duplicate warning text.
