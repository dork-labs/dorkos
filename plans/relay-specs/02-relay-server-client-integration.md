---
title: "Relay Server & Client Integration"
spec: 2
order: 2
status: done
blockedBy: [1]
blocks: [3, 4]
parallelWith: []
litepaperPhase: "Phase 1 — Core Transport and Safety"
complexity: medium
risk: medium
estimatedFiles: 12-18
newPackages: []
primaryWorkspaces: ["apps/server", "apps/client", "packages/shared"]
touchesServer: true
touchesClient: true
verification:
  - "POST /api/relay/send delivers a message to an endpoint's inbox"
  - "GET /api/relay/inbox/:endpoint returns messages for that endpoint"
  - "GET /api/relay/events streams SSE events for message delivery/failure"
  - "MCP tools relay_send and relay_inbox work from an agent session"
  - "Relay is disabled by default — server starts without it"
  - "DORKOS_RELAY_ENABLED=true enables Relay routes and MCP tools"
  - "Client Relay panel renders activity feed with live updates"
  - "npm run build passes (all workspaces)"
  - "CLAUDE.md and API docs are updated"
notes: >
  This is integration work — lower conceptual risk than Spec 1, but wider
  blast radius (server + client + shared + docs + turbo.json). Follow the
  Pulse integration as a 1:1 pattern reference: routes/pulse.ts, pulse-state.ts,
  mcp-tool-server.ts Pulse tools, features/pulse/ client module. The client UI
  scope should be decided during /ideate — at minimum, an activity feed panel.
---

# Spec 2: Relay Server & Client Integration

## Prompt

```
Integrate the @dorkos/relay core library into the DorkOS server and client — adding HTTP routes, MCP tools for agents, server lifecycle management, and a client-side Relay panel.

This spec assumes packages/relay/ already exists as a working library (built in Spec 1). The work here is wiring that library into the existing DorkOS stack following established patterns.

GOALS:
- Create apps/server/src/routes/relay.ts with HTTP routes for Relay (send messages, read inbox, query message history, list/register endpoints, SSE event stream)
- Add Relay MCP tools to apps/server/src/services/mcp-tool-server.ts so agents can send and receive messages (relay_send, relay_inbox, relay_list_endpoints)
- Add RelayCore initialization to apps/server/src/index.ts with feature flag support (DORKOS_RELAY_ENABLED), dependency injection, and graceful shutdown
- Create apps/server/src/services/relay-state.ts for relay enabled status (same pattern as pulse-state.ts)
- Add DORKOS_RELAY_ENABLED to turbo.json globalPassThroughEnv
- Build a client-side Relay panel in apps/client/ for viewing the message activity feed and browsing endpoint inboxes
- Update packages/shared/src/relay-schemas.ts with any additional request/response schemas needed for the HTTP API
- Add API documentation for Relay endpoints
- Update CLAUDE.md with Relay architecture information
- Integration tests for routes and MCP tools

INTENDED OUTCOMES:
- Agents can send and receive messages through MCP tools (relay_send, relay_inbox)
- Developers can interact with Relay through REST API (POST /api/relay/send, GET /api/relay/inbox/:endpoint, etc.)
- A real-time SSE event stream at GET /api/relay/events shows message delivery, failures, and budget violations
- The client has a panel showing Relay activity — at minimum, a live activity feed
- Relay is feature-flagged and disabled by default (opt-in, like Pulse)
- Documentation is updated to reflect the new module

KEY INTEGRATION PATTERNS (already established — follow these):
- Route factory: createRelayRouter(store): Router — see apps/server/src/routes/pulse.ts
- MCP tools: factory handler pattern with McpToolDeps injection — see apps/server/src/services/mcp-tool-server.ts
- Feature flag: DORKOS_RELAY_ENABLED env var + config manager — see how DORKOS_PULSE_ENABLED works in apps/server/src/index.ts
- Server startup: instantiate store → inject into MCP deps → conditionally mount routes → graceful shutdown — see apps/server/src/index.ts
- Client FSD: new feature module at apps/client/src/layers/features/relay/ — see features/pulse/ for reference
- SSE streaming: same pattern as session sync (GET /api/sessions/:id/stream) — see apps/server/src/services/stream-adapter.ts
- Request validation: Zod safeParse in route handlers, 400 on failure — see any route file

REFERENCE DOCUMENTS:
- meta/modules/relay-litepaper.md — "What Relay Enables" section describes Console-as-endpoint and activity feeds
- docs/plans/2026-02-24-relay-design.md — HTTP routes spec (lines 306-330), MCP tool patterns, Console activity feed design (lines 458-476), observability section
- docs/plans/2026-02-24-litepaper-review.md — OQ-1 (how agents send messages) directly addressed by MCP tools in this spec

CODEBASE PATTERNS TO STUDY:
- apps/server/src/routes/pulse.ts — CRUD router pattern with Zod validation
- apps/server/src/services/mcp-tool-server.ts — tool registration, McpToolDeps, factory handlers
- apps/server/src/index.ts — service initialization, feature flags, graceful shutdown
- apps/server/src/services/pulse-state.ts — feature flag state pattern
- apps/server/src/services/stream-adapter.ts — SSE helpers
- apps/client/src/layers/features/pulse/ — FSD feature module with TanStack Query hooks, UI components
- apps/client/src/layers/entities/pulse/ — entity layer hooks for Pulse (useSchedules, useRuns, etc.)
- contributing/data-fetching.md — TanStack Query patterns
- contributing/api-reference.md — API documentation patterns

CLIENT UI SCOPE (to be refined during /ideate):
The client needs at minimum a way to see Relay in action. Consider:
- Activity feed panel showing real-time message events (delivered, failed, budget exceeded)
- Inbox browser for viewing messages at specific endpoints
- Endpoint registry viewer showing registered endpoints and their subjects
- This could be a new top-level panel (like Pulse) or integrated into an existing view

OUT OF SCOPE:
- Changes to the @dorkos/relay library itself (already built)
- Rate limiting, circuit breakers (Spec 3)
- External adapters (Spec 4)
- Pulse/Console migration to Relay (Spec 5)
```

## Context for Review

This is the integration spec. The /ideate exploration agent should focus on:
- The exact patterns used by Pulse for routes, MCP tools, feature flags, and client UI
- The FSD layer structure in `apps/client/` — where does a Relay feature module fit?
- How the existing SSE streaming works for session sync
- The TanStack Query patterns for data fetching

The /ideate research agent should investigate:
- SSE best practices for real-time activity feeds
- REST API design for message bus systems (inbox patterns, filtering, pagination)
- Activity feed UI patterns (real-time updates, infinite scroll, filtering by type)
- MCP tool design patterns for message sending (what arguments, what responses)
