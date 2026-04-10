---
number: 55
title: Use SSE Streaming for Filesystem Discovery Results
status: draft
created: 2026-03-01
spec: first-time-user-experience
superseded-by: null
---

# 55. Use SSE Streaming for Filesystem Discovery Results

## Status

Draft (auto-extracted from spec: first-time-user-experience)

## Context

The FTUE agent discovery step scans the user's home directory for AI-configured projects (looking for AGENTS.md, .claude/, .cursor/, .github/copilot, .dork/agent.json markers). Home directories can contain thousands of directories, making scan times unpredictable — from seconds to minutes. A synchronous REST response would leave users staring at a spinner with no feedback until the entire scan completes.

## Decision

We will use Server-Sent Events (SSE) to stream discovery results progressively. The `POST /api/discovery/scan` endpoint returns an SSE stream with three event types: `candidate` (each discovered agent), `progress` (scanned directory count), and `complete` (final summary with timing). The server uses an async generator that yields results as the filesystem traversal finds them. A 30-second timeout stops the scan and emits `complete` with `timedOut: true`.

## Consequences

### Positive

- Users see agents appearing in real-time as they're found, creating a sense of activity and progress
- No timeout-related failures — partial results are always useful
- The progressive display enables the three-beat celebration animation (staggered card entrances)
- Same SSE infrastructure already used for session sync and Relay streams

### Negative

- SSE connections hold the HTTP connection open for the scan duration (up to 30 seconds)
- Client must handle partial results and the possibility of a timed-out scan
- POST-initiated SSE is less standard than GET-based SSE (requires fetch then EventSource bridging)
