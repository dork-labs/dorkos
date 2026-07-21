---
id: 260721-153851
title: Derive session origin at read time from transcript-head markers
status: proposed
created: 2026-07-21
spec: session-origin-legibility
superseded-by: null
---

# 260721-153851. Derive session origin at read time from transcript-head markers

## Status

Proposed

## Context

Every session-creating pathway (cockpit chat, Relay agent-to-agent, channel bindings, Pulse runs, A2A) converges on the same runtime session store, and `SessionSchema` carried no origin information, so the UI could not distinguish an operator's conversations from automated sessions. The only durable origin traces are markers our own code writes into the transcript head: the `<relay_context>` block with a server-injected `From:` line, and Pulse's run records. Two of the pathways (relay agent-handler, Pulse scheduler) bypass the normal `triggerTurn` pipeline entirely, so any creation-time stamping hook would miss exactly the sessions that matter, and stamping is not retroactive for existing transcripts.

## Decision

We will classify session origin (`user | agent | channel | task | external`; absent means `user`) at read time, in two steps: (1) a pure classifier over the first user message inside the existing ~8KB head-scan of the claude-code transcript reader, parsing the `<relay_context>` `From:` subject; (2) a runtime-agnostic overlay at the session aggregation layer that marks sessions found in the Pulse run store (`pulseRuns.sessionId`) as `task`, keeping runtime adapters free of task-service dependencies. Origin is never persisted and never treated as a security boundary. Creation-time stamping into `session_metadata` remains a possible future hardening, not part of this decision.

## Consequences

### Positive

- Retroactive: every existing session classifies correctly with no migration and no backfill.
- Cannot miss the bypass paths — classification reads the artifact those paths already produce.
- Zero added IO: rides the existing head buffer and mtime cache; the Pulse overlay is one batched indexed query.
- The classifier is a pure function with table-driven tests, including a fixture pinned to `formatPromptWithContext` so marker drift fails a test.

### Negative

- Heuristic coupling to marker text produced elsewhere in the repo (`agent-handler.ts`, task run records); format changes require updating the classifier (mitigated by the coupling test, and both producer and consumer live in this repo).
- Claude-code-specific in step 1; a future runtime that receives relay traffic would need its own head classification (step 2's overlay is already runtime-agnostic).
- A caller who can publish raw relay messages can influence the advisory label (accepted: single-operator local cockpit, origin is UX-only).
