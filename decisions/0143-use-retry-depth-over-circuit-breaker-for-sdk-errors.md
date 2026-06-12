---
number: 143
title: Use Retry Depth Parameter Over Circuit Breaker for SDK Errors
status: accepted
created: 2026-03-18
spec: sdk-error-observability
superseded-by: null
---

# 143. Use Retry Depth Parameter Over Circuit Breaker for SDK Errors

## Status

Accepted

## Context

The Claude Code SDK subprocess exits with code 1 for all failures (HTTP 529, auth errors, OOM, etc.). DorkOS's `executeSdkQuery` calls itself recursively when it detects a "resume failure" to self-heal stale sessions, but the pattern matching was too broad and the recursion had no depth guard — creating an infinite silent retry loop. Three approaches were evaluated: a retry depth parameter, session-level retry state, and the opossum circuit breaker library.

## Decision

Use a simple `retryDepth` parameter on `executeSdkQuery` with `MAX_RESUME_RETRIES = 1`. The circuit breaker pattern (opossum) was rejected because it wraps Promise-returning functions, not async generators — the SDK `query()` returns an `AsyncIterable`, making circuit breakers fundamentally incompatible without losing streaming. Session-level retry state was rejected as over-complex for the initial fix.

## Consequences

### Positive

- 4-line change that unconditionally breaks the infinite loop
- Preserves the existing stale-session self-healing behavior (one transparent retry)
- No new dependencies
- Compatible with the async generator streaming pipeline

### Negative

- Still retries a 529 once before surfacing the error (~4 minutes wasted on the retry)
- Does not prevent concurrent user re-submits from each triggering their own retry chain (session-level state would cover this)
- No half-open probing behavior like a true circuit breaker
