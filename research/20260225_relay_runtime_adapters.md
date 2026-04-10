---
title: 'Relay Runtime Adapters — Unified Adapter System & ClaudeCodeAdapter'
date: 2026-02-25
type: internal-architecture
status: archived
tags: [relay, adapters, claude-code-adapter, binding-router, plugin]
feature_slug: relay-runtime-adapters
---

# Research: Relay Runtime Adapters — Unified Adapter System & Claude Code Runtime Adapter

**Date:** 2026-02-25
**Feature Slug:** relay-runtime-adapters
**Research Depth:** Deep

---

## Research Summary

This spec has two intertwined goals: (1) unify the existing `RelayAdapter` interface so it works for both external (Telegram, webhook) and runtime (Claude Code) adapters, and (2) add a plugin loading mechanism for npm/local third-party adapters. The codebase already has a well-formed `RelayAdapter` interface in `packages/relay/src/types.ts` that the Telegram and webhook adapters implement. The primary gaps are: the `deliver()` signature lacks an `AdapterContext` parameter (needed for runtime adapters to receive agent info), the `AdapterManager` only supports built-in `type: 'telegram' | 'webhook'` configs (no dynamic import), and the Claude Code runtime adapter itself doesn't exist yet.

The recommended approach models Kafka Connect's clean `Connector + Task` separation — a self-describing adapter interface with a `deliver()` method that receives full context — combined with the Vite/ESLint ecosystem's factory function export pattern for plugin loading.

---

## Key Findings

### 1. The Existing Interface is 90% There

`packages/relay/src/types.ts` already defines `RelayAdapter` with:

- `id`, `subjectPrefix`, `displayName`
- `start(relay: RelayPublisher): Promise<void>`
- `stop(): Promise<void>`
- `deliver(subject: string, envelope: RelayEnvelope): Promise<void>`
- `getStatus(): AdapterStatus`

The only change needed for runtime adapters is adding an optional `AdapterContext` to `deliver()`:

```typescript
deliver(subject: string, envelope: RelayEnvelope, context?: AdapterContext): Promise<DeliveryResult>
```

`AdapterContext` carries agent metadata (directory, runtime, manifest from Mesh) that runtime adapters need but external adapters can ignore.

The return type should change from `void` to `DeliveryResult` so the adapter can report success/failure/dead-letter without knowing about RelayCore internals.

### 2. Plugin Loading: Dynamic Import is the Right Pattern

Node.js `import()` works well for plugin loading in ESM environments. The key patterns:

**For npm packages:** Use `import(packageName)` directly — Node resolves from the CWD/node_modules. Works in ESM without `createRequire`.

**For local paths:** Use `import(pathToFileURL(absolutePath).href)` to convert a filesystem path to a file URL, which is required for ESM dynamic imports of local `.js` files.

**Validation after import:** Use Zod or duck-type checking to verify the loaded module has the expected shape before calling any methods. Fail loudly with a descriptive error if the contract isn't satisfied.

**Security:** Node.js dynamic import does NOT sandbox the loaded code — plugins run with full process privileges. The right mitigation is documentation (warn plugin authors), not VM sandboxing (which is complex and leaky). Vite, ESLint, and Grafana all take this approach.

**Error isolation:** Wrap each `import()` in try/catch. A missing package throws `ERR_MODULE_NOT_FOUND`; an invalid export is caught after Zod validation. Adapter loading failures are non-fatal (log and continue).

### 3. Adapter/Plugin Interfaces in Messaging Systems

**NATS Connector Framework** uses a Java `NATSConnectorPlugin` interface with lifecycle callbacks: `onStartup()`, `onNatsInitialized()`, `onNATSMessage()`, `onNATSEvent()`, `onShutdown()`. The framework handles infrastructure; the plugin implements domain logic. This maps well to DorkOS's `start()/stop()/deliver()` lifecycle.

**Kafka Connect** separates the `Connector` (self-describes, validates config, creates Tasks) from the `Task` (actually copies data). Key insight: connectors are self-describing — they declare their config schema and the framework validates it. DorkOS should have adapters declare a config schema (Zod) so `AdapterManager` can validate before instantiating.

**RabbitMQ** uses Erlang `behaviour` callbacks (`init/1`, `description/0`, `intercept/3`, `applies_to/0`) and a central `rabbit_registry` for registration/unregistration. The registry pattern mirrors DorkOS's `AdapterRegistry`.

**Grafana** loads frontend plugins via SystemJS and backend plugins as gRPC binaries. For DorkOS the analogy is: built-in adapters are first-class, third-party adapters are loaded via `dynamic import()`. Grafana's plugin lifecycle (install → load → initialize → start) maps to DorkOS's `import() → validate → new Adapter(config) → registry.register()`.

**Common patterns across all systems:**

1. A single interface/behaviour contract (not multiple)
2. Lifecycle hooks: start, stop, deliver/receive
3. Self-description: id, name, config schema
4. Registry pattern for runtime management
5. Hot-reload via config file watch + re-registration

### 4. Agent SDK Session Management

From the official SDK docs (`@anthropic-ai/claude-agent-sdk`):

**Creating isolated sessions:** Call `query({ prompt, options: { cwd, maxTurns, permissionMode } })` — no explicit session creation step. The SDK auto-creates a session and returns the `session_id` in the first `system/init` message.

**Streaming and collecting output:** Iterate the returned async generator. `SDKAssistantMessage` events carry text content blocks. `SDKResultMessage` carries the final `result` string, cost, and duration. The Claude Code adapter should:

1. Collect `text_delta` events from `stream_event` messages (via `includePartialMessages: true`) for progress
2. Read `SDKResultMessage.result` for the final output to publish back to Relay

**Concurrency:** Multiple `query()` calls can run simultaneously. Each call creates its own sub-process. Throttle via a semaphore in the adapter's `deliver()` implementation (reject with dead-letter if at capacity).

**Timeouts and cancellation:** Pass an `AbortController` in `options.abortController`. Set a `setTimeout` that calls `controller.abort()`. The generator will stop yielding and the session terminates. This matches the TTL budget pattern already used in `MessageReceiver`.

**Error recovery:** `SDKResultMessage` with `subtype: 'error_max_turns'` or `'error_during_execution'` signals failure. Wrap the generator iteration in try/catch for process-level errors (spawn failures). On any error, create a dead-letter entry.

**Key options for the Claude Code adapter:**

```typescript
query({
  prompt: formattedMessage,
  options: {
    cwd: agentDirectory,
    resume: existingSessionId, // if resuming
    permissionMode: 'bypassPermissions', // for autonomous relay dispatch
    maxTurns: budget.callBudget, // self-limit via budget
    abortController: controller, // for TTL-based timeout
    settingSources: ['project'], // load AGENTS.md from agent dir
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: relayContextBlock, // inject relay context
    },
  },
});
```

### 5. Prompt Formatting for Inter-Agent Communication

The codebase already uses XML blocks for structured context injection (`context-builder.ts` produces `<env>` and `<git_status>` blocks). The Claude Code adapter should follow the same pattern.

**Natural language framing principle:** The agent receives a message that reads like a human wrote it, not a raw envelope dump. Structured metadata goes in XML blocks appended to the system prompt (not the user message).

**Recommended format for the user message (the "prompt"):**

```
{message.content}
```

Just the content. No wrapper. The agent should experience this as a direct instruction.

**Recommended system prompt append (`<relay_context>` block):**

```xml
<relay_context>
From: {envelope.from} (agent/system/human)
Message ID: {envelope.id}
Subject: {envelope.subject}
Sent: {new Date(envelope.budget.sentAt).toISOString()}

Budget:
- Hops used: {envelope.budget.hopCount} of {maxHops}
- TTL remaining: {Math.round(ttlRemainingMs / 1000)}s
- Call budget: {envelope.budget.callBudget} turns remaining

Reply instructions: Publish your response to {envelope.replyTo ?? "no reply required"}.
If you cannot complete this in {callBudget} turns, say so and stop.
</relay_context>
```

This pattern is validated by:

- Model Context Protocol (MCP) structured JSON-RPC exchanges for context
- Agent Communication Protocol (ACP) MIME-type extensibility
- Microsoft multi-agent reference architecture (structured metadata + natural instruction separation)

**Request-response correlation:** The existing `envelope.id` and `envelope.replyTo` pattern is already correct. When publishing back, include `messageId: envelope.id` in the response payload. The sender correlates via this ID. This is the standard pub/sub reply-subject correlation pattern (NATS uses the same approach).

### 6. npm Plugin Conventions

**Naming convention:** `{host}-{type}-{name}` — e.g., `dorkos-relay-slack`, `dorkos-relay-opencode`. The host prefix (`dorkos-`) makes packages discoverable via npm search. This is the pattern used by ESLint (`eslint-plugin-*`), Vite (`vite-plugin-*`), Babel (`babel-plugin-*`).

**Export pattern:** Factory function as default export. The factory accepts config and returns an adapter instance:

```typescript
// dorkos-relay-slack/index.js
export default function createSlackAdapter(config) {
  return new SlackAdapter(config);
}
```

This matches the Vite/Rollup convention (`export default function myPlugin(options) { return { ... } }`).

**No named `createPlugin` convention is standard** — use `export default` with a descriptive function name.

**Config schema declaration:** The factory should also export a Zod schema as a named export so `AdapterManager` can validate config before instantiating:

```typescript
export { SlackAdapterConfigSchema } from './config-schema.js';
export default createSlackAdapter;
```

**Plugin discovery:** No standard npm discovery mechanism exists (unlike some ecosystems). DorkOS should use explicit config (`adapters.json`) rather than auto-discovery. This is the approach used by Grafana (plugins directory), ESLint (explicit config array), and Vite (explicit plugin array). Auto-discovery based on `peerDependencies` or npm keywords is fragile and slow.

**Package `exports` field:** Third-party adapters should use a simple `exports` field:

```json
{
  "exports": {
    ".": "./dist/index.js"
  },
  "type": "module"
}
```

---

## Detailed Analysis

### The Unified Interface Delta

The current `RelayAdapter` in `types.ts` needs two targeted changes:

**Change 1 — Add `AdapterContext` to `deliver()`:**

```typescript
export interface AdapterContext {
  /** Agent directory from Mesh registry or message metadata. */
  agentDirectory?: string;
  /** Agent runtime type from manifest (e.g., 'claude-code', 'codex'). */
  runtime?: string;
  /** Full agent manifest if available from Mesh. */
  manifest?: AgentManifest;
  /** Platform info for external adapters (e.g., Telegram chat metadata). */
  platform?: Record<string, unknown>;
}

export interface DeliveryResult {
  status: 'delivered' | 'failed' | 'dead_lettered';
  reason?: string;
  /** For runtime adapters: the agent's response text. */
  responseText?: string;
  /** For runtime adapters: the session ID used. */
  sessionId?: string;
}
```

**Change 2 — Update `deliver()` signature:**

```typescript
deliver(subject: string, envelope: RelayEnvelope, context?: AdapterContext): Promise<DeliveryResult>;
```

External adapters (Telegram, webhook) ignore `context` and return `{ status: 'delivered' }`. Runtime adapters use `context` to find the agent and return the session result.

**Change 3 — Add `subjectPattern` alongside `subjectPrefix`:**

The spec asks for `subjectPattern` (e.g., `"relay.agent.>"`) for runtime adapters. External adapters use `subjectPrefix` for prefix matching. These are different matching strategies. The cleanest approach: keep `subjectPrefix` on the interface but allow `"relay.agent"` as the prefix for the Claude Code adapter (which matches all `relay.agent.*` subjects via the existing `startsWith` check in `AdapterRegistry.getBySubject()`). No breaking change needed.

### Plugin Loader Design

The plugin loader sits inside `AdapterManager` and extends `createAdapter()`. Current `createAdapter()` is a switch/case on `config.type`. The extension:

```typescript
// Current AdapterConfig in types.ts needs to expand:
export interface AdapterConfig {
  id: string;
  type: 'telegram' | 'webhook' | 'claude-code'; // built-in types
  package?: string; // npm package name for third-party
  path?: string; // local file path for dev/custom
  enabled: boolean;
  config: unknown; // adapter-specific config, validated by adapter's schema
}
```

Loading logic in `AdapterManager.createAdapter()`:

```typescript
private async createAdapter(config: AdapterConfig): Promise<RelayAdapter | null> {
  // 1. Built-in adapters
  if (!config.package && !config.path) {
    return this.createBuiltinAdapter(config);
  }

  // 2. npm package
  if (config.package) {
    return this.loadPackageAdapter(config.package, config);
  }

  // 3. Local file path
  if (config.path) {
    const absPath = path.resolve(config.path);
    return this.loadFileAdapter(absPath, config);
  }

  return null;
}

private async loadPackageAdapter(packageName: string, config: AdapterConfig): Promise<RelayAdapter | null> {
  try {
    const mod = await import(packageName);
    return this.instantiateFromModule(mod, config);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
      logger.error(`[AdapterManager] Package not found: '${packageName}'. Install it with: npm install ${packageName}`);
    } else {
      logger.error(`[AdapterManager] Failed to load package '${packageName}':`, err);
    }
    return null;
  }
}

private async loadFileAdapter(absPath: string, config: AdapterConfig): Promise<RelayAdapter | null> {
  try {
    const { pathToFileURL } = await import('node:url');
    const mod = await import(pathToFileURL(absPath).href);
    return this.instantiateFromModule(mod, config);
  } catch (err) {
    logger.error(`[AdapterManager] Failed to load local adapter at '${absPath}':`, err);
    return null;
  }
}

private instantiateFromModule(mod: unknown, config: AdapterConfig): RelayAdapter | null {
  // Expect: default export is a factory function or a class
  const factory = (mod as Record<string, unknown>).default;
  if (typeof factory !== 'function') {
    logger.error(`[AdapterManager] Module does not export a default function`);
    return null;
  }

  const adapter = factory(config.config);

  // Duck-type validate RelayAdapter interface
  if (!isRelayAdapter(adapter)) {
    logger.error(`[AdapterManager] Module's default export did not return a valid RelayAdapter`);
    return null;
  }

  return adapter;
}

function isRelayAdapter(obj: unknown): obj is RelayAdapter {
  if (!obj || typeof obj !== 'object') return false;
  const a = obj as Record<string, unknown>;
  return (
    typeof a.id === 'string' &&
    typeof a.subjectPrefix === 'string' &&
    typeof a.start === 'function' &&
    typeof a.stop === 'function' &&
    typeof a.deliver === 'function' &&
    typeof a.getStatus === 'function'
  );
}
```

Note: `createAdapter()` becomes `async` — this is a breaking change to the internal method signature but not to the public API.

### Claude Code Adapter Design

The adapter lives at `packages/relay/src/adapters/claude-code-adapter.ts`. It is a built-in adapter registered under `type: 'claude-code'`.

**Key design decisions:**

1. **The adapter wraps `AgentManagerLike`** (the same interface already defined in `message-receiver.ts`) rather than importing `AgentManager` directly. This keeps `packages/relay` decoupled from `apps/server`.

2. **The adapter is injected with its dependencies** via constructor: `agentManager`, `defaultCwd`, and optional `meshCore`. The `AdapterManager` in `apps/server` instantiates it with these dependencies.

3. **Concurrency control:** A simple counter `activeCount` against `config.maxConcurrent` (default 3). If at capacity, return `DeliveryResult.status = 'dead_lettered'` with reason `'max_concurrent_exceeded'`.

4. **Session reuse vs. fresh sessions:** For `relay.agent.{sessionId}` subjects, use the `sessionId` from the subject as the SDK resume ID (matching the existing `MessageReceiver` pattern). For `relay.agent.{project}.{agentId}` subjects, derive the session ID from the agent ID.

5. **Prompt formatting:** The `envelope.payload` content goes directly as the user prompt. Relay metadata goes in a `<relay_context>` XML block appended to the system prompt via `systemPrompt.append`.

**Coexistence with MessageReceiver:** The existing `MessageReceiver` subscribes to `relay.agent.>` via `relayCore.subscribe()`. The Claude Code adapter also handles `relay.agent.>` but via the `AdapterRegistry` deliver path. These are separate code paths:

- When Relay is enabled AND the Claude Code adapter is registered: messages go through the adapter's `deliver()` method (called by `AdapterRegistry.deliver()` from `RelayCore`)
- `MessageReceiver` should be disabled/not started when the Claude Code adapter is active, to avoid double-processing

This is a coordination concern the spec should address. Options:

- Option A: Replace `MessageReceiver` entirely with the Claude Code adapter (cleaner)
- Option B: The adapter's `subjectPrefix` takes priority over `MessageReceiver`'s subscription
- Option C: `MessageReceiver` checks if the Claude Code adapter is registered and skips if so

**Option A is strongly recommended.** The Claude Code adapter IS the MessageReceiver's successor for the `relay.agent.>` path. Keep `MessageReceiver` for Pulse dispatch (`relay.system.pulse.>`) which the adapter doesn't handle.

### adapters.json Config Schema

```json
{
  "adapters": [
    {
      "id": "claude-code",
      "type": "claude-code",
      "enabled": true,
      "config": {
        "maxConcurrent": 3,
        "timeoutMs": 300000,
        "defaultPermissionMode": "bypassPermissions"
      }
    },
    {
      "id": "telegram-main",
      "type": "telegram",
      "enabled": false,
      "config": { "token": "...", "mode": "polling" }
    },
    {
      "id": "slack-workspace",
      "package": "dorkos-relay-slack",
      "enabled": true,
      "config": { "token": "xoxb-..." }
    },
    {
      "id": "my-custom",
      "path": "./adapters/my-adapter.js",
      "enabled": true,
      "config": {}
    }
  ]
}
```

The Zod schema (`AdaptersConfigFileSchema` in `packages/shared/relay-schemas.ts`) needs to be updated to allow `package` and `path` fields alongside `type`.

---

## Research Gaps & Limitations

- **ESM import() in esbuild bundles:** The CLI build uses esbuild. Dynamic `import()` of npm packages from within an esbuild bundle may not resolve correctly if node_modules is not on the path. This needs testing. The workaround is `createRequire(import.meta.url)(packageName)` for CJS packages, but ESM-only packages require `import()`.

- **Windows path handling:** `pathToFileURL()` is necessary on Windows where absolute paths start with a drive letter. The codebase runs on macOS/Linux primarily, but worth documenting.

- **Plugin security:** No sandboxing of third-party adapter code. This is consistent with how all major plugin ecosystems (Vite, ESLint, Grafana) handle it — trust is implicit when users install npm packages. Document this clearly.

- **Hot-reload and dynamic imports:** Node.js caches modules after the first `import()`. Hot-reloading a local adapter file requires cache busting (append a timestamp query param to the URL, or restart the server). This is a known limitation. For v1, document that hot-reload of local adapters requires server restart; npm package adapters must bump their version.

---

## Contradictions & Disputes

- **`MessageReceiver` vs. Claude Code Adapter overlap:** Both handle `relay.agent.>`. The spec says the Claude Code adapter "coexists" with direct AgentManager usage. But if both `MessageReceiver` and the Claude Code adapter subscribe to `relay.agent.>`, messages will be double-processed. The spec needs to clarify which takes precedence. **Recommendation:** the Claude Code adapter replaces the `relay.agent.>` subscription in `MessageReceiver`. `MessageReceiver` keeps the `relay.system.pulse.>` subscription only.

- **`subjectPattern` vs. `subjectPrefix`:** The spec says `subjectPattern: "relay.agent.>"` (NATS-style wildcard). The existing interface uses `subjectPrefix: string` with `startsWith()` matching. These are semantically different — `startsWith("relay.agent")` matches `relay.agent.finance.budget-bot` correctly but also matches `relay.agentless.something` incorrectly. The codebase's subject conventions use dots as separators, so `startsWith("relay.agent.")` (with trailing dot) is the right prefix. The spec's wildcard notation is aspirational — the implementation should use prefix matching with a trailing dot, not actual glob matching.

---

## Search Methodology

- Number of searches performed: 10 web searches + 6 page fetches + 10 file reads
- Most productive search terms: "Claude Agent SDK sessions TypeScript", "Node.js dynamic import plugin loading", "NATS connector framework interface", "Kafka Connect connector lifecycle"
- Primary information sources: Anthropic SDK docs (platform.claude.com), existing codebase (`packages/relay/src/types.ts`, `adapter-registry.ts`, `adapter-manager.ts`, `message-receiver.ts`, `context-builder.ts`), NATS connector docs, Kafka Connect docs

---

## RESEARCH FINDINGS

### Plugin Loading Patterns

**Recommended approach: `dynamic import()` with duck-type validation**

| Approach                                              | Pros                         | Cons                                                             |
| ----------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------- |
| `import(packageName)` for npm                         | Standard ESM, no wrappers    | Module cache means no hot-reload; esbuild bundling may need care |
| `import(pathToFileURL(absPath).href)` for local files | Works in ESM, cross-platform | Same cache limitation                                            |
| `createRequire()` + `require()`                       | Works for CJS packages       | Doesn't work for ESM-only packages; feels like a workaround      |
| VM sandboxing                                         | True isolation               | Complex, leaky, not what any major ecosystem does                |

**Implementation pattern:**

```typescript
// npm package
const mod = await import(packageName);

// local file (ESM-safe)
const { pathToFileURL } = await import('node:url');
const mod = await import(pathToFileURL(absolutePath).href);

// Validate interface after import (duck-typing, not Zod — faster, no dep)
function isRelayAdapter(obj): obj is RelayAdapter { ... }
```

**Error handling:**

- `ERR_MODULE_NOT_FOUND` → log "Package not found, install with npm install {name}"
- Export validation failure → log "Module does not export a valid RelayAdapter"
- Both are non-fatal: log and skip the adapter

### Adapter Interfaces in Messaging Systems

**Common patterns from NATS, Kafka, RabbitMQ, Grafana:**

1. **Single lifecycle interface** — all systems use one interface (not separate interfaces for different adapter types). DorkOS already has this with `RelayAdapter`.

2. **`start(infrastructure)` inversion** — the adapter receives the infrastructure handle at `start()` time, not at construction. This is the NATS pattern. DorkOS already does this: `start(relay: RelayPublisher)`.

3. **Self-description** — Kafka connectors declare their config schema; Grafana plugins declare their metadata. DorkOS adapters should export a `configSchema` (Zod) as a named export.

4. **Registry pattern** — RabbitMQ's `rabbit_registry`, DorkOS's `AdapterRegistry`. Already implemented.

5. **Non-fatal startup failures** — all systems continue loading other adapters when one fails. Already implemented in `AdapterManager.startEnabledAdapters()`.

**The one gap:** Kafka Connect has a `validate()` method on connectors that returns config errors. DorkOS adapters should declare their Zod config schema so `AdapterManager` can validate before instantiation.

### Agent SDK Session Management

From official Anthropic docs + existing `MessageReceiver` patterns:

- **Isolated sessions:** `query({ prompt, options: { cwd, resume, permissionMode } })` — no pre-creation needed
- **Capture final output:** Read `SDKResultMessage.result` (the SDK aggregates it)
- **Capture streaming:** Set `includePartialMessages: true`, filter `stream_event` messages
- **Timeout:** `AbortController` injected via `options.abortController`, `setTimeout` triggers `abort()`
- **Error detection:** `SDKResultMessage.subtype` is `'error_*'` variants
- **Concurrency:** Multiple `query()` calls are independent; use a counter semaphore in the adapter
- **Session context:** `options.settingSources: ['project']` loads `AGENTS.md` from agent `cwd`
- **Budget enforcement:** Pass `options.maxTurns: envelope.budget.callBudget` to honor the relay budget

### Prompt Formatting

**Structure:**

- **User message:** The raw message content only. Clean, natural, no metadata wrappers.
- **System prompt append:** XML `<relay_context>` block with sender identity, budget, reply instructions
- **Agent directive:** "If you cannot complete this in N turns, say so and stop early" — this is the key inter-agent protocol instruction

**Example `<relay_context>` block:**

```xml
<relay_context>
From: relay.system.pulse.budget-monitor
Message-ID: 01JPM3K4X7E8XNBD0QKYT5RP0Z
Subject: relay.agent.finance.budget-bot
Sent: 2026-02-25T14:30:00.000Z

Budget remaining:
- Hops: 1 of 5 used
- TTL: 287 seconds
- Max turns: 5

Reply to: relay.human.console.session-abc123
If you cannot complete the task within the budget, summarize what you've done and stop.
</relay_context>
```

This pattern follows what the codebase already does in `context-builder.ts` for `<env>` and `<git_status>` blocks.

### npm Plugin Conventions

| Convention     | Recommendation                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| Package name   | `dorkos-relay-{channel}` (e.g., `dorkos-relay-slack`)                                                      |
| Default export | Factory function: `export default function create{Name}Adapter(config) { return new ...Adapter(config); }` |
| Named exports  | Config schema: `export { SlackAdapterConfigSchema }`                                                       |
| `type` field   | `"module"` in `package.json` — ESM-only                                                                    |
| Main entry     | `"exports": { ".": "./dist/index.js" }`                                                                    |
| No discovery   | Explicit config in `adapters.json` — no auto-discovery via npm keywords                                    |

---

### Recommendation

**Recommended Approach:** Extend the existing `RelayAdapter` interface with `AdapterContext` and `DeliveryResult`, extend `AdapterManager.createAdapter()` to support `package` and `path` fields via dynamic import, and implement `ClaudeCodeAdapter` as a built-in adapter that wraps `AgentManagerLike`.

**Rationale:**

1. The codebase already has 90% of the infrastructure (`RelayAdapter`, `AdapterRegistry`, `AdapterManager`). Minimal changes achieve the spec's goals.
2. The `AgentManagerLike` interface (already in `message-receiver.ts`) is the right abstraction for the Claude Code adapter — it decouples `packages/relay` from `apps/server`.
3. Dynamic `import()` is the correct modern Node.js pattern for plugin loading. No additional packages needed.
4. The existing `AdapterManager` + `AdapterRegistry` lifecycle (register → start → hot-reload → stop) is sound and matches what all major messaging systems do.
5. XML system prompt blocks match the existing `context-builder.ts` pattern — no new conventions introduced.

**Caveats:**

1. `MessageReceiver`'s `relay.agent.>` subscription must be disabled when the Claude Code adapter is active to prevent double-processing. Either gate `MessageReceiver` startup on whether the Claude Code adapter is registered, or refactor `MessageReceiver` to only handle `relay.system.pulse.>`.
2. `createAdapter()` in `AdapterManager` must become `async` to support dynamic imports — a minor internal refactor.
3. The `AdapterConfig` Zod schema in `packages/shared/relay-schemas.ts` must be updated to allow `package?: string` and `path?: string` as alternatives to `type`.
4. ESM module caching means hot-reload of local file adapters requires a server restart. Document this limitation.
5. `pathToFileURL` is required for local path imports in ESM. Import from `node:url` (built-in, no dependency).
