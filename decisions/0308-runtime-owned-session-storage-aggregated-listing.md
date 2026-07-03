---
number: 308
title: 'Runtime-Owned Session Storage with Registry-Aggregated Listing'
status: accepted
created: 2026-07-02
spec: additional-agent-runtimes
superseded-by: null
---

# 308. Runtime-Owned Session Storage with Registry-Aggregated Listing

## Status

Accepted (implemented in spec: additional-agent-runtimes)

## Context

Claude Code sessions derive entirely from SDK JSONL files; test-mode sessions live in the in-process EventLog. With OpenCode (its own SQLite store, read via SDK) and Codex (thread files under `~/.codex/sessions`) arriving, the question is whether DorkOS should unify transcripts into one owned store or keep storage runtime-owned. Meanwhile `GET /api/sessions` lists from `runtimeRegistry.getDefault()` only (`routes/sessions.ts:64`), and `subscribeSessionList` watches only Claude's project directory — single-runtime assumptions that break the moment a second production runtime registers.

## Decision

Session storage stays **runtime-owned**: each adapter implements `listSessions`/`getMessageHistory`/`getSessionSnapshot` against its backend's native storage, exactly as the claude-code (JSONL) and test-mode (EventLog) implementations already do. There is no unified DorkOS transcript store. Cross-runtime uniformity comes from the existing shared layers: `session_metadata` (runtime binding, ADR-0255), the EventLog + `SessionStateProjector` for live turn state, and the per-session SSE delivery path. The session **listing and list-subscription layers move from default-runtime calls to registry aggregation**: merge `listSessions` across all registered runtimes (tagging each session with its runtime type) and fan-in each runtime's `subscribeSessionList` events into the global stream.

## Consequences

### Positive

- Zero migration risk and no dual-write consistency problem; each backend remains the source of truth for its own transcripts.
- Follows the proven pattern (two existing runtimes already work this way); the conformance suite can assert the contract per runtime.
- Sessions remain visible to native tooling (`claude`, `opencode`, `codex` CLIs) — DorkOS augments rather than captures.

### Negative

- List aggregation inherits each backend's listing performance and failure modes; a slow/failed runtime must degrade gracefully (partial list + warning, never a blank screen).
- Cross-runtime features (global search, unified export) must fan out per runtime rather than query one store.
- Session list ordering/pagination semantics must be defined at the aggregation layer.
