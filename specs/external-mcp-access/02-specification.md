---
slug: external-mcp-access
number: 215
status: specification
created: 2026-04-05
---

# External MCP Access Controls — Implementation Specification

## Table of Contents

1. [Overview](#1-overview)
2. [Patterns and Conventions](#2-patterns-and-conventions)
3. [Schema Changes](#3-schema-changes)
4. [API Changes](#4-api-changes)
5. [Middleware Changes](#5-middleware-changes)
6. [Frontend Design](#6-frontend-design)
7. [Transport Layer](#7-transport-layer)
8. [Data Flow](#8-data-flow)
9. [Implementation Phases](#9-implementation-phases)
10. [Testing Strategy](#10-testing-strategy)
11. [Security Considerations](#11-security-considerations)
12. [Open Questions](#12-open-questions)

---

## 1. Overview

DorkOS exposes a stateless MCP server at `/mcp` (Streamable HTTP) that gives external agents (Claude Code, Cursor, Windsurf) access to all 41 DorkOS tools. Today it is always-on with only an optional `MCP_API_KEY` environment variable for auth — there is no UI visibility, no toggles, no rate limiting, and no API key lifecycle management.

This spec adds a complete External Access control surface to the Settings Tools tab: enable/disable toggle, API key generation and rotation, rate limiting configuration, per-client setup instructions, and a prominent duplicate-tool collision warning.

**Design decisions locked in ideation:**

| #   | Decision                  | Choice                                                                                                                                 |
| --- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | API key storage           | `config.json` with env var override — consistent with tunnel auth pattern                                                              |
| 2   | Enable/disable            | Hot toggle via middleware gate — no restart required                                                                                   |
| 3   | Rate limiting             | `express-rate-limit` (already in `apps/server/package.json`)                                                                           |
| 4   | Scope                     | Toggle, API key, instructions, endpoint URL, auth status, duplicate warning, per-client tabs, rate limiting. Defer per-tool filtering. |
| 5   | Duplicate tool mitigation | UI warning + distinct server name `dorkos-external` in setup snippets                                                                  |
| 6   | UI layout                 | Separate FieldCard (via extracted `ExternalMcpCard`) below the tool groups FieldCard in ToolsTab                                       |
| 7   | Documentation             | Per-client setup instructions inline in ToolsTab and mirrored in `docs/`                                                               |

**Blast radius:** 10 files modified, 3 files created.

---

## 2. Patterns and Conventions

The following existing patterns directly inform this implementation.

**Config section pattern** (`packages/shared/src/config-schema.ts:43-60`)
Each subsystem has its own top-level key in `UserConfigSchema` with a `.default(...)` that provides the full default object. Sensitive fields are added to `SENSITIVE_CONFIG_KEYS` as dot-path strings. The `tunnel` section is the direct model: it stores a nullable auth token alongside boolean flags.

**ServerConfig response pattern** (`apps/server/src/routes/config.ts:74-146`)
The `GET /api/config` handler reads from `configManager`, `env`, and subsystem state modules, then assembles a response object. Each subsystem is a separate key (`tasks`, `relay`, `mesh`, `tunnel`). The `mcp` key follows the same pattern.

**Sensitive config key pattern** (`packages/shared/src/config-schema.ts:4-9`)
`SENSITIVE_CONFIG_KEYS` is an `as const` tuple of dot-path strings. The PATCH handler checks every incoming key against this list and appends a warning to the response. `'mcp.apiKey'` belongs here.

**Rate limiter usage** (`apps/server/src/routes/admin.ts:4, 47-51`)

```typescript
import rateLimit from 'express-rate-limit';
const limiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 3, message: { error: '...' } });
```

The MCP rate limiter follows this exact pattern, reading values from `configManager` at factory time.

**Middleware chain** (`apps/server/src/index.ts:305-311`)
Current: `validateMcpOrigin → mcpApiKeyAuth → createMcpRouter`
New: `validateMcpOrigin → requireMcpEnabled → mcpApiKeyAuth → rateLimitMcp → createMcpRouter`

**Click-to-copy pattern** (`apps/client/src/layers/features/settings/ui/ServerTab.tsx:73-82`)
The `useCopy()` hook uses `navigator.clipboard.writeText` and sets a `copied` boolean for `TIMING.COPY_FEEDBACK_MS`. The endpoint URL field in the External Access card uses this hook directly.

**Collapsible expand pattern** (`apps/client/src/layers/features/settings/ui/ToolsTab.tsx:136-221`)
The Tasks group uses `Collapsible` + `CollapsibleContent` with a `ChevronDown` button. The External Access card uses the same pattern: collapsed header shows label + status badge + switch; expanded shows all configuration detail.

**SettingRow pattern** (`apps/client/src/layers/features/settings/ui/ToolsTab.tsx:205-209`)
Every config row uses `<SettingRow label="..." description="...">` with controls as children. All new rows in the External Access card follow this convention.

**Transport method placement** (`apps/client/src/layers/shared/lib/transport/system-methods.ts:267-272`)
New config-scoped POST/DELETE actions go in `system-methods.ts`, following the `setDefaultAgent` pattern (PUT on a specific sub-resource of `/config`).

**File size threshold** (`.claude/rules/file-size.md`)
`ToolsTab.tsx` is currently 433 lines. Adding ExternalMcpCard inline would push it past the 500-line threshold. The card is extracted to `ExternalMcpCard.tsx` in the same directory.

---

## 3. Schema Changes

### 3.1 UserConfigSchema — `packages/shared/src/config-schema.ts`

**Add to `SENSITIVE_CONFIG_KEYS`** (line 8, after `'tunnel.passcodeSalt'`):

```typescript
export const SENSITIVE_CONFIG_KEYS = [
  'tunnel.authtoken',
  'tunnel.auth',
  'tunnel.passcodeHash',
  'tunnel.passcodeSalt',
  'mcp.apiKey',
] as const;
```

**Add `mcp` section to `UserConfigSchema`** (between `extensions` and `sessionSecret`):

```typescript
mcp: z
  .object({
    enabled: z.boolean().default(true),
    apiKey: z.string().nullable().default(null),
    rateLimit: z
      .object({
        enabled: z.boolean().default(true),
        maxPerWindow: z.number().int().min(1).max(1000).default(60),
        windowSecs: z.number().int().min(1).max(3600).default(60),
      })
      .default(() => ({ enabled: true, maxPerWindow: 60, windowSecs: 60 })),
  })
  .default(() => ({
    enabled: true,
    apiKey: null,
    rateLimit: { enabled: true, maxPerWindow: 60, windowSecs: 60 },
  })),
```

`USER_CONFIG_DEFAULTS` is derived from `UserConfigSchema.parse({ version: 1 })` — no manual update needed; the `.default(...)` values are picked up automatically.

### 3.2 ServerConfigSchema — `packages/shared/src/schemas.ts`

Add `mcp` optional field to `ServerConfigSchema` after the `agents` field (before `.openapi('ServerConfig')`):

```typescript
mcp: z
  .object({
    enabled: z.boolean().openapi({
      description: 'Whether the external MCP server accepts requests',
    }),
    authConfigured: z.boolean().openapi({
      description: 'True when an API key is active (from config.json or MCP_API_KEY env var)',
    }),
    authSource: z
      .enum(['config', 'env', 'none'])
      .openapi({
        description: "Source of the active API key: 'config', 'env', or 'none'",
      }),
    endpoint: z.string().openapi({
      description: 'Full URL of the external MCP endpoint',
    }),
    rateLimit: z.object({
      enabled: z.boolean(),
      maxPerWindow: z.number().int(),
      windowSecs: z.number().int(),
    }),
  })
  .optional()
  .openapi({ description: 'External MCP server access control status' }),
```

The field is `.optional()` for backward compatibility with clients on older server versions.

---

## 4. API Changes

### 4.1 Config GET handler — `apps/server/src/routes/config.ts`

In the `router.get('/')` handler body, add the `mcp` key to the `res.json({...})` call alongside `tasks`, `relay`, `mesh`:

```typescript
const mcpConfig = configManager.get('mcp');
const mcpApiKeyFromEnv = env.MCP_API_KEY ?? null;
const mcpApiKeyFromConfig = mcpConfig?.apiKey ?? null;
const effectiveApiKey = mcpApiKeyFromEnv ?? mcpApiKeyFromConfig;

// Inside res.json({...}):
mcp: {
  enabled: mcpConfig?.enabled ?? true,
  authConfigured: !!effectiveApiKey,
  authSource: mcpApiKeyFromEnv ? 'env' : mcpApiKeyFromConfig ? 'config' : 'none',
  endpoint: `http://localhost:${env.DORKOS_PORT}/mcp`,
  rateLimit: mcpConfig?.rateLimit ?? { enabled: true, maxPerWindow: 60, windowSecs: 60 },
},
```

Both `configManager` and `env` are already imported in `config.ts`.

### 4.2 New route — `POST /api/config/mcp/generate-key`

Add after the `router.put('/agents/defaultAgent', ...)` handler:

```typescript
/**
 * Generate a new MCP API key, persist it to config, and return it in plaintext.
 * This is the only endpoint that returns the raw key — all subsequent reads
 * return authConfigured: true but never expose the key value.
 */
router.post('/mcp/generate-key', (_req, res) => {
  try {
    // 24 random bytes → 48-char hex string → 'dork_' prefix → 53-char key (~192 bits entropy)
    const raw = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('hex');
    const newKey = `dork_${raw}`;

    const current = configManager.get('mcp') ?? {
      enabled: true,
      apiKey: null,
      rateLimit: { enabled: true, maxPerWindow: 60, windowSecs: 60 },
    };
    configManager.set('mcp', { ...current, apiKey: newKey });
    logger.info('[Config] MCP API key generated');

    return res.status(201).json({ apiKey: newKey });
  } catch (err) {
    logger.error('[Config] Failed to generate MCP API key', logError(err));
    return res.status(500).json({ error: 'Internal server error' });
  }
});
```

`crypto` is available as a global in Node 20+ without any import. `logError` and `logger` are already imported in `config.ts`.

### 4.3 New route — `DELETE /api/config/mcp/api-key`

Add after the generate-key route:

```typescript
/**
 * Remove the config-stored MCP API key.
 * Does not affect the MCP_API_KEY environment variable override.
 */
router.delete('/mcp/api-key', (_req, res) => {
  try {
    const current = configManager.get('mcp') ?? {
      enabled: true,
      apiKey: null,
      rateLimit: { enabled: true, maxPerWindow: 60, windowSecs: 60 },
    };
    configManager.set('mcp', { ...current, apiKey: null });
    logger.info('[Config] MCP API key removed');
    return res.json({ success: true });
  } catch (err) {
    logger.error('[Config] Failed to remove MCP API key', logError(err));
    return res.status(500).json({ error: 'Internal server error' });
  }
});
```

Used by the "Rotate" flow: the client calls DELETE then POST generate-key in sequence, displaying the new key in the one-time-reveal modal.

---

## 5. Middleware Changes

### 5.1 CREATE — `apps/server/src/middleware/mcp-enabled.ts`

```typescript
import type { Request, Response, NextFunction } from 'express';
import { configManager } from '../services/core/config-manager.js';

/**
 * Gate middleware for the external MCP endpoint.
 *
 * Returns 503 with a JSON-RPC error body when `mcp.enabled` is false in config.
 * Allows the MCP server to be toggled on/off without a server restart.
 * Per-request configManager reads are O(1) in-memory lookups.
 */
export function requireMcpEnabled(_req: Request, res: Response, next: NextFunction): void {
  const enabled = configManager.get('mcp')?.enabled ?? true;

  if (!enabled) {
    res.status(503).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'External MCP access is disabled.' },
      id: null,
    });
    return;
  }

  next();
}
```

### 5.2 UPDATE — `apps/server/src/middleware/mcp-auth.ts`

Replace the key resolution line. Full file after update:

```typescript
import type { Request, Response, NextFunction } from 'express';
import { env } from '../env.js';
import { configManager } from '../services/core/config-manager.js';

/**
 * Optional API key authentication middleware for the MCP endpoint.
 *
 * Key resolution order:
 *   1. MCP_API_KEY environment variable (highest priority — cannot be overridden from UI)
 *   2. mcp.apiKey from config.json (managed via Settings → Tools → External Access)
 *
 * When neither is set, all requests pass through (localhost-only access).
 */
export function mcpApiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const apiKey = env.MCP_API_KEY ?? configManager.get('mcp')?.apiKey ?? null;

  if (!apiKey) {
    next();
    return;
  }

  const authHeader = req.headers.authorization ?? '';
  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || token !== apiKey) {
    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized. Set Authorization: Bearer <MCP_API_KEY>.' },
      id: null,
    });
    return;
  }

  next();
}
```

All existing tests in `apps/server/src/middleware/__tests__/mcp-auth.test.ts` pass without modification because they mock `env.MCP_API_KEY` — the config-key path evaluates to `null` when `configManager` is not mocked (its default returns `undefined`).

### 5.3 CREATE — `apps/server/src/middleware/mcp-rate-limit.ts`

```typescript
import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';
import { configManager } from '../services/core/config-manager.js';

/**
 * Build a rate limiter for the external MCP endpoint from current config values.
 *
 * Called once at server startup in index.ts. Rate limit config changes
 * take effect after a server restart (the Settings UI communicates this).
 *
 * When rate limiting is disabled in config, returns a pass-through middleware.
 */
export function buildMcpRateLimiter(): RateLimitRequestHandler {
  const cfg = configManager.get('mcp')?.rateLimit ?? {
    enabled: true,
    maxPerWindow: 60,
    windowSecs: 60,
  };

  if (!cfg.enabled) {
    return ((_req, _res, next) => next()) as unknown as RateLimitRequestHandler;
  }

  return rateLimit({
    windowMs: cfg.windowSecs * 1000,
    max: cfg.maxPerWindow,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      jsonrpc: '2.0',
      error: { code: -32029, message: 'Rate limit exceeded. Try again shortly.' },
      id: null,
    },
  });
}
```

### 5.4 UPDATE — `apps/server/src/index.ts`

**Add imports** (alongside `mcpApiKeyAuth` and `validateMcpOrigin`):

```typescript
import { requireMcpEnabled } from './middleware/mcp-enabled.js';
import { buildMcpRateLimiter } from './middleware/mcp-rate-limit.js';
```

**Replace the existing MCP mount block** (lines ~284-312). The conditional `if (claudeRuntime)` around the entire mount is removed. The `setMcpServerFactory` call and `mcpToolDeps` construction stay inside a `claudeRuntime` guard. The route is always mounted:

```typescript
// Build mcpToolDeps and register factory only when ClaudeCodeRuntime is available.
let mcpToolDeps: Parameters<typeof createExternalMcpServer>[0] | undefined;
if (claudeRuntime) {
  mcpToolDeps = {
    transcriptReader: claudeRuntime.getTranscriptReader(),
    defaultCwd: env.DORKOS_DEFAULT_CWD ?? process.cwd(),
    ...(taskStore && { taskStore }),
    ...(relayCore && { relayCore }),
    ...(adapterManager && { adapterManager }),
    ...(adapterManager && { bindingStore: adapterManager.getBindingStore() }),
    ...(adapterManager && { bindingRouter: adapterManager.getBindingRouter() }),
    ...(traceStore && { traceStore }),
    ...(meshCore && { meshCore }),
  };
  claudeRuntime.setMcpServerFactory((session) => ({
    dorkos: createDorkOsToolServer(mcpToolDeps!, session),
  }));
}

// Always mount /mcp — requireMcpEnabled handles the disabled case with a clean 503.
const mcpRateLimiter = buildMcpRateLimiter();
const mcpAuthMode =
  (env.MCP_API_KEY ?? configManager.get('mcp')?.apiKey) ? 'auth: API key' : 'auth: none';

app.use(
  '/mcp',
  validateMcpOrigin,
  requireMcpEnabled,
  mcpApiKeyAuth,
  mcpRateLimiter,
  createMcpRouter(() => {
    if (!claudeRuntime || !mcpToolDeps) {
      throw new Error(
        'ClaudeCodeRuntime not available — external MCP server cannot handle requests'
      );
    }
    return createExternalMcpServer(mcpToolDeps);
  })
);
logger.info(`[MCP] External MCP server mounted at /mcp (stateless, ${mcpAuthMode})`);
```

---

## 6. Frontend Design

### 6.1 File Structure

All changes in `apps/client/src/layers/features/settings/ui/ToolsTab.tsx`. No new files needed — the External Access section is a `CollapsibleFieldCard` added below the existing tool groups `FieldCard`.

### 6.2 Component Structure

```
ToolsTab
├── <p> description text
├── <FieldCard>                          ← existing tool groups
│   └── <FieldCardContent>
│       ├── Core Tools row
│       ├── Tasks row (expandable → scheduler)
│       ├── Relay row
│       ├── Mesh row
│       └── Adapter row
└── <CollapsibleFieldCard>               ← NEW: External Access
    ├── trigger: "External Access" + status badge + switch
    └── content (when expanded):
        ├── EndpointRow         — read-only URL, click-to-copy
        ├── AuthSection         — API key lifecycle (generate/view/copy/rotate)
        ├── RateLimitSection    — enable toggle + config inputs
        ├── SetupInstructions   — tabbed per-client config snippets
        └── DuplicateToolWarning — alert callout
```

### 6.3 CollapsibleFieldCard Trigger

The collapsed row shows:

- **Label**: "External Access"
- **Description**: "Allow external agents to use DorkOS tools via MCP"
- **Right side**: Status badge (`Enabled` / `Disabled` / `No auth`) + Switch
- **Chevron**: Expands to reveal configuration

The switch toggles `mcp.enabled` via `transport.updateConfig()`. The badge reflects:

- `Enabled` (green outline) when enabled + auth configured
- `No auth` (amber) when enabled but no API key
- `Disabled` (secondary) when disabled

### 6.4 Endpoint Row

```tsx
<SettingRow label="Endpoint" description="MCP server URL for external agents">
  <div className="flex items-center gap-2">
    <code className="bg-muted rounded px-2 py-1 text-xs">{endpoint}</code>
    <CopyButton value={endpoint} />
  </div>
</SettingRow>
```

The endpoint URL comes from `serverConfig.mcp.endpoint` (e.g., `http://localhost:6242/mcp`).

### 6.5 Auth Section

Three states:

**No API key configured:**

```tsx
<SettingRow label="Authentication" description="Protect the MCP endpoint with an API key">
  <Button size="sm" onClick={generateKey}>
    Generate API Key
  </Button>
</SettingRow>
```

**API key exists (config-managed):**

```tsx
<SettingRow label="API Key" description="Bearer token for MCP authentication">
  <div className="flex items-center gap-2">
    <code className="bg-muted rounded px-2 py-1 text-xs">dork_••••{last4}</code>
    <CopyButton value={fullKey} /> {/* only available right after generation */}
    <Button variant="ghost" size="sm" onClick={rotateKey}>
      Rotate
    </Button>
  </div>
</SettingRow>
```

**API key from env var (read-only):**

```tsx
<SettingRow label="API Key" description="Set via MCP_API_KEY environment variable">
  <Badge variant="outline">Environment variable</Badge>
</SettingRow>
```

Key generation calls `POST /api/config/mcp/generate-key`. The full key is shown once immediately after generation with a copy button and "Key generated — copy it now, it won't be shown again" hint. Subsequent views show the masked version (`dork_••••{last4}`).

### 6.6 Rate Limit Section

```tsx
<SettingRow label="Rate limiting" description="Limit external MCP requests per time window">
  <Switch checked={rateLimit.enabled} onCheckedChange={...} />
</SettingRow>
{rateLimit.enabled && (
  <>
    <SettingRow label="Max requests" description="Requests allowed per window">
      <Input type="number" min={1} max={1000} value={rateLimit.maxPerWindow} ... className="w-20" />
    </SettingRow>
    <SettingRow label="Window (seconds)" description="Time window for rate limiting">
      <Input type="number" min={1} max={3600} value={rateLimit.windowSecs} ... className="w-20" />
    </SettingRow>
  </>
)}
```

### 6.7 Setup Instructions (Tabbed)

A tabbed interface showing config snippets per client. Each tab has a copy-to-clipboard button.

**Tab: Claude Code**

```json
{
  "mcpServers": {
    "dorkos-external": {
      "type": "http",
      "url": "http://localhost:6242/mcp",
      "headers": {
        "Authorization": "Bearer dork_YOUR_API_KEY"
      }
    }
  }
}
```

Plus CLI command: `claude mcp add-json dorkos-external '{"type":"http","url":"http://localhost:6242/mcp","headers":{"Authorization":"Bearer dork_YOUR_API_KEY"}}'`

**Tab: Cursor**

```json
{
  "mcpServers": {
    "dorkos-external": {
      "url": "http://localhost:6242/mcp",
      "headers": {
        "Authorization": "Bearer dork_YOUR_API_KEY"
      }
    }
  }
}
```

**Tab: Windsurf**

```json
{
  "mcpServers": {
    "dorkos-external": {
      "serverUrl": "http://localhost:6242/mcp",
      "headers": {
        "Authorization": "Bearer dork_YOUR_API_KEY"
      }
    }
  }
}
```

When an API key exists, the snippets auto-fill the key value. The server name `dorkos-external` is deliberate — avoids prefix collision with the internal `dorkos` MCP server name.

### 6.8 Duplicate Tool Warning

An amber callout at the bottom of the expanded section:

> **Do not configure this for agents running inside DorkOS.** DorkOS already provides tools to its managed agents internally. Adding DorkOS as an external MCP server to those same agents causes duplicate tool names — the Anthropic API will return HTTP 400 "Tool names must be unique" and all tool calls will fail. External MCP access is for agents running **outside** of DorkOS (standalone Claude Code, Cursor, Windsurf).

Use the existing alert/callout pattern with `AlertTriangle` icon and `bg-amber-500/10 border-amber-500/20` styling.

---

## 7. Transport Layer

### 7.1 New Transport Method

Add `generateMcpApiKey()` to the Transport interface:

```typescript
// packages/shared/src/transport.ts
generateMcpApiKey(): Promise<{ apiKey: string }>;
```

**HttpTransport implementation** (`apps/client/src/layers/shared/lib/transport/`):

```typescript
async generateMcpApiKey(): Promise<{ apiKey: string }> {
  const res = await fetch(`${this.baseUrl}/api/config/mcp/generate-key`, { method: 'POST' });
  return res.json();
}
```

**DirectTransport** (Obsidian): stub returning an error (MCP external access not available in embedded mode).

### 7.2 Existing Methods Used

- `transport.getConfig()` — fetches `mcp` section alongside existing config
- `transport.updateConfig({ mcp: { enabled, rateLimit } })` — toggles and rate limit changes

---

## 8. Data Flow

### 8.1 Enable/Disable Toggle

```
User flips switch → updateConfig({ mcp: { ...current, enabled: false } })
  → PATCH /api/config → configManager.set('mcp', { ...current, enabled: false })
  → Next MCP request hits requireMcpEnabled middleware → 503 Service Unavailable
  → queryClient.invalidateQueries(['config']) → ToolsTab re-renders with "Disabled" badge
```

### 8.2 API Key Generation

```
User clicks "Generate API Key" → POST /api/config/mcp/generate-key
  → Server generates `dork_` + 32 hex chars via crypto.randomBytes(16)
  → configManager.set('mcp', { ...current, apiKey: generatedKey })
  → Response: { apiKey: "dork_a1b2c3d4..." }
  → UI shows full key with copy button + "copy now" hint
  → queryClient.invalidateQueries(['config']) → subsequent loads show masked key
```

### 8.3 External MCP Request (Happy Path)

```
External agent → POST /mcp
  → validateMcpOrigin: check Origin header
  → requireMcpEnabled: check configManager.get('mcp')?.enabled !== false
  → mcpApiKeyAuth: validate Bearer token against env.MCP_API_KEY ?? configManager.get('mcp')?.apiKey
  → rateLimitMcp: check express-rate-limit window
  → createMcpRouter: create fresh McpServer, handle request, cleanup
  → 200 OK with tool response
```

---

## 9. Implementation Phases

### Phase 1: Backend — Config & Middleware (4 files modified, 1 created)

| File                                        | Change                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| `packages/shared/src/config-schema.ts`      | Add `mcp` section to `UserConfigSchema`, add `'mcp.apiKey'` to `SENSITIVE_CONFIG_KEYS` |
| `packages/shared/src/schemas.ts`            | Add `mcp` object to `ServerConfigSchema`                                               |
| `apps/server/src/routes/config.ts`          | Add `mcp` to GET response, add `POST /mcp/generate-key` endpoint                       |
| `apps/server/src/middleware/mcp-auth.ts`    | Read API key from config (with env var override)                                       |
| `apps/server/src/middleware/mcp-enabled.ts` | **New file** — `requireMcpEnabled` middleware                                          |

### Phase 2: Backend — Rate Limiting & Mount Changes (3 files modified)

| File                            | Change                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------- |
| `apps/server/package.json`      | Add `express-rate-limit` dependency                                               |
| `apps/server/src/routes/mcp.ts` | Export `buildMcpRateLimiter()` factory                                            |
| `apps/server/src/index.ts`      | Always mount `/mcp`, add `requireMcpEnabled` and rate limiter to middleware chain |

### Phase 3: Frontend — ToolsTab Extension (2 files modified)

| File                                                       | Change                                                           |
| ---------------------------------------------------------- | ---------------------------------------------------------------- |
| `apps/client/src/layers/features/settings/ui/ToolsTab.tsx` | Add External Access `CollapsibleFieldCard` with all sub-sections |
| `packages/shared/src/transport.ts`                         | Add `generateMcpApiKey()` method signature                       |

HttpTransport implementation file for the new method.

### Phase 4: Documentation

| File               | Change                                                           |
| ------------------ | ---------------------------------------------------------------- |
| `docs/` (Fumadocs) | Add MCP external access setup guide with per-client instructions |

---

## 10. Testing Strategy

### Backend Tests

**`apps/server/src/middleware/__tests__/mcp-enabled.test.ts`** (new):

- Returns 503 when `mcp.enabled` is false
- Passes when `mcp.enabled` is true
- Passes when `mcp` config is undefined (default enabled)

**`apps/server/src/middleware/__tests__/mcp-auth.test.ts`** (extend):

- Reads API key from config when env var is unset
- Env var overrides config key
- Rejects invalid Bearer token against config key
- Passes when no auth configured (config null + env unset)

**`apps/server/src/routes/__tests__/config.test.ts`** (extend):

- GET returns `mcp` section with correct `authConfigured`, `authSource`, `endpoint`
- POST generate-key returns key with `dork_` prefix and 32 hex chars
- POST generate-key stores key in config
- PATCH mcp config validates rate limit bounds

### Frontend Tests

**`apps/client/src/layers/features/settings/__tests__/ToolsTab.test.tsx`** (new):

- Renders External Access section
- Toggle switch calls updateConfig with `mcp.enabled`
- Shows "Generate API Key" when no key configured
- Shows masked key when key exists
- Shows "Environment variable" badge when auth source is env

---

## 11. Security Considerations

- **API key in config.json**: Stored in plaintext at `~/.dork/config.json`. The `conf` package uses atomic writes. File permissions should be `0600`. This matches the tunnel `authtoken` pattern already in production.
- **Sensitive key warning**: `'mcp.apiKey'` added to `SENSITIVE_CONFIG_KEYS` — PATCH requests that modify it get a response warning.
- **Rate limiting when tunnel active**: When ngrok tunnel is running, `/mcp` is exposed to the internet. Rate limiting defaults (60 req/min) provide baseline protection. Users should be encouraged to always set an API key when using tunnel.
- **One-time key reveal**: Full API key is only returned by the generate endpoint. Subsequent `GET /api/config` returns a masked version. This prevents casual exposure in browser devtools or logs.
- **Env var override**: `MCP_API_KEY` environment variable always takes precedence over config key, allowing deployment-time secrets management.

---

## 12. Open Questions

No open questions remain — all decisions were resolved during ideation.
