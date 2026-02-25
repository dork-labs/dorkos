---
title: "Relay External Adapters"
spec: 4
order: 3
status: done
blockedBy: [2]
blocks: [5]
parallelWith: [3]
litepaperPhase: "Phase 3 — External Adapters"
complexity: high
risk: medium
estimatedFiles: 12-18
newPackages: []
primaryWorkspaces: ["packages/relay", "apps/server", "apps/client", "apps/web"]
touchesServer: true
touchesClient: true
externalDependencies:
  - "Telegram Bot API token (user must create a bot via @BotFather)"
  - "Network access for Telegram long polling or webhook delivery"
verification:
  - "Telegram adapter receives inbound messages and publishes to Relay"
  - "Telegram adapter delivers outbound Relay messages to Telegram chats"
  - "Webhook adapter accepts inbound HTTP POST and publishes to Relay"
  - "Webhook adapter delivers outbound messages via HTTP POST"
  - "Adapter config at ~/.dork/relay/adapters.json is hot-reloadable"
  - "Adapters normalize messages into StandardPayload format"
  - "Console activity feed shows live Relay events (replaces simulated feed)"
  - "Typing signals flow through Telegram adapter"
notes: >
  Can run in PARALLEL with Spec 3 (Advanced Reliability) — they're independent
  additions to the Spec 2 foundation. Both must complete before Spec 5.
  This spec requires external API access (Telegram) for full testing — plan
  for this during setup. The Telegram adapter is the reference implementation
  that proves the adapter interface works. The webhook adapter is simpler but
  equally important for generic integrations. The Console activity feed
  (replacing ActivityFeedHero.tsx simulated data) also lives in this spec.
---

# Spec 4: Relay External Adapters

## Prompt

```
Build the external adapter system for Relay — a plugin interface that lets any external channel (Telegram, Slack, email, webhooks) become a set of endpoints on the Relay message bus.

This is where Relay crosses the process boundary. Specs 1-2 built internal messaging (agent-to-agent, system-to-agent). This spec adds the ability for agents to communicate with the outside world through a normalized adapter interface.

GOALS:
- Design and implement the RelayAdapter plugin interface in packages/relay/ — a contract that any external channel adapter must implement (start, stop, deliver, subject prefix)
- Implement adapter lifecycle management — loading adapters at startup, hot-reloading config, graceful shutdown
- Build a Telegram adapter as the first real adapter — maps relay.human.telegram.{userId} subjects to Telegram chats, handles both inbound (Telegram → Relay) and outbound (Relay → Telegram) messages, supports typing signals
- Build a webhook adapter for generic HTTP integrations — inbound webhooks that publish to Relay subjects, outbound delivery via HTTP POST to configured URLs
- Add adapter configuration to ~/.dork/relay/adapters.json (token, enabled flag, channel-specific settings per adapter)
- Add HTTP routes for managing adapters (list adapters, enable/disable, view status)
- Update the client Relay panel with adapter status display (connected/disconnected, message counts, error rates)
- Build a Console activity feed powered by Relay's SSE event stream — replacing the simulated ACTIVITY_POOL in ActivityFeedHero.tsx with live data from Relay events

INTENDED OUTCOMES:
- A working Telegram adapter that lets agents send and receive Telegram messages through Relay's subject hierarchy
- A working webhook adapter for generic HTTP integrations
- Any developer can build a new adapter by implementing the RelayAdapter interface
- Adapters normalize external messages into StandardPayload — agents don't need to know which platform a message came from
- The Console shows a live activity feed from real Relay events (message delivered, message failed, etc.)
- Adapter config is hot-reloadable — enable/disable adapters without restarting the server

KEY DESIGN DECISIONS (from design doc):
- Adapter interface: { id, subjectPrefix, start(relay), stop(), deliver(subject, envelope) }
- Adapters translate bidirectionally: external → Relay subjects (inbound), Relay → external API (outbound)
- Adapters inject responseContext into the StandardPayload so agents know platform constraints (max message length, supported formats, reply instructions)
- External group chats map to single Relay subjects (e.g., Telegram group "birthday-planning" → relay.human.telegram.group.birthday-planning)
- Adapter config at ~/.dork/relay/adapters.json, hot-reloaded via chokidar
- Phase 1 of this spec: Telegram + webhook. Other adapters (Slack, email, voice) come later.

REFERENCE DOCUMENTS:
- meta/modules/relay-litepaper.md — "External Channels: The Adapter Model" section (lines 100-108)
- docs/plans/2026-02-24-relay-design.md — RelayAdapter interface (lines 239-262), group messages (lines 389-405), file attachments and message editing (lines 409-423), Console activity feed (lines 458-476)
- docs/plans/2026-02-24-litepaper-review.md — OQ-7 (voice/streaming interaction with message model) is relevant context but out of scope for this spec
- research/mesh/communication-protocols.md — message normalization patterns
- apps/web/src/layers/features/marketing/ui/ActivityFeedHero.tsx — the simulated activity feed that this spec replaces with live Relay data

CODEBASE PATTERNS:
- Plugin loading: see how MCP tool server dynamically registers tools — similar pattern for adapter loading
- Config hot-reload: see how chokidar is used in session-broadcaster.ts for file watching
- SSE streaming: see stream-adapter.ts and session sync pattern — activity feed uses the same approach
- Telegram bot API: uses long polling or webhooks — the adapter handles this internally

SECURITY CONSIDERATIONS:
- Adapter tokens (Telegram bot token, webhook secrets) are sensitive — store in config, never log
- Inbound webhooks need signature verification to prevent spoofing
- Outbound rate limiting should respect external API limits (Telegram: 30 msgs/sec, Slack: 1 msg/sec per channel)
- Budget envelopes still apply to external messages — prevent agents from spamming external channels

OUT OF SCOPE:
- Slack adapter (can use same interface, built later)
- Email adapter (SMTP complexity, built later)
- Voice/streaming adapter (OQ-7, needs separate design)
- Pulse/Console migration to Relay endpoints (Spec 5)
```

## Context for Review

This is the first spec where Relay reaches outside the process. The /ideate session should focus on:
- Telegram Bot API integration patterns (long polling vs webhooks, message formatting)
- Webhook security (HMAC signature verification, replay protection)
- How to test adapters (mock external APIs, integration test patterns)
- The activity feed UI design — what events to show, how to format them, filtering/search
- How adapter errors are handled (retry policy, error surfacing, dead letter for adapter failures)
