---
slug: relay-runtime-adapters
number: 57
created: 2026-02-25
status: specified
---

# Specification: Unified Adapter System & Claude Code Runtime Adapter

**Status:** Specified
**Authors:** Claude Code, 2026-02-25
**Spec:** 57
**Depends on:** Spec 53 (relay-external-adapters), Spec 50 (relay-core-library)

---

## Overview

Unify Relay's adapter system under a single pluggable `RelayAdapter` interface, extend it with `AdapterContext` for rich delivery metadata, add a plugin loader for third-party npm/local adapters, and build the Claude Code runtime adapter — the first adapter that bridges Relay messages to Agent SDK sessions. The Claude Code adapter replaces the temporary `MessageReceiver` bridge entirely.

## Background / Problem Statement

Relay currently has two separate mechanisms for dispatching messages to different targets:

1. **AdapterRegistry** + external adapters (Telegram, webhook) — implements the `RelayAdapter` interface for outbound delivery to external channels
2. **MessageReceiver** — a standalone bridge class that subscribes to `relay.agent.>` and `relay.system.pulse.>` subjects and dispatches to AgentManager

These two systems are disconnected: external adapters use a clean plugin interface while the agent dispatch path is a custom one-off. This creates several problems:

- No unified interface for all adapters — runtime adapters and external adapters are different patterns
- No way for third-party developers to add new adapters (the adapter type is a fixed enum: `'telegram' | 'webhook'`)
- The `MessageReceiver` duplicates delivery concerns (trace recording, error handling, response publishing) that should be standardized
- Adding a new runtime (Codex, OpenCode) would require writing another custom bridge

The solution is to extend the existing `RelayAdapter` interface with `AdapterContext` for richer delivery metadata, add dynamic plugin loading, and implement `ClaudeCodeAdapter` as a built-in adapter that replaces `MessageReceiver`.

## Goals

- Define `AdapterContext` and enrich the `deliver()` signature so adapters receive optional agent info (from Mesh), platform info, and trace context
- Refactor Spec 4's Telegram and webhook adapters to conform to the updated signature (minimal change)
- Implement a plugin loader that dynamically imports adapters from built-in code, npm packages, and local file paths
- Build `ClaudeCodeAdapter` that handles `relay.agent.>` and `relay.system.pulse.>` subjects, fully replacing `MessageReceiver`
- Export all adapter types from `@dorkos/relay` so third-party packages can implement them
- Optionally enrich `AdapterContext` with Mesh agent registry data when `MeshCore` is available

## Non-Goals

- Codex or OpenCode runtime adapters (future work — the interface supports them)
- Pulse/Console migration to Relay dispatch (already handled by Spec 5)
- Passive/IDE-based agents (only active agents supported)
- Adapter marketplace, auto-discovery, or registry service
- Client-side changes (this is entirely server/library work)
- Hot-reload of adapter code (only enable/disable via config changes; restart required for code changes)

## Technical Dependencies

| Dependency | Version | Purpose |
|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | existing | Agent SDK session creation |
| `@dorkos/relay` | workspace | Core message bus, `RelayAdapter` interface |
| `@dorkos/shared` | workspace | Zod schemas, shared types |
| `better-sqlite3` | existing | Trace storage (existing `TraceStore`) |
| Node.js `import()` | native | Dynamic plugin loading (no new deps) |

No new external dependencies required.

## Detailed Design

### Part 1: Extended Adapter Interface

#### New Types in `packages/relay/src/types.ts`

```typescript
/**
 * Rich context passed to adapter deliver() for informed dispatch decisions.
 *
 * Contains optional agent info (from Mesh registry or envelope metadata),
 * optional platform info (for external adapters), and trace context.
 */
export interface AdapterContext {
  /** Agent info — populated from Mesh registry, envelope metadata, or static config */
  agent?: {
    /** Working directory for the agent (absolute path) */
    directory: string;
    /** Runtime type (e.g., 'claude-code', 'codex', 'open-code') */
    runtime: string;
    /** Agent manifest from Mesh registry (if available) */
    manifest?: Record<string, unknown>;
  };
  /** Platform info — for external adapters */
  platform?: {
    /** Platform name (e.g., 'telegram', 'slack', 'discord') */
    name: string;
    /** Platform-specific metadata */
    metadata?: Record<string, unknown>;
  };
  /** Trace context for delivery tracking */
  trace?: {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
  };
}

/**
 * Result of an adapter delivery attempt.
 *
 * Adapters return this from deliver() to indicate success, failure, or
 * dead-letter disposition.
 */
export interface DeliveryResult {
  success: boolean;
  /** Error message if delivery failed */
  error?: string;
  /** Whether a dead letter was created for this failure */
  deadLettered?: boolean;
  /** Response message ID if the adapter published a reply */
  responseMessageId?: string;
  /** Delivery duration in milliseconds */
  durationMs?: number;
}
```

#### Updated `RelayAdapter` Interface

The `deliver()` method gains `context` and returns `DeliveryResult`:

```typescript
export interface RelayAdapter {
  readonly id: string;
  readonly subjectPrefix: string;
  readonly displayName: string;

  start(relay: RelayPublisher): Promise<void>;
  stop(): Promise<void>;

  /** Updated: receives AdapterContext and returns structured DeliveryResult */
  deliver(subject: string, envelope: RelayEnvelope, context?: AdapterContext): Promise<DeliveryResult>;

  getStatus(): AdapterStatus;
}
```

The `context` parameter is optional — existing adapters that don't use it continue to work.

#### Updated `AdapterRegistryLike` and `AdapterRegistry`

```typescript
export interface AdapterRegistryLike {
  setRelay(relay: RelayPublisher): void;
  deliver(subject: string, envelope: RelayEnvelope, context?: AdapterContext): Promise<boolean>;
  shutdown(): Promise<void>;
}
```

`AdapterRegistry.deliver()` passes `context` through to the matched adapter.

### Part 2: Plugin Loading

#### Config Schema Extension

Extend `AdapterConfigSchema` in `packages/shared/src/relay-schemas.ts`:

```typescript
export const AdapterTypeSchema = z
  .enum(['telegram', 'webhook', 'claude-code', 'plugin'])
  .openapi('AdapterType');

export const PluginSourceSchema = z
  .object({
    /** npm package name (e.g., 'dorkos-relay-slack') */
    package: z.string().optional(),
    /** Local file path (absolute or relative to config dir) */
    path: z.string().optional(),
  })
  .refine(
    (data) => data.package || data.path,
    { message: 'Plugin source must specify either package or path' },
  )
  .openapi('PluginSource');

export const AdapterConfigSchema = z
  .object({
    id: z.string().min(1).regex(/^[a-z0-9-]+$/),
    type: AdapterTypeSchema,
    enabled: z.boolean().default(true),
    /** Built-in adapter flag — when true, adapter is loaded from @dorkos/relay */
    builtin: z.boolean().optional(),
    /** Plugin source — required when type is 'plugin' */
    plugin: PluginSourceSchema.optional(),
    /** Adapter-specific configuration (passed to adapter constructor/factory) */
    config: z.record(z.unknown()).default({}),
  })
  .openapi('AdapterConfig');
```

#### Plugin Loader in `packages/relay/src/adapter-plugin-loader.ts`

```typescript
import { pathToFileURL } from 'node:url';
import { resolve, isAbsolute } from 'node:path';
import type { RelayAdapter, AdapterContext, DeliveryResult } from './types.js';

export interface PluginAdapterConfig {
  id: string;
  type: string;
  builtin?: boolean;
  plugin?: { package?: string; path?: string };
  config: Record<string, unknown>;
}

export interface AdapterPluginModule {
  default: (config: Record<string, unknown>) => RelayAdapter;
}

/**
 * Load adapter instances from config entries.
 *
 * Handles three sources:
 * 1. builtin: true → imported from built-in adapter map
 * 2. plugin.package → dynamic import(packageName)
 * 3. plugin.path → dynamic import(pathToFileURL(absolutePath))
 *
 * Loading errors are non-fatal — logs and skips.
 */
export async function loadAdapters(
  configs: PluginAdapterConfig[],
  builtinMap: Map<string, (config: Record<string, unknown>) => RelayAdapter>,
  configDir: string,
): Promise<RelayAdapter[]> {
  const adapters: RelayAdapter[] = [];

  for (const entry of configs) {
    if (!entry.enabled) continue;

    try {
      let adapter: RelayAdapter | null = null;

      if (entry.builtin && builtinMap.has(entry.type)) {
        // Built-in adapter
        const factory = builtinMap.get(entry.type)!;
        adapter = factory(entry.config);
      } else if (entry.plugin?.package) {
        // npm package
        const mod = await import(entry.plugin.package) as AdapterPluginModule;
        adapter = validateAndCreate(mod, entry);
      } else if (entry.plugin?.path) {
        // Local file
        const absPath = isAbsolute(entry.plugin.path)
          ? entry.plugin.path
          : resolve(configDir, entry.plugin.path);
        const mod = await import(pathToFileURL(absPath).href) as AdapterPluginModule;
        adapter = validateAndCreate(mod, entry);
      }

      if (adapter) {
        adapters.push(adapter);
      }
    } catch (err) {
      // Non-fatal: log and continue
      console.warn(`[PluginLoader] Failed to load adapter '${entry.id}':`, err);
    }
  }

  return adapters;
}

/** Duck-type validate and create adapter from a loaded module. */
function validateAndCreate(mod: unknown, entry: PluginAdapterConfig): RelayAdapter {
  const m = mod as Record<string, unknown>;
  if (typeof m.default !== 'function') {
    throw new Error(`Module for '${entry.id}' does not export a default factory function`);
  }
  const factory = m.default as (config: Record<string, unknown>) => RelayAdapter;
  const adapter = factory(entry.config);
  validateAdapterShape(adapter, entry.id);
  return adapter;
}

/** Validate that an object implements the RelayAdapter interface shape. */
function validateAdapterShape(obj: unknown, id: string): asserts obj is RelayAdapter {
  const a = obj as Record<string, unknown>;
  if (typeof a.id !== 'string') throw new Error(`Adapter '${id}': missing 'id' property`);
  if (typeof a.subjectPrefix !== 'string') throw new Error(`Adapter '${id}': missing 'subjectPrefix'`);
  if (typeof a.start !== 'function') throw new Error(`Adapter '${id}': missing 'start()' method`);
  if (typeof a.stop !== 'function') throw new Error(`Adapter '${id}': missing 'stop()' method`);
  if (typeof a.deliver !== 'function') throw new Error(`Adapter '${id}': missing 'deliver()' method`);
  if (typeof a.getStatus !== 'function') throw new Error(`Adapter '${id}': missing 'getStatus()' method`);
}
```

#### Third-Party Adapter Convention

Third-party adapters export a default factory function:

```typescript
// dorkos-relay-slack/src/index.ts
import type { RelayAdapter } from '@dorkos/relay';

interface SlackConfig {
  token: string;
  channel?: string;
}

export default function createSlackAdapter(config: Record<string, unknown>): RelayAdapter {
  const slackConfig = config as SlackConfig;
  return new SlackAdapter(slackConfig);
}
```

### Part 3: Claude Code Runtime Adapter

#### `packages/relay/src/adapters/claude-code-adapter.ts`

The adapter handles two subject patterns:
- `relay.agent.>` — agent-directed messages
- `relay.system.pulse.>` — Pulse scheduler dispatch

It replaces `MessageReceiver` entirely.

**Key design decisions:**

1. **Semaphore concurrency** — Tracks active sessions with a counter; rejects with backpressure when at capacity
2. **Budget-aware timeout** — Derives session timeout from envelope TTL budget
3. **XML context blocks** — Formats Relay metadata into `<relay_context>` blocks matching `context-builder.ts` pattern
4. **Trace integration** — Records trace spans throughout the delivery lifecycle
5. **Response publishing** — Publishes agent response back to `envelope.replyTo` if specified

```typescript
export interface ClaudeCodeAdapterConfig {
  /** Maximum concurrent agent sessions. Default: 3 */
  maxConcurrent?: number;
  /** Default session timeout in ms (used when envelope has no TTL). Default: 300000 (5 min) */
  defaultTimeoutMs?: number;
  /** Default working directory for agents without explicit directory */
  defaultCwd?: string;
}

/**
 * Minimal interface for agent session management.
 *
 * Matches the existing AgentManagerLike from message-receiver.ts for
 * seamless replacement.
 */
export interface AgentManagerLike {
  ensureSession(
    sessionId: string,
    opts: { permissionMode: string; cwd?: string; hasStarted?: boolean },
  ): void;
  sendMessage(
    sessionId: string,
    content: string,
    opts?: { permissionMode?: string; cwd?: string },
  ): AsyncGenerator<StreamEvent>;
}

/** Minimal TraceStore interface for dependency injection. */
export interface TraceStoreLike {
  insertSpan(span: TraceSpan): void;
  updateSpan(messageId: string, update: Partial<TraceSpan>): void;
}

/** Minimal PulseStore interface for Pulse run lifecycle updates. */
export interface PulseStoreLike {
  updateRun(runId: string, update: Record<string, unknown>): void;
}
```

**Delivery flow:**

```
deliver(subject, envelope, context?)
  ├── Check semaphore → reject with DeliveryResult if at capacity
  ├── Acquire semaphore permit
  ├── Record trace span (status: 'pending')
  ├── Resolve agent info:
  │   ├── 1. context.agent (from Mesh registry — highest priority)
  │   ├── 2. envelope metadata (from sender)
  │   └── 3. config.defaultCwd (static fallback)
  ├── Detect message type:
  │   ├── relay.system.pulse.* → parse PulseDispatchPayload, extract prompt/cwd/runId
  │   └── relay.agent.* → extract payload content, use resolved cwd
  ├── Format prompt with <relay_context> XML block
  ├── Create AbortController with timeout from envelope TTL
  ├── ensureSession() + sendMessage() via AgentManager
  ├── Stream events:
  │   ├── Collect text_delta for output summary (max 1000 chars)
  │   └── Publish each event to envelope.replyTo (if set)
  ├── Update trace span (status: 'processed')
  ├── Update Pulse run (if Pulse message) — completed/failed
  ├── Release semaphore permit
  └── Return DeliveryResult { success: true, durationMs }
```

**Error handling:**
- Semaphore full → `DeliveryResult { success: false, error: 'Adapter at capacity' }`
- TTL expired → abort session, dead letter, `DeliveryResult { success: false, deadLettered: true }`
- Session failure → dead letter with error details
- SDK errors → dead letter with SDK error info

#### Prompt Formatting

The adapter injects Relay metadata as an XML block in the system prompt, following the existing `context-builder.ts` pattern:

```xml
<relay_context>
From: relay.system.pulse.budget-monitor
Message-ID: 01JPM3K4X7E8XNBD0QKYT5RP0Z
Subject: relay.agent.finance.budget-bot
Sent: 2026-02-25T14:30:00.000Z

Budget remaining:
- Hops: 1 of 5 used
- TTL: 287 seconds remaining
- Max turns: 5

Reply to: relay.human.console.session-abc123
If you cannot complete the task within the budget, summarize what you've done and stop.
</relay_context>
```

The actual user message is the raw payload content only — not wrapped in XML. The agent sees a natural prompt with structured context, not a machine-formatted envelope dump.

### Part 4: Mesh Integration (Optional)

When `MeshCore` is available (injected at adapter startup), the `AdapterManager` enriches `AdapterContext` before calling `deliver()`:

```typescript
// In AdapterManager or AdapterRegistry deliver path
if (meshCore && subject.startsWith('relay.agent.')) {
  const agentId = extractAgentId(subject);
  const agentInfo = meshCore.getAgent(agentId);
  if (agentInfo) {
    context.agent = {
      directory: agentInfo.manifest.directory,
      runtime: agentInfo.manifest.runtime,
      manifest: agentInfo.manifest,
    };
  }
}
```

When Mesh is not available, the adapter falls back to:
1. Envelope metadata (sender may include agent directory)
2. Static config (`defaultCwd` in adapter config)

### Part 5: Server Integration Changes

#### Remove MessageReceiver

Delete `apps/server/src/services/relay/message-receiver.ts` and all references to it in:
- Server startup/initialization code
- Any imports or dependency injection

#### Update AdapterManager

The `AdapterManager` gains:
1. A built-in adapter map (telegram, webhook, claude-code)
2. Support for the `plugin` type using the plugin loader
3. `MeshCore` injection for `AdapterContext` enrichment
4. Updated `createAdapter()` becomes async for dynamic imports

```typescript
// Updated createAdapter signature
private async createAdapter(config: AdapterConfig): Promise<RelayAdapter | null> {
  switch (config.type) {
    case 'telegram':
      return new TelegramAdapter(config.id, config.config as TelegramAdapterConfig);
    case 'webhook':
      return new WebhookAdapter(config.id, config.config as WebhookAdapterConfig);
    case 'claude-code':
      return new ClaudeCodeAdapter(config.id, {
        ...config.config,
        agentManager: this.agentManager,
        traceStore: this.traceStore,
        pulseStore: this.pulseStore,
      });
    case 'plugin':
      return this.loadPlugin(config);
    default:
      logger.warn(`[AdapterManager] Unknown adapter type: ${config.type}`);
      return null;
  }
}
```

#### Default adapters.json

When no `~/.dork/relay/adapters.json` exists and Relay is enabled, the server creates a default config with `claude-code` enabled:

```json
{
  "adapters": [
    {
      "id": "claude-code",
      "type": "claude-code",
      "builtin": true,
      "enabled": true,
      "config": {
        "maxConcurrent": 3,
        "defaultTimeoutMs": 300000
      }
    }
  ]
}
```

## Data Flow: End-to-End

### Agent Message Flow

```
1. Client/Pulse/Agent publishes to relay.agent.finance.budget-bot
2. RelayCore routes message through pipeline (budget, rate limit, circuit breaker)
3. RelayCore calls AdapterRegistry.deliver(subject, envelope)
4. AdapterRegistry matches ClaudeCodeAdapter (subjectPrefix: 'relay.agent.')
5. (Optional) AdapterManager enriches AdapterContext with Mesh agent info
6. ClaudeCodeAdapter.deliver() is called:
   a. Check semaphore (reject if at capacity)
   b. Record trace span
   c. Resolve agent directory (context.agent → envelope metadata → defaultCwd)
   d. Format prompt with <relay_context> XML block
   e. AgentManager.sendMessage(sessionId, prompt, { cwd: agentDir })
   f. Stream events → publish to envelope.replyTo
   g. Record trace completion
   h. Return DeliveryResult
```

### Plugin Loading Flow

```
1. Server starts, AdapterManager.initialize() called
2. Read ~/.dork/relay/adapters.json
3. For each enabled adapter entry:
   a. type: 'telegram' | 'webhook' | 'claude-code' → built-in constructor
   b. type: 'plugin' + plugin.package → import(packageName), validate, create
   c. type: 'plugin' + plugin.path → import(pathToFileURL(path)), validate, create
4. For each loaded adapter: registry.register(adapter) → adapter.start(relay)
5. Log success/failure for each adapter
6. On shutdown: registry.shutdown() → adapter.stop() in reverse order
```

## User Experience

This feature has no direct UI changes. It affects:

1. **Agent developers** — agents can now receive Relay messages with rich context (sender, budget, reply instructions) formatted as natural prompts
2. **Plugin developers** — can create and distribute adapter packages (`dorkos-relay-slack`, etc.) using a simple factory function pattern
3. **Server operators** — configure adapters via `~/.dork/relay/adapters.json`

## Testing Strategy

### Unit Tests

**`packages/relay/src/adapters/__tests__/claude-code-adapter.test.ts`:**
- Delivers agent message → calls AgentManager with correct cwd and formatted prompt
- Formats `<relay_context>` XML block with sender, budget, reply-to
- Enforces concurrency semaphore — rejects when at capacity
- Handles Pulse dispatch messages — validates payload, updates PulseStore lifecycle
- Derives session timeout from envelope TTL budget
- Publishes response events to `envelope.replyTo`
- Creates dead letter on session failure/timeout
- Records trace spans through delivery lifecycle (pending → delivered → processed)
- Works without Mesh (uses envelope metadata for agent directory)
- Works with Mesh (uses context.agent from enriched AdapterContext)

**`packages/relay/src/__tests__/adapter-plugin-loader.test.ts`:**
- Loads built-in adapters from provided map
- Loads plugin from npm package name (mock dynamic import)
- Loads plugin from local file path (mock dynamic import)
- Resolves relative paths against config directory
- Duck-type validates loaded module has required methods
- Returns empty adapter for modules without default export (non-fatal)
- Skips disabled entries
- Continues loading after individual failures

**`packages/relay/src/__tests__/adapter-registry.test.ts`:**
- (Existing tests) Verify deliver() passes AdapterContext through to matched adapter

**`apps/server/src/services/relay/__tests__/adapter-manager.test.ts`:**
- (Existing tests) Updated for async createAdapter and new config types
- Creates ClaudeCodeAdapter from 'claude-code' config type
- Creates plugin adapter from 'plugin' config type
- Enriches AdapterContext with Mesh agent info when MeshCore available
- Falls back gracefully when MeshCore is not available
- Generates default adapters.json when config file doesn't exist

### Mocking Strategy

- Mock `AgentManagerLike` interface (same pattern as existing `message-receiver.test.ts`)
- Mock `TraceStoreLike` interface for trace span assertions
- Mock `PulseStoreLike` for Pulse run lifecycle assertions
- Mock `dynamic import()` for plugin loader tests (vi.mock at module level)
- Mock `MeshCore.getAgent()` for Mesh integration tests

### Test Documentation

Each test includes a purpose comment explaining the specific behavior being validated and why it matters for the adapter system's reliability.

## Performance Considerations

- **Semaphore concurrency** — `maxConcurrent: 3` default prevents resource exhaustion from too many simultaneous Agent SDK sessions (each is heavyweight — runs a Claude Code process)
- **Plugin loading at startup only** — No runtime import() calls; adapter code is loaded once and cached
- **Response streaming** — Events are published to replyTo as they arrive, not buffered (same pattern as existing MessageReceiver)
- **Trace recording** — Uses existing SQLite TraceStore with WAL mode (same performance characteristics)

## Security Considerations

- **Dynamic import paths** — Local file paths in `plugin.path` are resolved against the config directory. No path traversal validation is needed since this is server-side config managed by the user (same trust model as `adapters.json`)
- **npm package loading** — Relies on npm's security model. Only packages explicitly listed in `adapters.json` are loaded
- **Adapter config secrets** — `adapters.json` lives in `~/.dork/relay/` which has user-only permissions (created by the server with appropriate mode)
- **Agent budget enforcement** — The adapter maps `callBudgetRemaining` to SDK `maxTurns` so the agent respects the Relay budget; TTL is enforced via AbortController timeout

## Documentation

- Update `contributing/architecture.md` — add adapter system section describing the unified interface, plugin loading, and Claude Code adapter
- Document `~/.dork/relay/adapters.json` config format in `contributing/configuration.md`
- Add "Building a Relay Adapter" section to `docs/` for third-party developers (factory function pattern, config schema, testing)
- Update the CLAUDE.md adapter-related service descriptions

## Implementation Phases

### Phase 1: Interface Extension & Adapter Refactor

1. Add `AdapterContext`, `DeliveryResult` types to `packages/relay/src/types.ts`
2. Update `RelayAdapter.deliver()` signature (context optional, returns DeliveryResult)
3. Update `AdapterRegistryLike.deliver()` and `AdapterRegistry.deliver()` to pass context
4. Refactor `TelegramAdapter.deliver()` and `WebhookAdapter.deliver()` to match new signature (return `DeliveryResult`, accept optional `context`)
5. Extend `AdapterConfigSchema` in `relay-schemas.ts` with `'claude-code'`, `'plugin'` types and `plugin` field
6. Export new types from `packages/relay/src/index.ts`
7. Verify all existing adapter tests pass

### Phase 2: Plugin Loader

1. Implement `adapter-plugin-loader.ts` in `packages/relay/src/`
2. Duck-type validation for loaded modules
3. Support for npm packages (`import(packageName)`) and local files (`import(pathToFileURL)`)
4. Export from `packages/relay/src/index.ts`
5. Write plugin loader tests with mocked dynamic imports

### Phase 3: Claude Code Adapter

1. Implement `ClaudeCodeAdapter` in `packages/relay/src/adapters/claude-code-adapter.ts`
2. Port logic from `MessageReceiver` — agent message handling, Pulse dispatch, trace recording, response publishing
3. Add semaphore concurrency control
4. Add `<relay_context>` prompt formatting
5. Add budget-aware timeout via AbortController
6. Write comprehensive adapter tests

### Phase 4: Server Integration

1. Update `AdapterManager.createAdapter()` to handle `'claude-code'` and `'plugin'` types
2. Inject `AgentManagerLike`, `TraceStore`, `PulseStore` into `AdapterManager` for `ClaudeCodeAdapter` construction
3. Add optional `MeshCore` injection for `AdapterContext` enrichment
4. Generate default `adapters.json` with `claude-code` enabled when Relay is enabled and no config exists
5. Remove `MessageReceiver` — delete file and all imports/references
6. Update server startup to use adapter-based dispatch instead of MessageReceiver
7. Verify end-to-end: publish to `relay.agent.*` → ClaudeCodeAdapter delivers → agent responds → response published to replyTo

## Open Questions

No unresolved questions — all key decisions were made during ideation (see Section 6 of `specs/relay-runtime-adapters/01-ideation.md`).

## Related ADRs

- **ADR-0020**: Adapter Registry with Promise.allSettled — established the error isolation pattern used by AdapterRegistry
- **ADR-0019**: Use grammY for Telegram Adapter — established Telegram adapter implementation
- **ADR-0018**: Server-Side SSE Subject Filtering — Relay SSE streaming pattern
- **ADR-0011**: Use NATS-Style Subject Matching — the subject pattern matching that adapters use
- **ADR-0016**: Structured PublishResult Rejections — DeliveryResult follows the same structured rejection pattern

## References

- Ideation: `specs/relay-runtime-adapters/01-ideation.md`
- Research: `research/20260225_relay_runtime_adapters.md`
- Relay Spec 6 Plan: `plans/relay-specs/06-relay-runtime-adapters.md`
- Relay Litepaper: `meta/modules/relay-litepaper.md` — "Adapters: Bridging Relay to Everything"
- Mesh Litepaper: `meta/modules/mesh-litepaper.md` — agent manifest format
- NATS Connector Framework: https://nats.io/blog/nats-connector-framework/
- Kafka Connect Connector Development: https://kafka.apache.org/41/kafka-connect/connector-development-guide/
- Vite Plugin API: https://vite.dev/guide/api-plugin
