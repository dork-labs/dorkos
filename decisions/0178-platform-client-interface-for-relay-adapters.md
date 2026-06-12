---
number: 178
title: PlatformClient Interface for Relay Adapters
status: accepted
created: 2026-03-22
spec: chat-sdk-relay-adapter-refactor
superseded-by: null
---

# 178. PlatformClient Interface for Relay Adapters

## Status

Accepted

## Context

Relay adapters currently conflate two concerns: platform communication (posting messages, editing, streaming, webhook handling) and relay orchestration (subject routing, envelope handling, status tracking, lifecycle management). Each adapter independently implements the full stack, making it expensive to add new platforms and difficult to swap underlying SDKs. The Telegram and Slack adapters each contain 400-500+ lines of streaming, buffering, and platform API code that follows similar patterns but is tightly coupled to their respective adapters.

## Decision

Introduce a `PlatformClient` interface that abstracts platform-specific communication below the `RelayAdapter` layer. A `RelayAdapter` owns a `PlatformClient` and delegates platform calls (postMessage, editMessage, stream, postAction, typing) to it, while retaining responsibility for lifecycle, subject matching, status tracking, and relay integration. Existing Telegram and Slack adapters are refactored to extract `GrammyPlatformClient` and `SlackPlatformClient` implementations. New adapters (e.g., Chat SDK-backed) implement the same interface using different underlying SDKs.

## Consequences

### Positive

- New platforms can be added by implementing PlatformClient (~100 lines) rather than a full RelayAdapter (~500 lines)
- Existing adapters become more testable — mock the PlatformClient to test relay orchestration in isolation
- Enables SDK swaps (e.g., grammy → Chat SDK) without touching relay-level code
- Standardizes platform capabilities across adapters (optional methods declare platform support)

### Negative

- Refactoring existing battle-tested adapters carries regression risk
- Adds an indirection layer that developers must understand when debugging delivery issues
- PlatformClient interface may need to evolve as new platforms expose capabilities not yet modeled
