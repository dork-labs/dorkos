---
slug: a2a-channels-interoperability
number: 160
created: 2026-03-21
status: ideation
---

# A2A & Channels Interoperability Layer

**Slug:** a2a-channels-interoperability
**Author:** Claude Code
**Date:** 2026-03-21
**Branch:** preflight/a2a-channels-interoperability

---

## 1) Intent & Assumptions

- **Task brief:** Add external interoperability to DorkOS by exposing agents via the A2A protocol (Agent Cards + JSON-RPC gateway). Keep Relay as the internal backbone — A2A is an external gateway.

- **Assumptions:**
  - Relay and Mesh are stable and should not be modified at their core
  - The `@a2a-js/sdk` npm package (pre-1.0, v0.2.5+) is stable enough for a gateway layer when version-pinned
  - ~~Claude Code Channels research preview is stable enough at the MCP notification level~~ _(Invalidated — Channels dropped from scope; see Out of scope)_
  - The existing MCP server at `/mcp` and its auth middleware provide the pattern for external A2A endpoints
  - Agent Cards map naturally from Mesh's `AgentManifest` schema (name, description, capabilities → skills)
  - DorkOS runs on a single instance — A2A cross-instance discovery is the external consumer's responsibility

- **Out of scope:**
  - Replacing Relay with A2A for internal agent communication
  - gRPC or HTTP/REST A2A bindings (JSON-RPC only for now)
  - Agent Teams integration (orthogonal Claude Code feature)
  - A2A client for outbound delegation to external agents (deferred to post-A2A-1.0)
  - OAuth2/OIDC/mTLS authentication (API key auth only for initial release)
  - Channel plugin — deferred due to research findings: Channels has a duplicate-spawn bug (#36800), is CLI-only (not supported by SDK), and sessions break when idle. See `research/20260321_a2a_channels_implementation.md`.

---

## 2) Pre-reading Log

> **Note:** Channels research entries below are retained for context. Channels was subsequently removed from scope due to research findings (duplicate-spawn bug, CLI-only, not supported by SDK, sessions break when idle).

- `contributing/relay-adapters.md`: Complete adapter development guide — defines `RelayAdapter` interface, `AdapterManifest` schema, lifecycle patterns, compliance suite, and hot-reload sequence.
- `contributing/architecture.md`: Hexagonal architecture with Transport abstraction. The A2A gateway is a new "port" in hexagonal terms — external adapter translating A2A protocol to internal Relay messages.
- `contributing/api-reference.md`: REST API docs including OpenAPI schema generation via `zod-to-openapi`. A2A routes should register with the OpenAPI registry.
- `apps/server/src/routes/mcp.ts` (75 lines): Streamable HTTP MCP endpoint — factory-based stateless server creation per request. This is the exact pattern to follow for the A2A gateway route handler. Auth middleware (`mcpApiKeyAuth`) is reusable.
- `packages/shared/src/mesh-schemas.ts`: `AgentManifestSchema` with id, name, description, runtime, capabilities, behavior, budget, namespace, persona, enabledToolGroups. Direct mapping target for A2A Agent Cards.
- `packages/shared/src/relay-envelope-schemas.ts`: `RelayEnvelope`, `StandardPayload`, `RelayBudget`, `Signal` schemas. The A2A→Relay translator maps A2A `Message.parts[].text` → `StandardPayload.content` and A2A `taskId` → `StandardPayload.correlationId`.
- `packages/relay/src/relay-core.ts`: Publish/subscribe orchestrator. Gateway will use `relayCore.publish()` for inbound A2A messages and `relayCore.subscribe()` for response routing.
- `packages/relay/src/adapters/claude-code/`: ClaudeCodeAdapter routes `relay.agent.>` and `relay.system.pulse.>`.
- `research/20260321_claude_code_channels_a2a_protocol_comparison.md`: Comprehensive comparison analysis. Key finding: DorkOS Relay is architecturally superior to both Channels and raw A2A for internal use. A2A for external gateway is the recommended strategy. _(Channels delivery optimization originally recommended here was later dropped.)_
- `research/20260321_a2a_channels_implementation.md`: Implementation-focused research. Key findings: `@a2a-js/sdk` provides `A2AExpressApp`, `InMemoryTaskStore`, and `agentCardHandler`. _(Channels plugin findings retained for reference but removed from scope.)_

---

## 3) Codebase Map

- **Primary components/modules:**
  - `apps/server/src/routes/mcp.ts` — Existing external MCP endpoint (pattern template for A2A)
  - `apps/server/src/routes/relay.ts` — Relay HTTP routes (guarded by `DORKOS_RELAY_ENABLED`)
  - `apps/server/src/routes/mesh.ts` — Mesh discovery and agent endpoints
  - `packages/relay/src/relay-core.ts` — Relay publish/subscribe orchestrator
  - `packages/relay/src/adapter-registry.ts` — Adapter lifecycle management
  - `packages/relay/src/adapters/claude-code/` — ClaudeCodeAdapter
  - `packages/mesh/src/agent-registry.ts` — SQLite-backed agent registry (data source for Agent Cards)
  - `packages/mesh/src/mesh-core.ts` — Mesh facade (agent listing/lookup)
  - `packages/shared/src/mesh-schemas.ts` — AgentManifest Zod schema
  - `packages/shared/src/relay-envelope-schemas.ts` — RelayEnvelope, StandardPayload schemas

- **Shared dependencies:**
  - `packages/shared/src/relay-schemas.ts` — Facade re-exporting envelope, adapter, access, trace schemas
  - `apps/server/src/services/core/config-manager.ts` — Config system with feature flags
  - `apps/server/src/services/relay/relay-state.ts` — Relay feature flag holder
  - `apps/server/src/lib/dork-home.ts` — Data directory resolution
  - `packages/db/` — Drizzle ORM schemas (SQLite) for agent registry, traces

- **Data flow:**
  - A2A inbound: `External A2A Client → POST /a2a (JSON-RPC) → A2A Gateway → translate to RelayEnvelope → relayCore.publish() → Relay delivery pipeline → ClaudeCodeAdapter → Agent SDK session`
  - A2A response: `Agent SDK response → Relay subscription handler → translate to A2A TaskStatusUpdate → SSE stream back to A2A client`

- **Feature flags/config:**
  - `DORKOS_RELAY_ENABLED` (default: false, ADR-171 accepted to change to true) — A2A gateway depends on Relay being enabled
  - `MCP_API_KEY` — Existing API key for external MCP server, reused for A2A auth
  - New: `DORKOS_A2A_ENABLED` (default: derived from `DORKOS_RELAY_ENABLED`) — Optional granular control

- **Potential blast radius:**
  - Direct new files: ~4-6 (A2A routes, gateway service, schemas)
  - Modified files: ~4-5 (index.ts, app.ts, env.ts, constants.ts, shared barrel)
  - No breaking changes to existing Relay/Mesh internals
  - No client-side changes required for initial release
  - Channel plugin: removed from scope (duplicate-spawn bug, CLI-only, not SDK-supported, breaks when idle)

---

## 4) Root Cause Analysis

N/A — This is a new feature, not a bug fix.

---

## 5) Research

### Potential Solutions

**1. A2A Gateway via @a2a-js/sdk**

- Description: Mount the official SDK's Express handlers in a new `services/a2a/` module. Implement `DorkOSAgentExecutor` that translates A2A requests into Relay publishes and subscribes to responses.
- Pros:
  - Minimal protocol boilerplate — SDK handles JSON-RPC error codes, streaming lifecycle, task state
  - `InMemoryTaskStore` provides task state tracking out of the box
  - `agentCardHandler` serializes Agent Cards correctly per spec
  - Consistent with DorkOS pattern of using official SDKs (`@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`)
- Cons:
  - SDK is pre-1.0 (v0.2.5) — breaking changes between versions possible
  - SDK's `AgentExecutor.execute()` model (async generator with eventBus) requires wrapping Relay's subscription pattern
  - npm package registry returned 403 during research — exact API surface not fully confirmed
- Complexity: Medium
- Maintenance: Medium (SDK version pinning, protocol updates)

**2. Custom JSON-RPC handler**

- Description: Use `jayson` or `json-rpc-2.0` for JSON-RPC routing. Import only types from A2A SDK. Implement SSE streaming and task state synthesis directly.
- Pros:
  - Full control over routing, SSE lifecycle, error format
  - DorkOS-idiomatic patterns (matches relay.ts and mcp.ts)
  - No dependency on SDK's execution model
- Cons:
  - Must implement JSON-RPC error codes manually
  - SSE edge cases (reconnect, timeout) require careful handling
  - Protocol compliance is self-managed
- Complexity: Medium-High
- Maintenance: Higher (must track spec changes manually)

**3. Standalone Channel Plugin** _(Dropped from scope)_

> **Update:** This solution was subsequently dropped from the spec. Research revealed that Channels is currently broken: duplicate-spawn bug (#36800), CLI-only (not supported by the Agent SDK), and sessions break when idle. Revisit when Anthropic stabilizes the Channels feature.

- Description: New `packages/channel-plugin/` that bridges Relay → Claude Code Channels via MCP notifications. Reply tool scaffolded but deferred until Bug #37072 is resolved.
- Pros:
  - Clean separation — process crash doesn't affect DorkOS server
  - Can be installed/updated independently
  - Fills the Slack gap: Slack → Relay → Channel Plugin → Claude Code session
  - Low effort (~2 days)
- Cons:
  - Requires `.mcp.json` configuration and `--dangerously-load-development-channels`
  - Bug #36800 (duplicate spawn) requires defensive coding
  - One-way delivery only until Bug #37072 is resolved
- Complexity: Low
- Maintenance: Low (small codebase, MCP protocol is stable)

**4. Agent Card endpoint only**

- Description: Just `GET /.well-known/agent.json` — makes agents discoverable without protocol handling.
- Pros: ~1 day effort, zero protocol risk
- Cons: Non-functional discovery; should be bundled with the full gateway
- Complexity: Very Low

### Recommendation

**Phase 1 (immediate):** Agent Card endpoints (`/.well-known/agent.json` + per-agent cards)
**Phase 2 (next sprint):** Full A2A Gateway using `@a2a-js/sdk` (JSON-RPC handler + schema translation)
**Phase 3 (deferred):** A2A Client for outbound delegation (post-A2A-1.0)

Use `@a2a-js/sdk` for the gateway. The SDK-first approach is consistent with DorkOS conventions and reduces protocol compliance risk. Pin the SDK version and plan for migration when A2A 1.0 ships.

> **Note:** Channel Plugin was originally planned for Phase 1 but has been dropped. See Decision #4 below.

---

## 6) Decisions

| #   | Decision                                | Choice                                                                              | Rationale                                                                                                                                                                                                                                                                    |
| --- | --------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A2A gateway implementation approach     | Use `@a2a-js/sdk` official SDK                                                      | Consistent with DorkOS's pattern of using official SDKs for protocol integrations. Reduces JSON-RPC boilerplate. InMemoryTaskStore handles task state. Pin version to mitigate pre-1.0 instability.                                                                          |
| 2   | Agent Card discovery endpoint structure | Fleet card at `/.well-known/agent.json` + per-agent cards at `/a2a/agents/:id/card` | Fleet card follows A2A convention for well-known discovery, acting as a directory. Per-agent cards preserve individual agent identity and skill attribution. External clients can discover all agents in one request.                                                        |
| 3   | Channel plugin scope                    | ~~Include with reply tool scaffolded~~ **Dropped**                                  | Originally planned as one-way Relay→Channel delivery. Subsequently dropped after research revealed Channels is currently broken: duplicate-spawn bug (#36800), CLI-only (not SDK-supported), sessions break when idle. Revisit when Anthropic stabilizes Channels.           |
| 4   | Drop Channels from spec scope           | Remove all Channel plugin deliverables                                              | Research confirmed Channels is not viable: duplicate-spawn bug (#36800), CLI-only (not supported by Agent SDK), broken when idle. A2A Gateway alone provides the external interoperability value. Channel plugin can be revisited as a future spec when Channels stabilizes. |
