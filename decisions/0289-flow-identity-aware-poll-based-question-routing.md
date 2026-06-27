---
number: 289
title: Identity-Mode-Aware, Poll-Based Question Routing
status: proposed
created: 2026-06-25
spec: flow-triage-feeds-loop
superseded-by: null
---

# 289. Identity-Mode-Aware, Poll-Based Question Routing

## Status

Proposed (extracted from spec: flow-triage-feeds-loop)

## Context

When the loop runs unattended and hits a genuine `stop-and-ask`, it must route the question,
record it durably, and resume on the answer. `resolveCommsChannel` is identity-blind today
(it keys only on the live-session signal), and in shared-account mode `assignToHuman` is a
no-op and the tracker will not notify the human (actor equals notified), so a parked question
is unseen (charter G4 / G10, partial). Answer detection already works in shared mode via the
`identity.marker` (a comment without it is the human's), and DorkOS has no inbound webhook
endpoint, so resume must be poll-based.

## Decision

`resolveCommsChannel` takes an `identityMode` input and adds a third channel,
**`comment-and-nudge`** (unattended + shared): a durable question comment + `agent/needs-input`

- an out-of-band nudge (Relay/Telegram/chat) **promoted from courtesy to primary**;
  unattended + two-account routes to `comment-and-assign`; a live session stays `interactive` in
  any mode. Resume is **poll-based and tracker-agnostic**: an inbox reconciler polls `getInbox`,
  uses `shouldRespondToComment` rule 3 (the marker as disambiguator) to detect a non-agent
  reply, then re-attaches the worktree and resumes the session. Linear Agent Accounts
  (`actor=app`) are an optional, adapter-confined two-account backend, deferred until a reachable
  relay exists; a regular account always works.

## Consequences

### Positive

- Both shared and two-account modes get a working ask / notify / detect / resume path; no
  inbound webhook is required and no path assumes two identities (charter G10).
- The durable record + marker-based detection make a parked question recoverable across a
  crash and resumable without a human re-trigger (charter G4).

### Negative

- Shared-mode notification depends on a configured nudge channel; with none configured the
  durable comment is the only signal.
- Truly hands-off resume needs the running reconciler loop (P5) to poll on a cadence; v1 lands
  the typed channel + the poll/resume reconciler but full unattended resume completes under P5.
