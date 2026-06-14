---
number: 240
title: SDK Warm-up via Never-Yielding Async Iterable
status: draft
created: 2026-04-10
spec: runtime-model-discovery
superseded-by: null
---

# 0240. SDK Warm-up via Never-Yielding Async Iterable

## Status

Draft (auto-extracted from spec: runtime-model-discovery)

## Context

The Claude Agent SDK requires a `Query` object to call `supportedModels()`, but creating a query normally requires sending a user message. On server startup and when the disk cache is stale, we need to fetch the model list without initiating a conversation. The SDK's `query()` function accepts `prompt: string | AsyncIterable<SDKUserMessage>` — passing an async generator that never yields creates a valid query that initializes the subprocess without sending a prompt.

## Decision

Use a never-yielding async iterable (`async function* () {}`) as the prompt parameter to create a "warm-up" query. Call `supportedModels()` on this query to populate the model cache, then `close()` the query to terminate the subprocess. Deduplicate concurrent warm-up calls via a shared promise.

## Consequences

### Positive

- Models are available before the user sends their first message
- No hardcoded defaults needed — always SDK-authoritative data
- The subprocess lifetime is brief (~1-2s) and only occurs on cold/stale cache
- Pattern is reusable for any SDK metadata that requires a query object

### Negative

- Depends on undocumented SDK behavior (never-yielding iterable not explicitly documented as a supported pattern)
- Spawns a Claude Code subprocess briefly on cold starts, adding ~1-2s startup latency
- If the SDK changes how it handles empty iterables, the warm-up could break
