---
title: "Relay Runtime Adapters — Plugin System Design (v1)"
date: 2026-02-24
type: internal-architecture
status: superseded
superseded_by: research/20260225_relay_runtime_adapters.md
tags: [relay, adapters, plugin, dynamic-import, factory]
feature_slug: relay-runtime-adapters
---

# Research: Relay Runtime Adapters — Plugin System Design

**Feature**: relay-runtime-adapters
**Date**: 2026-02-24
**Research Depth**: Deep
**Searches Performed**: 14
**Sources Found**: 22

---

## Research Summary

This report investigates the design space for unifying Relay's adapter system under a single `RelayAdapter` interface that serves both external channel adapters (Telegram, webhooks) and runtime adapters (Claude Code). The current codebase already has a well-designed `RelayAdapter` interface and `AdapterRegistry`. The primary new requirements are: (1) extending `RelayAdapter` to cover the runtime adapter use case without breaking the external adapter pattern, (2) building the Claude Code runtime adapter that bridges Relay messages to Agent SDK sessions, and (3) adding plugin loading so third-party adapters can be distributed as npm packages.

Key finding: the existing `RelayAdapter` interface is already mostly sufficient. The cleanest path is a **thin interface extension** for runtime adapters rather than a separate hierarchy, combined with **config-driven dynamic `import()`** for third-party plugins validated via Zod duck-typing.

---

## Key Findings

### 1. Existing Interface Is a Strong Foundation

The current `RelayAdapter` interface in `packages/relay/src/types.ts` defines:

```typescript
interface RelayAdapter {
  readonly id: string;
  readonly subjectPrefix: string;
  readonly displayName: string;
  start(relay: RelayPublisher): Promise<void>;
  stop(): Promise<void>;
  deliver(subject: string, envelope: RelayEnvelope): Promise<void>;
  getStatus(): AdapterStatus;
}
```

This is structurally identical to Moleculer's transporter interface (`connect`, `disconnect`, `subscribe`, `send`) and Vite's plugin pattern (factory function returning named object with lifecycle hooks). The `deliver` method is the key differentiation point: external adapters send to external channels, runtime adapters dispatch to in-process agent sessions. The interface shape does not need to change — only the semantics of `deliver` differ.

### 2. Plugin Loading: Dynamic `import()` Is the Right Primitive

Node.js ESM dynamic `import()` is the only correct primitive for loading third-party adapter packages at runtime in a modern TypeScript/ESM codebase like DorkOS. The project already uses `NodeNext` module resolution and ESM throughout the server.

Key behaviors:
- `await import('some-npm-package')` resolves via node_modules, enabling the standard npm install workflow
- `await import('/abs/path/to/plugin.js')` resolves file-system plugins
- The TypeScript compiler does NOT transform `await import()` calls in `NodeNext` mode — they remain native ESM imports
- The approach using `new Function` to bypass TypeScript's static import analysis is only needed for CommonJS projects loading ESM; DorkOS is already ESM and does not require this workaround

The pattern used by ESLint plugins (keyword-based npm discovery) and Vite plugins (factory function returning named object) provides the right conventions:
- Package name: `dorkos-relay-adapter-*` or `@scope/dorkos-relay-adapter-*`
- Package keywords: `["dorkos", "relay-adapter"]` in package.json
- Default export: factory function `(config: unknown) => RelayAdapter`

### 3. Runtime Adapter: Key Semantic Distinction

External adapters (Telegram, webhook) operate as **persistent bridges** — they hold a long-lived connection and push/pull messages continuously. The Claude Code runtime adapter is different: it **processes one message per session**, spawning an Agent SDK `query()` call per `deliver()` invocation.

This means:
- `start()` initializes a concurrency semaphore and optionally a queue, not a persistent connection
- `stop()` drains in-flight sessions and rejects new ones
- `deliver()` acquires a semaphore slot, creates an SDK session, streams the result, publishes back via `relay.publish()`, then releases the slot

The correlation pattern (reply-to subject) already exists in `RelayEnvelope.replyTo`. The runtime adapter reads `envelope.replyTo` to know where to publish the agent's response.

### 4. Concurrency Model: Semaphore over Pool

For the Claude Code adapter, a semaphore is the correct concurrency primitive — not a pre-warmed session pool. Agent SDK sessions are cheap to create (they are just `query()` calls) and long-lived sessions have memory/token cost. The semaphore approach:
- Initialize with `maxConcurrent` (default: 3, configurable)
- Each `deliver()` acquires a permit before calling `query()`
- Permits are released in `finally` blocks whether the session succeeds or fails
- Queue semantics: messages that arrive while all slots are busy should be rejected (backpressure signal), not queued in-memory indefinitely

The existing `BackpressureConfig` in RelayCore already handles the "too many messages" case — the runtime adapter should let RelayCore's backpressure system reject messages rather than building a separate queue.

### 5. Zod for Plugin Validation

TypeScript types vanish at runtime. When dynamically loading a third-party adapter plugin, the module's default export must be validated. Zod's `.safeParse()` with a shape-only schema (using `z.function()` for callable fields) is the right approach for duck-typing plugin exports:

```typescript
const PluginExportSchema = z.object({
  createAdapter: z.function(),
  configSchema: z.instanceof(ZodType).optional(),
  name: z.string(),
  version: z.string(),
});
```

This catches the common failure modes (wrong export shape, missing factory function) without requiring plugins to import Zod themselves.

### 6. Security: Plugin Loading Is Inherently Trust-Based

Node.js offers no safe sandbox for dynamically loaded npm packages. The `vm` module and `vm2` do not provide true isolation and are not suitable for untrusted code (vm2 is now deprecated; researchers have found escape techniques). The correct stance for DorkOS:

- Treat plugin loading like `require()` — only load packages the user explicitly installs
- Document that plugins execute with full server process privileges
- Require explicit opt-in: plugins must be listed in `~/.dork/relay/plugins.json` (same pattern as adapters)
- No auto-discovery of arbitrary npm packages — config-driven only

This is exactly how ESLint, Vite, and Fastify handle plugins: declared in config, loaded with full host privileges.

---

## Detailed Analysis

### Section 1: Plugin Loading Patterns

#### Dynamic `import()` vs `require()`

| Aspect | `dynamic import()` | `require()` |
|--------|-------------------|-------------|
| ESM support | Native | Requires `createRequire()` workaround |
| TypeScript compatibility | Full (NodeNext) | Full (CommonJS) |
| Returns | Promise for module | Synchronous module |
| Error handling | `catch` on Promise | try/catch |
| Node.js version | 12+ stable | Always |

DorkOS uses NodeNext module mode throughout. `await import()` is the natural choice. The only subtlety is that `import()` of a path string must be an absolute path or a bare specifier (package name). For config-driven paths from `~/.dork/relay/plugins.json`, normalize to absolute with `path.resolve()` before importing.

#### Resolution Strategies

Three scenarios for plugin loading:

1. **npm package** (`"package": "dorkos-relay-adapter-slack"`): use bare specifier directly — Node resolves from node_modules. The server process's node_modules (in the CLI case, the globally installed `dorkos` package's node_modules, or the user's project node_modules) is searched.

2. **Absolute path** (`"path": "/home/user/my-adapter/dist/index.js"`): use directly. The adapter is a local file not published to npm.

3. **Relative path** (`"path": "./adapters/my-adapter.js"`): resolve relative to `~/.dork/relay/` (the config directory), not the server's cwd.

#### Config-Driven vs Convention-Based Discovery

Convention-based discovery (scanning node_modules for packages matching `dorkos-relay-adapter-*`) is used by tools like Babel and some test runners. It creates surprising behavior — installing a package accidentally enables it. For a security-sensitive system like Relay, **explicit config-driven loading is strongly preferred**. The user must add an entry to `~/.dork/relay/adapters.json` to activate a plugin.

#### Hot-Reloading

The existing `AdapterManager` uses chokidar to watch `~/.dork/relay/adapters.json` for changes and calls `reload()`. The same pattern extends naturally to cover plugin-type adapter entries. One important constraint: once a module is loaded via `import()`, Node.js caches it in the module registry. Hot-reloading a plugin therefore requires either:
- Restarting the server (simplest, acceptable for plugins)
- Using a sub-process with `worker_threads` or `child_process` to isolate the module cache (complex, not worth it for this use case)

Recommendation: hot-reload plugin config changes to add/remove adapters, but do NOT attempt to hot-swap plugin code. Require a server restart to pick up new plugin versions. Document this clearly.

### Section 2: Adapter Interface Design

#### Current Interface Analysis

The existing `RelayAdapter` interface is well-designed. Comparing against Moleculer's transporter interface:

| Moleculer Transporter | DorkOS RelayAdapter | Notes |
|----------------------|---------------------|-------|
| `connect()` | `start(relay)` | DorkOS passes the relay publisher — cleaner DI |
| `disconnect()` | `stop()` | Identical semantics |
| `subscribe()` | Implicit in `start()` | DorkOS adapters subscribe during start |
| `send()` / `publish()` | `deliver()` | Same concept, DorkOS receives envelope |

The key difference for runtime adapters: `deliver()` must be **async and potentially long-running** (seconds to minutes for an agent session). The interface already allows this — `deliver` returns `Promise<void>`. The caller (`AdapterRegistry.deliver()`) awaits it, but RelayCore calls this after endpoint delivery without blocking the publish pipeline.

#### Single Interface vs Interface Hierarchy

**Option A: Single Unified Interface** (recommended)

Keep `RelayAdapter` as-is. External adapters implement `deliver` by forwarding to external channels. Runtime adapters implement `deliver` by spawning agent sessions. The interface makes no assumption about what `deliver` does. This is the Liskov Substitution Principle in practice — the registry only needs to know that adapters have the four lifecycle methods.

Pros:
- No additional types to export or version
- Existing `AdapterRegistry`, `AdapterManager`, and tests need no changes
- Third-party plugin authors only need to know one interface

Cons:
- No TypeScript hint that a runtime adapter is expected to reply via `relay.publish()`
- `subjectPrefix` semantics differ slightly: external adapters use it for routing outbound messages; runtime adapters use it as a subscription filter for inbound messages

**Option B: Interface Hierarchy**

```typescript
interface BaseAdapter { id, displayName, start, stop, getStatus }
interface ExternalAdapter extends BaseAdapter { subjectPrefix, deliver }
interface RuntimeAdapter extends BaseAdapter { subjectPrefix, deliver, maxConcurrent? }
```

Pros:
- Explicit typing for the runtime case
- Can add runtime-specific fields (concurrency config, queue depth)

Cons:
- `AdapterRegistry` needs to understand two types
- Breaking change to existing interface exports
- The difference is not structural enough to justify separate interfaces — both have the same four methods

**Recommendation: Option A with a discriminated tag field**

Rather than a hierarchy, add an optional `adapterKind` field:

```typescript
interface RelayAdapter {
  readonly id: string;
  readonly subjectPrefix: string;
  readonly displayName: string;
  readonly adapterKind?: 'external' | 'runtime'; // optional, for diagnostics/logging
  start(relay: RelayPublisher): Promise<void>;
  stop(): Promise<void>;
  deliver(subject: string, envelope: RelayEnvelope): Promise<void>;
  getStatus(): AdapterStatus;
}
```

This is purely informational — the registry behaves identically for both. It enables better log messages and future status UI differentiation without breaking anything.

#### Push vs Pull Model

The current design is **push** — RelayCore calls `adapter.deliver()` when a message matches the adapter's subject prefix. This is correct for both external adapters (push to external channel) and runtime adapters (push to agent session). A pull model (adapter polls RelayCore) would require an API that doesn't exist and complicates the concurrency story.

### Section 3: Claude Code Runtime Adapter

#### Architecture

The `ClaudeCodeAdapter` wraps the Agent SDK's `query()` function. Key design decisions:

**Session isolation**: Each `deliver()` call spawns a new, isolated SDK session. This is important because:
- Messages from different senders must not share context
- Agent SDK sessions are tied to JSONL files — reusing sessions means the agent sees prior conversation history, which may be desirable for conversation threads but not for one-shot task requests
- The `envelope.from` field or a `conversationId` in the payload can be used to optionally resume a prior session via `resume: sessionId`

**Response capture**: The SDK returns an `AsyncGenerator<SDKMessage>`. The runtime adapter must consume this generator and extract the final result:

```typescript
for await (const message of query({ prompt, options: { resume: sessionId, cwd } })) {
  if (message.type === 'result') {
    finalResult = message.result;
    break;
  }
}
```

The `SDKResultMessage` contains `result: string` (the final text), `total_cost_usd`, and error subtypes (`error_max_turns`, `error_during_execution`). The adapter should capture the result and publish it back to `envelope.replyTo`.

**Prompt formatting**: The `StandardPayload.content` field contains the inbound message text. The adapter should format it as a prompt string that gives the agent context about who sent it, what channel it came from, and what the `replyTo` subject is. An example:

```
You have received a message via the Relay message bus.

From: relay.human.telegram.123456
Sender: Alice
Channel: dorkos-dev (group)
Platform: telegram

Message:
---
Please analyze the test results and summarize the failures.
---

When you are done, your response will be automatically routed back to the sender.
```

This matches the "structured data as natural language" pattern used in agent frameworks — the agent understands the context without needing custom tooling.

**Concurrency control via semaphore**: The semaphore primitive is appropriate here — no external library needed. A simple class that tracks available slots and resolves queued waiters on release. When `maxConcurrent` is reached and a new `deliver()` is called, the adapter should THROW (not silently queue) so RelayCore's backpressure system sends a `backpressure` signal to the sender. This puts the backpressure logic in the correct layer.

**AbortController and timeouts**: The SDK supports `AbortController` for cancellation. The adapter should create one per session and store it in a `Map<messageId, AbortController>`. When `stop()` is called, abort all in-flight sessions.

Known SDK issue: aborting immediately after the init message can cause the next `resume` with the same `session_id` to fail with a process exit error (documented in [SDK issue #69](https://github.com/anthropics/claude-agent-sdk-typescript/issues/69)). The adapter should handle this by catching `AbortError` and not attempting to resume aborted sessions.

There is also a known race condition in SDK MCP tool calls when multiple tool handlers execute concurrently within a single session (SDK issue #41). The Claude Code adapter spawns independent sessions, not concurrent tool calls within a session, so this issue does not affect the adapter directly.

**Working directory**: The adapter should accept a `cwd` config parameter that defaults to `DORKOS_DEFAULT_CWD`. This ensures agent sessions spawned from Relay messages work in the right directory context.

#### Session ID Strategy for Conversational Context

The Relay envelope has a `correlationId` in `StandardPayload`. Strategy options:

1. **Stateless (default)**: Always spawn a fresh session. Simple, no state to manage.
2. **Conversation threading**: Map `StandardPayload.conversationId` to an SDK `session_id`. The adapter maintains a `Map<conversationId, sessionId>` and passes `resume: sessionId` to continue prior conversations.

Recommendation: implement stateless by default, expose `conversational: boolean` config option that enables the conversation map. The map should be bounded with TTL eviction to prevent unbounded growth.

### Section 4: npm Package Conventions

#### Naming

Following established ecosystem conventions (ESLint: `eslint-plugin-*`, Vite: `vite-plugin-*`):

```
dorkos-relay-adapter-slack
dorkos-relay-adapter-discord
dorkos-relay-adapter-linear
@mycompany/dorkos-relay-adapter-internal
```

#### package.json Requirements

```json
{
  "name": "dorkos-relay-adapter-slack",
  "keywords": ["dorkos", "relay-adapter"],
  "exports": {
    ".": "./dist/index.js"
  },
  "peerDependencies": {
    "@dorkos/relay": "^0.x"
  },
  "peerDependenciesMeta": {
    "@dorkos/relay": { "optional": false }
  }
}
```

**Peer dependency on `@dorkos/relay`**: Plugin authors import `RelayAdapter`, `RelayPublisher`, `RelayEnvelope`, and `AdapterStatus` types from `@dorkos/relay`. These must be peer dependencies (not regular dependencies) to ensure the host's version is used — prevents type incompatibilities when the host and plugin have different versions in their respective node_modules.

#### Default Export Shape

```typescript
// dist/index.js (compiled)
export default {
  name: 'slack',
  version: '1.0.0',
  createAdapter: (config: SlackAdapterConfig) => new SlackAdapter(config),
  configSchema: SlackAdapterConfigZodSchema, // optional Zod schema for validation
};
```

The config validation in `AdapterManager.createAdapter()` can call `plugin.configSchema?.safeParse(rawConfig)` before instantiating the adapter.

#### Plugin Config in `~/.dork/relay/adapters.json`

Extend the existing `AdapterConfig` with a `plugin` field:

```json
{
  "adapters": [
    {
      "id": "slack-work",
      "type": "plugin",
      "plugin": "dorkos-relay-adapter-slack",
      "enabled": true,
      "config": {
        "token": "xoxb-...",
        "channel": "#engineering"
      }
    }
  ]
}
```

This extends `AdapterType` from `'telegram' | 'webhook'` to `'telegram' | 'webhook' | 'plugin' | 'claude-code'`. The `AdapterManager.createAdapter()` switch gains two new cases.

### Section 5: Comparison and Recommendations

#### Plugin Loading: Recommendation

**Use dynamic `import()` with explicit config-driven paths. Validate with Zod duck-typing.**

| Approach | Complexity | Security | Maintainability |
|----------|-----------|----------|----------------|
| Dynamic `import()` + config list | Low | Good (explicit opt-in) | High |
| Convention-based auto-discovery | Medium | Poor (implicit) | Medium |
| `require()` with `createRequire` | Medium | Good | Low (legacy, breaks ESM) |
| Sub-process isolation | High | Excellent | Low |

The config-driven approach matches the existing `adapters.json` pattern, requires minimal new infrastructure, and puts the security decision in the user's hands (they must explicitly add the plugin to config).

#### Adapter Interface: Recommendation

**Extend the single `RelayAdapter` interface with an optional `adapterKind` discriminant. No new interface hierarchy.**

The existing interface handles all required cases. Adding a separate `RuntimeAdapter` interface would create unnecessary complexity in `AdapterRegistry` and break the clean single-interface contract that makes the registry generic.

Changes needed:
1. Add `readonly adapterKind?: 'external' | 'runtime'` to `RelayAdapter`
2. Add `'plugin' | 'claude-code'` to `AdapterType` in both `types.ts` and `relay-schemas.ts`
3. Add optional `plugin` field to `AdapterConfig` for plugin package name

#### Claude Code Adapter: Recommendation

**Direct `query()` wrapping with semaphore-based concurrency control and rejection (not queuing) when capacity is exceeded.**

| Approach | Complexity | Latency | Memory |
|----------|-----------|---------|--------|
| Direct `query()` + semaphore | Low | Minimal overhead | Low |
| Pre-warmed session pool | High | Lower first-message latency | High |
| Queue + worker pool | Medium | Adds queue latency | Medium |

Direct wrapping is the right call because:
- Agent SDK sessions have no meaningful "warm-up" — the latency is in the API call, not session creation
- Pool management (keepalive, invalidation, size management) would add significant complexity
- The semaphore approach correctly integrates with RelayCore's existing backpressure system

#### Response Capture: Recommendation

**Stream the SDK generator and publish the `result` message content back on `replyTo`.**

Do not attempt to stream incremental text deltas back through Relay — Relay's envelope model is designed for complete messages, not streaming. The agent runs to completion, then the final `result` is published as a single envelope. If streaming is needed in the future, the `SignalEmitter` with `progress` signal type is the right channel for it.

---

## Implementation Roadmap

### Phase 1: Interface Extension (Minimal Change)

1. Add `adapterKind?: 'external' | 'runtime'` to `RelayAdapter` in `packages/relay/src/types.ts`
2. Extend `AdapterType` to include `'plugin' | 'claude-code'` in `types.ts` and `relay-schemas.ts`
3. Add `plugin?: string` field to `AdapterConfig`
4. Update `AdaptersConfigFileSchema` in `relay-schemas.ts` to accept new types

### Phase 2: Claude Code Adapter

1. Create `packages/relay/src/adapters/claude-code-adapter.ts`
   - Implements `RelayAdapter` with `adapterKind: 'runtime'`
   - `subjectPrefix`: `relay.agent.claude-code` (configurable)
   - `start()`: initialize semaphore, set `this.relay = relay`
   - `deliver()`: check semaphore, format prompt, call `query()`, capture result, publish to `replyTo`, release semaphore
   - `stop()`: set `stopping = true`, abort all active sessions, drain
   - Config: `{ cwd, maxConcurrent, model, permissionMode, timeoutMs, conversational }`

2. Create `packages/relay/src/adapters/__tests__/claude-code-adapter.test.ts`
   - Mock `@anthropic-ai/claude-agent-sdk`'s `query` function
   - Test: deliver routes to agent, result published to replyTo
   - Test: concurrency limit triggers throw
   - Test: stop() aborts in-flight sessions

3. Export from `packages/relay/src/index.ts`

### Phase 3: Plugin Loading

1. Add `PluginLoader` class to `apps/server/src/services/relay/plugin-loader.ts`
   - `loadPlugin(packageNameOrPath: string): Promise<PluginModule>`
   - Validates export shape with Zod
   - Caches loaded modules

2. Extend `AdapterManager.createAdapter()` with:
   ```typescript
   case 'plugin': {
     const plugin = await this.pluginLoader.loadPlugin(config.plugin!);
     return plugin.createAdapter(config.config);
   }
   case 'claude-code': {
     return new ClaudeCodeAdapter(config.id, config.config as ClaudeCodeAdapterConfig);
   }
   ```

3. Update `AdaptersConfigFileSchema` to accept `type: 'plugin' | 'claude-code'`

4. Document plugin authoring conventions in `docs/relay-plugins.mdx`

---

## Research Gaps and Limitations

- **SDK concurrent session limits**: The Agent SDK docs do not specify a maximum number of concurrent `query()` calls per process. The known race condition with concurrent MCP tool calls is a separate issue from concurrent top-level sessions. Testing with 3-5 concurrent sessions should establish practical limits.
- **AbortController stability**: There is a documented SDK bug where aborting immediately after the init message corrupts the subsequent resume. The adapter should avoid resuming aborted sessions and may need a small guard window.
- **Plugin module caching in hot-reload**: Node's ESM module registry prevents hot-swapping plugin code without process restart. This limitation should be documented explicitly.
- **ESM plugin loading from CLI bundle**: The `dorkos` CLI bundles the server with esbuild. Dynamic `import()` of paths relative to `~/.dork/` should work because esbuild preserves dynamic imports. Verification is needed during implementation.

## Contradictions and Disputes

- **Interface hierarchy vs single interface**: Some framework designs (Moleculer, Apache Kafka Connect) use deep interface hierarchies with source/sink distinctions. For DorkOS's scale and use case (handful of adapters, not hundreds), the single interface with a discriminant is cleaner and avoids unnecessary abstraction.
- **Convention-based vs config-driven discovery**: Tools like Babel use convention-based discovery for DX. DorkOS prioritizes security and predictability over DX — config-driven is the right choice for a server-side agent infrastructure tool.

---

## Sources and Evidence

- "Transporter is an important module if you are running services on multiple nodes" — [Moleculer Networking Docs](https://moleculer.services/docs/0.14/networking.html)
- "Vite plugins extend Rollup's well-designed plugin interface with a few extra Vite-specific options" — [Vite Plugin API](https://vite.dev/guide/api-plugin)
- "By default, register creates a new scope..." — [Fastify Encapsulation](https://fastify.dev/docs/latest/Reference/Encapsulation/)
- "It is common convention to author a Vite/Rollup plugin as a factory function that returns the actual plugin object" — [Vite Plugin API](https://vite.dev/guide/api-plugin)
- SDK `query()` function signature, `AbortController` support, `SDKResultMessage` shape — [Claude Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript)
- Known concurrent session issues — [SDK GitHub Issue #41](https://github.com/anthropics/claude-agent-sdk-typescript/issues/41)
- AbortController bug after init message — [SDK GitHub Issue #69](https://github.com/anthropics/claude-agent-sdk-typescript/issues/69)
- "ESLint plugins should specify `eslint`, `eslintplugin` and `eslint-plugin` as keywords" — [ESLint Plugin Creation Docs](https://eslint.org/docs/latest/extend/plugins)
- "A peer dependency is a relationship between a plugin and its host package" — [Node.js Peer Dependencies Blog](https://nodejs.org/en/blog/npm/peer-dependencies)
- "Zod addresses TypeScript's runtime validation limitations by providing runtime type-checking" — [Zod Docs](https://zod.dev/)
- "researchers continuously discover new ways to escape the vm2 sandbox" — [Snyk VM Security Article](https://snyk.io/blog/security-concerns-javascript-sandbox-node-js-vm-module/)
- [BullMQ Worker Patterns](https://docs.bullmq.io/guide/workers)

## Search Methodology

- Searches performed: 14
- Most productive search terms: "Claude Agent SDK TypeScript session management concurrent streaming abort controller", "Vite plugin interface TypeScript lifecycle hooks design pattern", "Moleculer.js transporter adapter interface pattern design"
- Primary information sources: platform.claude.com (SDK docs), vite.dev, moleculer.services, eslint.org, GitHub issues for claude-agent-sdk-typescript, existing DorkOS codebase (`packages/relay/src/types.ts`, `adapter-registry.ts`, `adapters/telegram-adapter.ts`)
