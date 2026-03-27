---
number: 176
title: Use @a2a-js/sdk for A2A Protocol Implementation
status: proposed
created: 2026-03-22
spec: a2a-channels-interoperability
superseded-by: null
---

# 176. Use @a2a-js/sdk for A2A Protocol Implementation

## Status

Proposed

## Context

Building an A2A-compliant gateway requires JSON-RPC 2.0 handling, task state management, SSE streaming, and Agent Card generation. Two implementation options were evaluated: (1) the official `@a2a-js/sdk` which provides `A2AExpressApp`, `DefaultRequestHandler`, `InMemoryTaskStore`, and the `AgentExecutor` interface, or (2) a custom JSON-RPC handler using libraries like `jayson` or `json-rpc-2.0`. DorkOS has an established pattern of using official SDKs for protocol compliance (`@anthropic-ai/claude-agent-sdk` for Claude Code, `@modelcontextprotocol/sdk` for MCP).

## Decision

Use the official `@a2a-js/sdk` and pin the exact version at 0.3.13. The SDK provides Express middleware integration via `A2AExpressApp`, a `DefaultRequestHandler` for JSON-RPC dispatch, `InMemoryTaskStore` for task lifecycle management, and the `AgentExecutor` interface that the DorkOS gateway will implement to bridge into Relay. This is consistent with the project's pattern of adopting official SDKs over custom protocol implementations.

## Consequences

### Positive

- **Reduces protocol compliance risk** — SDK handles JSON-RPC 2.0 error codes, method dispatch, and streaming lifecycle correctly
- **Less boilerplate** — Agent Card serving, task state transitions, and SSE framing are handled by the SDK
- **Consistent with DorkOS patterns** — Follows the same official-SDK-first approach used for Claude Code and MCP integrations
- **Community alignment** — Bug fixes and protocol updates flow through the official SDK rather than requiring manual tracking

### Negative

- **Pre-1.0 SDK** — Version 0.3.13 is pre-release; the A2A protocol v1.0 has shipped but the SDK hasn't caught up, so breaking changes on upgrade are likely
- **Execution model mismatch** — The SDK's `AgentExecutor` interface assumes request-response, but DorkOS needs to wrap it around Relay's subscription-based message pattern
- **Version pinning overhead** — Exact version pinning requires deliberate upgrade decisions and testing for each SDK release
- **Limited escape hatch** — If the SDK's abstractions don't fit DorkOS's needs, migrating away requires rewriting the entire protocol layer
