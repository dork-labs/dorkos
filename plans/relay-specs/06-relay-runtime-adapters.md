---
title: "Unified Adapter System & Claude Code Runtime Adapter"
spec: 6
order: 4
status: in-progress
blockedBy: [4]
blocks: [5]
parallelWith: [3]
litepaperPhase: "Phase 4 — Unified Adapter System and Claude Code Adapter"
complexity: high
risk: high
estimatedFiles: 12-18
newPackages: []
primaryWorkspaces: ["packages/relay", "apps/server", "packages/shared"]
touchesServer: true
touchesClient: false
verification:
  - "Unified RelayAdapter interface is defined and exported from @dorkos/relay"
  - "Spec 4's Telegram and webhook adapters are refactored to implement the unified interface"
  - "All Spec 4 adapter tests still pass after refactor"
  - "Plugin loader loads adapters from npm packages via dynamic import"
  - "Plugin loader loads adapters from local file paths via dynamic import"
  - "adapters.json config format works with both built-in and third-party adapters"
  - "ClaudeCodeAdapter implements RelayAdapter and starts Agent SDK sessions on message delivery"
  - "Message arriving at relay.agent.{project}.{agentId} triggers a Claude Code session in the correct directory"
  - "Agent receives Relay message content as its prompt with sender/budget context"
  - "Agent response is captured and published back to Relay as a reply"
  - "Failed session creates a dead letter entry with error details"
  - "Adapter works with Mesh registry — looks up agent directory and runtime if MeshCore available"
  - "Third-party adapter example: a minimal adapter can be built in a separate file and loaded via config"
notes: >
  This spec has two concerns: (1) unify and make the adapter system pluggable,
  and (2) build the Claude Code runtime adapter. The unification must happen
  first since the Claude Code adapter should use the unified interface. Spec 4
  (External Adapters) must be complete before starting — this spec refactors
  Spec 4's adapters to the unified interface and builds on its adapter
  infrastructure. The Claude Code adapter wraps existing AgentManager logic
  without breaking the direct-call path (Console chat and Pulse still use
  AgentManager directly until Spec 5 migrates them).
---

# Spec 6: Unified Adapter System & Claude Code Runtime Adapter

## Prompt

```
Unify Relay's adapter system under a single pluggable interface, add third-party adapter support, and build the Claude Code runtime adapter.

This spec has two connected goals. First, it creates a unified RelayAdapter interface that both external adapters (Telegram, webhooks from Spec 4) and runtime adapters (Claude Code, future Codex/OpenCode) implement. Second, it builds the Claude Code runtime adapter — the first adapter that bridges Relay to an agent runtime. Third, it adds a plugin loading mechanism so anyone can build and distribute adapters as npm packages.

GOALS:

PART 1 — UNIFIED ADAPTER INTERFACE:
- Define a single RelayAdapter interface in packages/relay/ that all adapters implement:
  - id: string — unique adapter identifier (e.g., "claude-code", "telegram", "slack")
  - subjectPattern: string — which subjects this adapter handles (e.g., "relay.agent.>", "relay.human.telegram.>")
  - start(relay: RelayCore): Promise<void> — initialize the adapter, subscribe to subjects
  - stop(): Promise<void> — graceful shutdown, drain in-flight deliveries
  - deliver(subject: string, envelope: RelayEnvelope, context: AdapterContext): Promise<DeliveryResult>
  Where AdapterContext includes optional agent info (directory, runtime, manifest) for runtime adapters and optional platform info for external adapters.
- Refactor Spec 4's Telegram and webhook adapters to implement the unified RelayAdapter interface. This should be a small change — align the class signatures, not a rewrite.
- Export the RelayAdapter interface, AdapterContext, DeliveryResult, and all related types from @dorkos/relay so third-party packages can import them.
- Add the types to packages/shared/src/relay-schemas.ts if they need Zod schemas for validation.

PART 2 — PLUGIN LOADING:
- Implement an adapter loader that dynamically imports adapters from:
  1. Built-in adapters (shipped with @dorkos/relay — Telegram, webhook, Claude Code)
  2. npm packages (e.g., "dorkos-relay-slack" — installed in node_modules, loaded via dynamic import)
  3. Local file paths (e.g., "./adapters/my-adapter.js" — for custom/dev adapters)
- Adapter configuration lives in ~/.dork/relay/adapters.json:
  {
    "adapters": [
      { "id": "claude-code", "builtin": true, "enabled": true, "config": { "maxConcurrent": 3, "timeout": 300000 } },
      { "id": "telegram", "builtin": true, "enabled": false, "config": { "token": "..." } },
      { "id": "slack", "package": "dorkos-relay-slack", "enabled": true, "config": { "token": "..." } },
      { "id": "my-custom", "path": "./adapters/my-adapter.js", "enabled": true, "config": {} }
    ]
  }
- Adapters are loaded at server startup (after RelayCore initialization). Each adapter's start() is called with the RelayCore instance.
- Graceful shutdown calls stop() on all adapters in reverse order.
- Hot-reloadable: changes to adapters.json enable/disable adapters without full restart.
- Adapter loading errors are non-fatal — log the error and continue with remaining adapters.

PART 3 — CLAUDE CODE RUNTIME ADAPTER:
- Implement ClaudeCodeAdapter implementing the unified RelayAdapter interface:
  - subjectPattern: "relay.agent.>" — handles all agent messages
  - When deliver() is called with a message for an agent:
    1. Resolve agent info: directory path + runtime type
       - From AdapterContext (populated by Mesh registry if available)
       - From message metadata (sender includes agent directory in envelope)
       - From static config in adapters.json (fallback)
    2. Format the Relay message into a natural prompt:
       - Message content (the actual request/instruction)
       - Sender identity (who sent this, which project, what agent)
       - Response instructions (where to reply, expected format)
       - Budget context (hops remaining, TTL, call budget — so the agent can self-limit)
       - Conversation context (if this is a reply in a thread, include ancestor info)
    3. Create an Agent SDK session via AgentManager:
       - query({ cwd: agentDirectory, prompt: formattedMessage })
       - Stream events, capture the final response text
    4. Publish the response back to Relay:
       - Send to envelope.replyTo subject (if specified)
       - Include the original message ID for correlation
    5. Handle errors:
       - Session timeout → dead letter with timeout reason
       - Session failure → dead letter with error details
       - SDK errors → dead letter with SDK error info
  - Configurable: max concurrent sessions, session timeout, Relay subject pattern
  - Coexists with direct AgentManager usage — Console chat and Pulse dispatch still call AgentManager directly until Spec 5 migrates them

PART 4 — MESH INTEGRATION (OPTIONAL):
- If MeshCore is available (injected at startup), the adapter loader enriches AdapterContext with agent info from the Mesh registry before calling deliver().
- If MeshCore is not available, adapters rely on message metadata or static config for agent info.
- This means the adapter system works with OR without Mesh.

INTENDED OUTCOMES:
- One interface for all adapters — external and runtime. Third-party developers learn one pattern.
- Adapters are distributable as npm packages. `npm install dorkos-relay-slack`, configure, done.
- The Claude Code adapter makes Relay-to-agent communication work end-to-end.
- Existing Spec 4 adapters (Telegram, webhook) work unchanged after refactor.
- The system is extensible — adding Codex support means writing a new adapter, not modifying Relay.

THE DELIVERY FLOW (Claude Code):
1. Message published to relay.agent.finance.budget-bot
2. ClaudeCodeAdapter.deliver() called (subscribed to relay.agent.>)
3. Adapter resolves agent info: directory = ~/projects/finance/, runtime = claude-code
   (from Mesh registry, message metadata, or static config)
4. Adapter formats message into natural prompt with sender/budget context
5. Adapter creates Agent SDK session: query({ cwd: ~/projects/finance/, prompt: formattedMessage })
6. Agent processes the prompt, executes tools, produces a response
7. Adapter captures response text
8. Adapter publishes response to envelope.replyTo subject (if specified)
9. Adapter reports delivery result (success/failure) to Relay

THE PLUGIN LOADING FLOW:
1. Server starts, reads ~/.dork/relay/adapters.json
2. For each enabled adapter:
   a. builtin: true → import from packages/relay/src/adapters/{id}
   b. package: "name" → dynamic import("name")
   c. path: "./file.js" → dynamic import(resolve(path))
3. Validate that imported module exports a class implementing RelayAdapter
4. Call adapter.start(relayCore)
5. Log success or error for each adapter
6. On shutdown: call adapter.stop() for each in reverse order

REFERENCE DOCUMENTS:
- meta/modules/relay-litepaper.md — "Adapters: Bridging Relay to Everything" section
- meta/modules/mesh-litepaper.md — agent manifest (runtime field, capabilities)
- packages/relay/src/relay-core.ts — subscribe(), publish(), onMessage() patterns
- apps/server/src/services/agent-manager.ts — existing session creation logic (the code the Claude Code adapter wraps)
- apps/server/src/services/scheduler-service.ts — how Pulse creates isolated agent sessions (reference pattern)
- apps/server/src/services/context-builder.ts — how runtime context is injected into agent prompts

CODEBASE PATTERNS TO STUDY:
- docs/plans/relay-specs/04-relay-external-adapters.md — the Spec 4 adapter interface (what we're unifying)
- Whatever adapter code Spec 4 produced — the Telegram and webhook adapters to refactor
- apps/server/src/services/agent-manager.ts — createSession(), Agent SDK query() call, streaming event handling
- apps/server/src/services/sdk-event-mapper.ts — how SDK events are transformed (adapter needs similar mapping)
- apps/server/src/services/scheduler-service.ts — how Pulse triggers isolated agent sessions
- apps/server/src/services/context-builder.ts — buildSystemPromptAppend() for context injection
- packages/relay/src/relay-core.ts — subscribe() and publish() API
- Node.js dynamic import() patterns for plugin loading

PROMPT FORMATTING CONSIDERATIONS:
The adapter formats the Relay message into a prompt the agent can understand. Consider:
- Message content (the actual request/instruction)
- Sender identity (who sent this, which project, what agent)
- Response instructions (where to reply, expected format)
- Budget context (hops remaining, TTL, call budget — so the agent can self-limit)
- Conversation context (if this is a reply in a thread, include ancestor context)

The prompt should feel natural — not like a machine-formatted envelope dump. The agent should understand what it's being asked to do and who's asking.

OUT OF SCOPE:
- Codex or OpenCode runtime adapters (future work — just define the interface)
- Pulse migration to Relay dispatch (Spec 5)
- Console migration to Relay endpoint (Spec 5)
- Passive/IDE-based agents (only active agents supported)
- Adapter marketplace or registry (adapters are npm packages, distributed normally)
```

## Context for Review

This spec unifies the adapter system and builds the first runtime adapter. The /ideate exploration agent should focus on:
- Whatever adapter code Spec 4 produced — the current adapter interface, how Telegram/webhook adapters are structured
- `AgentManager` in `apps/server/src/services/agent-manager.ts` — the session creation code the Claude Code adapter wraps
- `SchedulerService` — how Pulse creates isolated agent sessions (closest existing pattern)
- `context-builder.ts` — how runtime context is injected into prompts
- `sdk-event-mapper.ts` — how SDK streaming events are processed
- `relay-core.ts` — the subscribe/publish API adapters use
- Node.js dynamic `import()` and plugin loading patterns in the codebase

The /ideate research agent should investigate:
- Plugin loading patterns in Node.js (dynamic import, package resolution, validation)
- Adapter/plugin interfaces in messaging systems (NATS connectors, Kafka Connect, RabbitMQ plugins)
- Agent SDK session management patterns (streaming, timeout, error recovery)
- Prompt formatting for inter-agent communication (natural language framing of structured data)
- Request-response patterns over pub/sub (correlation IDs, reply subjects)
- npm package conventions for plugins (naming, exports, configuration)
