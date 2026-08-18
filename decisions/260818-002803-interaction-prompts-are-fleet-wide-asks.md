---
id: 260818-002803
title: An agent's prompt is a fleet-wide Ask, broadcast from the projector and answerable only by a person
status: accepted
created: 2026-08-18
spec: unified-conversation
superseded-by: null
---

# 260818-002803. An agent's prompt is a fleet-wide Ask, broadcast from the projector and answerable only by a person

## Status

Accepted. Shipped in P3 (`#1093`) and confirmed against the tree at P5
(DOR-1332): `interaction_pending` / `interaction_resolved` ride the global
stream from `SessionStateProjector`, `GET /api/sessions/pending-interactions`
answers the fleet-wide list, `requirePersonToAnswer` gates all six answer
routes, and `features/ask`'s card family (`AskCard`, `AskStack`, `AskList`)
draws the same prompt in the header, sidebar, home and the room/session lane.
Known gaps are named honestly rather than silently: the ten-minute timeout
still auto-denies (approvals tier C is the follow-on), and `resolvedBy` is
never populated on a single-identity install — both carried forward in
`specs/unified-conversation/04-implementation.md`'s closing follow-up list.

## Context

DorkOS has two kinds of "somebody has to say yes" and treats them oppositely. Capability approvals ride the global `/api/events` fan-out plus a list-on-mount endpoint, so they show up in a header pill, the sidebar and the home triage header on every route (`services/core/approvals/approval-events.ts`). The SDK tool prompts — the ones that actually stop turns, on a ten-minute fuse (`config/constants.ts:171`) — ride only the per-session stream. The global stream carries one coarse bit for them, `lifecycle: 'blocked'`, with no id, kind, tool or deadline, and the client attaches to one session at a time, so fine-grained pending state is structurally unavailable fleet-wide. `entities/attention/model/derive-attention-signals.ts:193-208` records the consequence in a comment and names the fix as a server change. The cost is measured: in DOR-784 agents sat silent 20–41 minutes because their prompt only existed in a session nobody had open, and a room's only recourse was a deliberately vague notice telling the person to go and find that session.

## Decision

We will make a parked prompt a first-class **Ask**: `interaction_pending` and `interaction_resolved` on the global fan-out, plus `GET /api/sessions/pending-interactions` for list-on-mount, carrying `PendingInteractionDTOSchema` verbatim rather than a second shape. Both are raised from `SessionStateProjector` through a listener seam beside `onProjectorStatusChange`, and broadcast by `session-list-broadcaster`, so the projector keeps its zero-transport dependency and every runtime that emits blocking-interaction events inherits the Ask with no adapter work. Answering keeps the six existing `POST /api/sessions/:id/*` routes, which now run `requirePersonToAnswer` — `resolveDecisionAuthority` plus `requireOperatorCookieUnderLogin`, the same fail-closed pair `routes/approvals.ts` uses. The payload carries ids, `cwd` and an optional `roomId`, never a denormalized agent name; the room correlates through that `roomId` rather than a second room-scoped signal, and `RoomTurnWaiting` and the durable waiting notice are untouched.

## Consequences

### Positive

- A prompt is answerable from wherever the person is, and the ten-minute fuse stops being a race against navigation.
- One card family serves every surface because one DTO serves every path; the per-session stream and the global stream cannot disagree about what is pending.
- Codex and OpenCode get the Ask for free: the projector is the runtime-agnostic fold, not one runtime's map (which lives on `runtimes/claude-code/agent-types.ts:95`).
- The "requester never self-approves" rule becomes structural rather than an id comparison — a caller presenting an agent identity header cannot reach the answer path at all, and a header that failed to resolve still counts as a machine calling.
- The room's privacy rule survives intact: detail rides a per-caller stream, never a room entry, so nothing new reaches a bridged platform.
- `derive-attention-signals`' degradation, where a background agent's question was tiered as a permission prompt, is deleted rather than documented.

### Negative

- Two more names on the `GENERIC_EVENTS` allowlist, which is a client constant the server never imports; only a textual cross-scan test connects the ends.
- The answer routes get stricter. Any integration that answered a prompt with a per-user API key under login-on now gets a 403 — deliberate, and the same break DOR-474 took for capability approvals.
- The list endpoint answers for the recent fleet, not for all history: a projector lives until its session is evicted or the process restarts. That bound is inherited, not introduced, but it is now visible on a public route.
- Clients must dedupe: the attached session holds the same interaction id in its own store, so one rule has to say which copy owns `remainingMs`.
- Ordering matters and is easy to get wrong. The list route must be registered above `GET /:id`, and the broadcast must fire after the interaction is recorded, or a fast subscriber reads an empty list.
