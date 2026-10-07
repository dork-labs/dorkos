---
number: 177
title: Standalone Channel Plugin as MCP Server Process
status: rejected
created: 2026-03-22
spec: a2a-channels-interoperability
superseded-by: null
---

# 177. Standalone Channel Plugin as MCP Server Process

## Status

Rejected (2026-03-22)

Research revealed Claude Code Channels is not viable for production use. See `research/20260322_channels_idle_sdk_lifecycle_behavior.md` for full findings.

## Context

Claude Code Channels (research preview, March 2026) can push external events into active session context via MCP notifications. DorkOS needs to bridge Relay messages into Claude Code sessions for in-context delivery — when an external agent sends a message via A2A or another agent publishes to Relay, the target Claude Code session should receive it without polling. Two approaches were evaluated: (1) embedding the Channel bridge in the DorkOS server process, or (2) building a standalone MCP server process that Claude Code spawns as a subprocess via `.mcp.json` configuration.

## Decision

~~Build the Channel plugin as a standalone process at `packages/channel-plugin/`.~~

**Rejected.** The Channel plugin was removed from scope after research confirmed Channels is fundamentally broken for DorkOS use cases:

1. **CLI-only** — Channels is not supported by the Claude Agent SDK. The notification injection mechanism exists only in the CLI's interactive REPL layer. DorkOS agents use the SDK.
2. **Broken when idle** — Bug #36800 causes duplicate subprocess spawns that orphan notification listeners after ~3 minutes. Notifications are silently consumed but never routed.
3. **Narrow happy path** — Requires ALL of: CLI usage, `claude.ai` login (not API key), `tengu_harbor` feature flag, first notification in session, session under ~3 minutes old, macOS/Linux.

Relay's persistent mailbox remains the sole reliable delivery path. Revisit when Anthropic stabilizes the Channels feature.

## Consequences

N/A — Decision was rejected before implementation.
