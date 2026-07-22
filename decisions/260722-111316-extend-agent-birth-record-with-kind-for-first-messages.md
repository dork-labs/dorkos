---
id: 260722-111316
title: Extend the agent-birth record with a kind field for user first messages
status: accepted
created: 2026-07-22
spec: dorkbot-is-the-onboarding
superseded-by: null
---

# 260722-111316. Extend the agent-birth record with a kind field for user first messages

## Status

Accepted

## Context

Dissolving the onboarding conversation into a real session requires navigating to `/session` and automatically sending the user's typed message as a normal user turn. The only production auto-send mechanism is the agent-birth kickoff (`AgentBirthRecord` + `useAutoKickoff` + `submitKickoff`), which deliberately suppresses the user bubble because it was built for "agent says hello first". The alternatives were a parallel pending-first-message store (a second mechanism with the same lifecycle, claim-by-path, and retry semantics to keep in sync) or query-param-driven auto-send (stringly, replayable on refresh, and a footgun for privacy in URLs, which the safety rules forbid for personal data).

## Decision

We will extend `AgentBirthRecord` with `kind: 'kickoff' | 'first-message'` (defaulting to `'kickoff'` so every existing call site is unchanged). `useAutoKickoff` submits `'first-message'` records through the normal submission path, so the message renders as the user's own bubble and reaches the server as a standard turn, with the same empty+idle+unfired guards and one-retry semantics. Future "start a session with a message" surfaces (e.g. the Tier 2 dashboard composer) use this same seam.

## Consequences

### Positive

- One auto-send lifecycle (register → navigate → claim → fire → retry/fail honestly) instead of two parallel mechanisms; the rekey and claim-by-path machinery is reused as-is.
- The seam generalizes: any surface that wants to open a session pre-loaded with a message now has a typed, tested path.

### Negative

- The birth store's name no longer fully describes its scope (it also carries user first messages); acceptable until a third kind forces a rename.
- A change in the live chat submission path requires regression coverage of the existing kickoff behavior.
