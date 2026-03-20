---
slug: relay-runtime-adapters
number: 57
created: 2026-02-25
status: ideation
---

# Unified Adapter System & Claude Code Runtime Adapter

**Slug:** relay-runtime-adapters
**Author:** Claude Code
**Date:** 2026-02-25
**Branch:** preflight/relay-runtime-adapters
**Related:** Relay Spec 6 (`plans/relay-specs/06-relay-runtime-adapters.md`), Spec 53 (relay-external-adapters), Spec 50 (relay-core-library), Spec 55 (relay-convergence)

---

## 1) Intent & Assumptions

- **Task brief:** Unify Relay's adapter system under a single pluggable `RelayAdapter` interface, refactor Spec 4's Telegram/webhook adapters to conform, add a plugin loader for third-party npm/local adapters, and build the Claude Code runtime adapter — the first adapter that bridges Relay messages to Agent SDK sessions.
- **Assumptions:**
  - Spec 4 (external adapters) is implemented — Telegram and webhook adapters exist in `packages/relay/src/adapters/`
  - The existing `RelayAdapter` interface in `packages/relay/src/types.ts` is structurally sound and needs only minor additions (`AdapterContext`, `DeliveryResult`)
  - Relay convergence (Spec 5) introduced `MessageReceiver` as a temporary bridge; ClaudeCodeAdapter replaces it entirely
  - Mesh integration is available but optional — adapter works with or without `MeshCore`
  - AgentManager's `sendMessage()` / `query()` interface is stable
- **Out of scope:**
  - Codex or OpenCode runtime adapters (future work — just define the interface)
  - Pulse/Console migration to Relay dispatch (Spec 5 already handles this)
  - Passive/IDE-based agents (only active agents supported)
  - Adapter marketplace or registry (adapters are npm packages, distributed normally)
  - Client-side changes (this is entirely server/library work)

## 2) Pre-reading Log

- `packages/relay/src/types.ts`: Core Relay types including `RelayAdapter` interface (lines 212-252), `AdapterConfig`, `RelayEnvelope`, `DeliveryResult`. The adapter interface has `id`, `subjectPattern`, `start(relay)`, `stop()`, `deliver(subject, envelope)`. Missing `AdapterContext` parameter on `deliver()`.
- `packages/relay/src/relay-core.ts`: Central message bus with `subscribe()`, `publish()`, `onMessage()`. NATS-style subject matching. This is what adapters receive in `start()`.
- `packages/relay/src/adapter-registry.ts`: Manages adapter lifecycle with `Promise.allSettled` for error isolation. Handles `startAll()`, `stopAll()`, `getAdapter()`. Uses the `RelayAdapter` interface.
- `packages/relay/src/adapters/telegram-adapter.ts`: TelegramAdapter implementing RelayAdapter. Uses grammY, supports polling/webhook modes. Well-structured reference for adapter patterns.
- `packages/relay/src/adapters/webhook-adapter.ts`: WebhookAdapter with HMAC-SHA256 signature verification. Stripe-style security. Another reference implementation.
- `apps/server/src/services/relay/adapter-manager.ts`: Server-side adapter management. Has `createAdapter()` factory dispatching by config type. Currently handles `telegram` and `webhook` types. This is where plugin loading extends.
- `apps/server/src/services/relay/message-receiver.ts`: Bridge between Relay and AgentManager. Subscribes to `relay.agent.>` and `relay.system.pulse.>`. Routes messages to `agentManager.sendMessage()`. This is the code the ClaudeCodeAdapter replaces.
- `apps/server/src/services/core/agent-manager.ts`: Manages Agent SDK sessions. `sendMessage()` creates isolated sessions via `query()`. Streams events, captures responses. The core session creation logic the adapter wraps.
- `apps/server/src/services/core/context-builder.ts`: `buildSystemPromptAppend(cwd)` — gathers runtime context and formats as XML blocks. The adapter's prompt formatting follows this pattern.
- `apps/server/src/services/scheduler-service.ts`: How Pulse creates isolated agent sessions. When Relay is enabled, publishes to `relay.system.pulse.{scheduleId}` — messages the adapter handles.
- `apps/server/src/services/core/sdk-event-mapper.ts`: Transforms SDK streaming events. The adapter needs similar event processing to capture agent responses.
- `packages/shared/src/relay-schemas.ts`: Zod schemas for Relay types — envelopes, budgets, adapter configs. Needs extension for plugin config fields.
- `packages/shared/src/mesh-schemas.ts`: Agent manifest schemas including `runtime` field and capabilities. Used for Mesh integration in `AdapterContext`.
- `research/20260224_relay_runtime_adapters.md`: Comprehensive plugin architecture research from Spec 4's planning phase.
- `decisions/0020-adapter-registry-with-promise-allsettled.md`: ADR for adapter registry error isolation pattern.
- `meta/modules/relay-litepaper.md`: "Adapters: Bridging Relay to Everything" section describes the vision.

## 3) Codebase Map

**Primary Components/Modules:**

- `packages/relay/src/types.ts` — RelayAdapter interface, AdapterConfig, RelayEnvelope, DeliveryResult types
- `packages/relay/src/adapter-registry.ts` — Adapter lifecycle management (start/stop/deliver routing)
- `packages/relay/src/adapters/telegram-adapter.ts` — TelegramAdapter (reference implementation)
- `packages/relay/src/adapters/webhook-adapter.ts` — WebhookAdapter (reference implementation)
- `apps/server/src/services/relay/adapter-manager.ts` — Server-side adapter factory and initialization
- `apps/server/src/services/relay/message-receiver.ts` — Current Relay→AgentManager bridge (to be replaced)
- `apps/server/src/services/core/agent-manager.ts` — Agent SDK session management

**Shared Dependencies:**

- `packages/relay/src/relay-core.ts` — Central message bus (injected into adapters via `start()`)
- `packages/shared/src/relay-schemas.ts` — Zod schemas for validation
- `packages/shared/src/mesh-schemas.ts` — Agent manifest types
- `apps/server/src/services/core/context-builder.ts` — XML context block formatting

**Data Flow:**

```
Message published to relay.agent.{project}.{agentId}
  → RelayCore routes to AdapterRegistry
    → AdapterRegistry finds ClaudeCodeAdapter (matches relay.agent.>)
      → ClaudeCodeAdapter.deliver(subject, envelope, context)
        → Resolve agent info (Mesh registry, envelope metadata, or static config)
        → Format prompt with XML context blocks
        → AgentManager.sendMessage() / query({ cwd, prompt })
          → Agent SDK processes prompt, executes tools
        → Capture response text
        → Publish response to envelope.replyTo subject
        → Return DeliveryResult (success/failure)
```

**Feature Flags/Config:**

- `DORKOS_RELAY_ENABLED` — gates Relay subsystem (existing)
- `DORKOS_MESH_ENABLED` — gates Mesh integration for agent info enrichment (existing)
- `~/.dork/relay/adapters.json` — adapter configuration file (new)

**Potential Blast Radius:**

- Direct: 3-4 new files (ClaudeCodeAdapter, plugin loader, tests), 5-7 modified files
- Indirect: MessageReceiver removal affects server startup and relay initialization
- Tests: 3-4 new test files, existing adapter tests should pass unchanged
- Config: New `adapters.json` config file format

## 4) Root Cause Analysis

N/A — this is a feature, not a bug fix.

## 5) Research

### Potential Solutions

**1. Extend Existing Adapter Interface Minimally**

- Description: Add `AdapterContext` and `DeliveryResult` to the `deliver()` signature. Add plugin loading to `AdapterManager.createAdapter()` via async dynamic `import()`. Build ClaudeCodeAdapter as a built-in adapter.
- Pros:
  - 90% of infrastructure already exists — minimal new code
  - Matches NATS/Kafka/RabbitMQ patterns (single interface, start/stop/deliver lifecycle)
  - Zero new dependencies for plugin loading (native `import()`)
  - Existing adapters need only minor signature changes
- Cons:
  - `createAdapter()` becomes async (minor internal refactor)
  - Node.js module cache prevents true hot-reload of local file adapters
- Complexity: Medium
- Maintenance: Low

**2. Separate Runtime Adapter Interface**

- Description: Create a separate `RuntimeAdapter` extending `RelayAdapter` with agent-specific methods (resolveAgent, formatPrompt, captureResponse).
- Pros:
  - Clean separation between external adapters (push to channels) and runtime adapters (dispatch to sessions)
  - More explicit about runtime adapter responsibilities
- Cons:
  - Two interfaces to learn and maintain
  - Over-engineering — the `deliver()` method can handle both cases via `AdapterContext`
  - Violates the spec's goal of "one interface for all adapters"
- Complexity: Medium-High
- Maintenance: Medium

**3. Full Plugin Framework with Dependency Injection**

- Description: Build a comprehensive plugin framework with lifecycle hooks, DI containers, config schema validation, and hot-reload.
- Pros:
  - Most extensible and feature-rich
  - Automatic config validation via exported Zod schemas
- Cons:
  - Over-engineered for current needs (3 built-in adapters + rare third-party)
  - Significant new code and complexity
  - Delays delivery without proportional benefit
- Complexity: High
- Maintenance: High

### Security Considerations

- Dynamic `import()` of local files: must validate paths are within allowed directories
- npm package loading: rely on npm's security model, no additional sandboxing needed
- Adapter config may contain secrets (API tokens): `adapters.json` should be in `~/.dork/relay/` with user-only permissions

### Performance Considerations

- ClaudeCodeAdapter concurrency: semaphore-based (maxConcurrent: 3 default) to prevent resource exhaustion
- Agent SDK sessions are heavyweight — each runs a Claude Code process
- Plugin loading happens once at startup — no runtime performance impact

### Recommendation

**Recommended Approach:** Extend Existing Adapter Interface Minimally (Option 1)

**Rationale:** The codebase already has 90% of the infrastructure. The `RelayAdapter` interface is structurally sound and matches industry patterns from NATS, Kafka, and RabbitMQ. Adding `AdapterContext` to `deliver()` and building the plugin loader with native `import()` requires minimal new code while achieving all spec goals. The ClaudeCodeAdapter wraps the existing `AgentManagerLike` interface from `message-receiver.ts`, which is proven code.

**Caveats:**

- MessageReceiver must be fully replaced (not left as dead code) to avoid confusion
- `AdapterManager.createAdapter()` becomes async — all callers must await
- Local file adapter hot-reload requires server restart due to Node.js module caching — document this
- `adapters.json` format must be forward-compatible for future adapter types

## 6) Decisions

| #   | Decision                                            | Choice                                              | Rationale                                                                                                                                                                                                                             |
| --- | --------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | How ClaudeCodeAdapter coexists with MessageReceiver | ClaudeCodeAdapter replaces MessageReceiver entirely | MessageReceiver was a temporary bridge (Spec 5). Both do the same job — receive Relay messages, call AgentManager. One component avoids "which one handles what?" confusion. Code is fresh (just committed), perfect time to replace. |
| 2   | Plugin hot-reload support                           | Server restart only                                 | Simpler, safer. Node.js module cache prevents true code hot-reload anyway. Config changes take effect on restart. Matches Kafka Connect and most plugin systems.                                                                      |
| 3   | Plugin loader location                              | In packages/relay/ as part of the library           | Adapter loading is a library concern — third-party packages import types from @dorkos/relay. Keeps the server thin. Adapter authors can test loading independently.                                                                   |
| 4   | Third-party adapter export convention               | Default export factory function                     | e.g. `export default function createSlackAdapter(config): RelayAdapter`. Matches Vite/ESLint/Rollup ecosystem conventions. Simple, ergonomic, one function to call.                                                                   |
