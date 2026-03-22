---
spec: 160
title: 'A2A & Channels Interoperability Layer'
status: brief
created: 2026-03-21
research: research/20260321_claude_code_channels_a2a_protocol_comparison.md
---

# A2A & Channels Interoperability Layer

## Problem

DorkOS agents operate in isolation. No external agent — whether from LangGraph, Google ADK, Spring AI, or another DorkOS instance — can discover or communicate with a DorkOS-managed agent. Internally, when Relay delivers a message to a running Claude Code session, the message arrives outside the session's active reasoning context, requiring cold-start context reconstruction.

The **Agent2Agent (A2A) Protocol** — a Google/Linux Foundation open standard for cross-vendor agent discovery and communication (150+ organizations, SDKs in 5 languages, pre-1.0) — fills this gap without replacing what DorkOS already does well (broker-mediated pub/sub, persistent mailboxes, namespace isolation, multi-runtime adapters).

## Proposed Solution

An integration strategy that keeps Relay as the internal backbone while adding an external gateway surface:

### Layer 1: A2A External Gateway

Expose DorkOS agents as A2A-compliant endpoints so external agents can discover and invoke them.

- `GET /.well-known/agent.json` — auto-generated Agent Card from Mesh registry
- `GET /a2a/agents/:id/card` — per-agent Agent Card with skills from capabilities
- `POST /a2a` — JSON-RPC 2.0 handler (`message/send`, `message/stream`, `tasks/get`, `tasks/cancel`)
- Schema translation: A2A Tasks/Messages/Parts ↔ Relay envelopes/StandardPayload
- Auth: existing MCP API key exposed as A2A security scheme

Internally, all A2A requests translate to Relay publishes. No new internal transport.

### Layer 2: A2A Client (Future)

DorkOS agents can discover and delegate work to external A2A agents. Deferred until A2A reaches 1.0.

## Architecture

```
                    ┌──────────────────────────────────────────┐
                    │          External Agent Ecosystem          │
                    │  (LangGraph, Google ADK, Spring AI, ...)  │
                    └──────────────────┬───────────────────────┘
                                       │
                              A2A Protocol (JSON-RPC/SSE)
                                       │
                    ┌──────────────────▼───────────────────────┐
                    │           DorkOS A2A Gateway               │
                    │  /.well-known/agent.json (Agent Cards)    │
                    │  POST /a2a (JSON-RPC handler)             │
                    └──────────────────┬───────────────────────┘
                                       │
                              Translate: A2A ↔ Relay
                                       │
    ┌──────────────────────────────────▼──────────────────────────────────┐
    │                         DorkOS Relay (Internal Bus)                  │
    │                                                                      │
    │  NATS-style subjects: relay.agent.{ns}.{id}, relay.human.{platform} │
    │  Maildir persistence, circuit breakers, backpressure, DLQ           │
    │  Access control, budget enforcement, namespace isolation             │
    │                                                                      │
    ├─────────┬──────────┬──────────┬──────────┬──────────┬───────────────┤
    │         │          │          │          │          │               │
    ▼         ▼          ▼          ▼          ▼          ▼               ▼
 Claude    Cursor     Codex    Slack       Telegram   Webhook    Future
 Code      Adapter   Adapter  Adapter     Adapter    Adapter    Adapters
 Adapter                                                        (A2A Client,
                                                                 email, etc.)
```

## Phased Rollout

| Phase | Deliverable                                              | Effort    | Value                      |
| ----- | -------------------------------------------------------- | --------- | -------------------------- |
| 1     | Agent Card generation from Mesh registry                 | 1 day     | External discoverability   |
| 2     | Full A2A Gateway (JSON-RPC handler + schema translation) | 1-2 weeks | Ecosystem interoperability |
| 3     | A2A Client for outbound delegation                       | 2-3 weeks | Full bidirectional interop |

## Key Design Decisions

### Why not replace Relay with A2A?

A2A scales O(n²) — every agent pair needs a direct HTTP connection. Relay scales O(n) via broker-mediated pub/sub. A2A also lacks message persistence, budget enforcement, namespace isolation, and reliability primitives (circuit breakers, backpressure, DLQ). Relay is architecturally better for internal coordination. A2A is the right choice for external interoperability only.

### Why was the Channel plugin dropped?

Channels was originally planned as a delivery optimization (Layer 2). Research revealed it is not viable: duplicate-spawn bug (#36800), CLI-only (not supported by the Agent SDK), and sessions break when idle. Relay handles delivery correctly today without Channels. The Channel plugin can be revisited as a separate spec when Anthropic stabilizes the Channels feature.

### Why A2A over building a custom external API?

150+ organizations are building A2A-compatible agents. Linux Foundation governance reduces vendor lock-in risk. Official SDKs in 5 languages lower integration friction for external consumers. Building a custom API would require every external agent to write a DorkOS-specific integration.

## Research

Full comparative analysis with detailed protocol breakdowns, comparison matrices, and source citations:

- [`research/20260321_claude_code_channels_a2a_protocol_comparison.md`](../../research/20260321_claude_code_channels_a2a_protocol_comparison.md)

### Key Sources

- [A2A Protocol Specification](https://a2a-protocol.org/latest/specification/)
- [Claude Code Channels Reference](https://code.claude.com/docs/en/channels-reference)
- [HiveMQ: A2A Enterprise Scale](https://www.hivemq.com/blog/a2a-enterprise-scale-agentic-ai-collaboration-part-1/) — recommends A2A for semantics + message broker for delivery (exactly our architecture)

## Affected Packages

- `apps/server` — A2A routes, Agent Card generation
- `packages/mesh` — Agent Card schema mapping from manifests
- `packages/relay` — No changes to core
- `packages/shared` — A2A schema types (Agent Card, Task, Message, Part)
- New: `packages/a2a-gateway` or `apps/server/src/services/a2a/` — A2A JSON-RPC handler + schema translation

## Open Questions

1. **Should A2A routes live in the server or as a separate package?** The MCP server is already at `/mcp` in the server. A2A gateway at `/a2a` follows the same pattern. Separate package gives cleaner boundaries but adds build complexity.

2. **How do we map A2A Task lifecycle to Relay's envelope model?** A2A Tasks have rich state (working, input-required, completed, failed, canceled, rejected). Relay envelopes are stateless fire-and-forget. We need to synthesize task state from the message flow — likely by tracking active tasks in SQLite.

3. **Phase 1 scope: single aggregate Agent Card or per-agent cards?** A2A's `/.well-known/agent.json` convention is one card per endpoint. With multiple agents, we may need a directory endpoint that lists all agents with links to individual cards.

4. **A2A version pinning strategy?** A2A is pre-1.0. Do we pin to v0.3 and upgrade when 1.0 ships, or track the latest spec continuously?

---

## Scope Change: Channels Removed

**Date:** 2026-03-22

The Channel plugin (originally "Layer 2: Channels Delivery Optimization") has been removed from this spec. Research revealed that Claude Code Channels is not viable for production use:

- **Duplicate-spawn bug (#36800)** — Channels spawns multiple plugin instances
- **CLI-only** — Not supported by the Agent SDK; only works via `claude` CLI
- **Breaks when idle** — Sessions become unresponsive after idle periods

The A2A Gateway alone provides the core external interoperability value. A Channel plugin can be revisited as a separate spec when Anthropic stabilizes the Channels feature.

See: [`research/20260321_a2a_channels_implementation.md`](../../research/20260321_a2a_channels_implementation.md)
