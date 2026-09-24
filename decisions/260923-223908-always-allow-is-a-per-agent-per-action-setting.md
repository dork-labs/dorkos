---
id: 260923-223908
title: Always allow is a per-agent, per-action permission setting, and standing grants are retired
status: draft
created: 2026-09-23
spec: agent-permissions
superseded-by: null
---

# 260923-223908. Always allow is a per-agent, per-action permission setting, and standing grants are retired

## Status

Draft (extracted from spec: agent-permissions).

## Context

"Stop asking" existed only as standing grants: time-boxed windows, destructive calls only, and only with login on, because a login-off decision cannot prove a person (`standing-grant-posture.ts`). They lived in their own table and service, invisible from the agent's settings. A refusal from the tool-group gate or the tier ceiling had no "yes" at all (DOR-2093).

## Decision

We will give the request card three answers: **Allow** (this call), **Always allow** (this action, this agent, from now on) and **Deny**. Always allow writes `agent.permissions.actions[actionId] = 'allowed'` through the one permission service, in the same step as the grant, so the resumed call and the new setting agree. The server refuses `'always'` (409) when the approval names no requesting agent, the action has no area, or the area is a floor area; hiding the button is not the check. A Blocked agent asks past the block with `permissions.request_access`, which binds the approval to the target action and its exact arguments and is rate-limited (one pending per agent per area, 24 hours after a Deny, five an hour). Standing grants, their table, config keys, routes and the Control Center switch are removed, and live grants end at upgrade rather than turning into permanent settings.

## Consequences

### Positive

- A remembered answer is a setting the person can see, change and undo on the agent's Permissions page, not a window that silently outlives its posture.
- Every refusal an agent can meet has a way to ask.
- Always allow works with login off, and gives a shell adversary nothing it lacks today.

### Negative

- Always allow has no expiry; a person who wanted a time box must reset it by hand.
- Live standing grants end at upgrade, so a few people will see a card they had silenced.
- A new agent-facing capability (`request_permission`) and its rate-limit state to maintain.
