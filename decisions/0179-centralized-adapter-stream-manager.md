---
number: 179
title: Centralized AdapterStreamManager with AsyncIterable Streaming
status: accepted
created: 2026-03-22
spec: chat-sdk-relay-adapter-refactor
superseded-by: null
---

# 179. Centralized AdapterStreamManager with AsyncIterable Streaming

## Status

Accepted

## Context

The relay system delivers streaming agent responses as individual `text_delta` events, each arriving as a separate `deliver()` call to the adapter. Every adapter independently implements the same streaming orchestration: per-conversation buffer accumulation, throttled platform updates, done/error flushing, and approval_required stream interruption. Telegram's `outbound.ts` (~480 lines) and Slack's `stream.ts` (~500 lines) contain largely parallel logic. This duplication makes maintenance expensive and creates an impedance mismatch with streaming-native SDKs like Vercel's Chat SDK, which expect a single `AsyncIterable<string>` per conversation.

## Decision

Introduce a shared `AdapterStreamManager` at the relay level that intercepts StreamEvents before they reach adapters. The manager uses an `AsyncQueue<T>` (a zero-dependency push-pull async iterable, ~45 lines) to aggregate per-event `deliver()` calls into coherent `AsyncIterable<string>` streams. Adapters opt in by implementing an optional `deliverStream(threadId, stream, context?)` method on the `RelayAdapter` interface. Adapters that don't implement it fall back to the existing `deliver()` path unchanged. The `approval_required` event completes the current stream (flushing buffered text) then falls through to `deliver()` for platform-specific UI rendering.

## Consequences

### Positive

- Eliminates duplicated buffering/throttle/flush logic across adapters
- Maps directly to Chat SDK's `thread.post(asyncIterable)` model, enabling clean integration
- Centralizes stream lifecycle management (TTL reaping, error handling, concurrent stream tracking)
- Opt-in design preserves full backward compatibility — Webhook and Claude Code adapters are unaffected

### Negative

- Adds a new layer between the publish pipeline and adapters, increasing delivery path complexity
- Approval_required events require special handling (stream completion + fallthrough) rather than being part of the stream
- Adapters with custom streaming strategies (e.g., Slack's native streaming API) may need to bypass the manager for optimal performance
