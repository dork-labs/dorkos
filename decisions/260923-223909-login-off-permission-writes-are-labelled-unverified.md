---
id: 260923-223909
title: With login off, permission writes are labelled unverified, and a tokenless agent gets the default
status: accepted
created: 2026-09-23
spec: agent-permissions
superseded-by: null
---

# 260923-223909. With login off, permission writes are labelled unverified, and a tokenless agent gets the default

## Status

Accepted (extracted from spec: agent-permissions). The residual below was accepted by the operator on 2026-09-23.

## Context

With login off, nothing tells the person in the app apart from a program on the same machine calling the API without its agent header (`decision-authority.ts`, DOR-505). The ideation wanted writes that "did not come through the app" recorded as unverified, which cannot be built honestly. Separately, an unidentified caller (an external `/mcp` client with no token, `dorkos call` without `DORKOS_AGENT_TOKEN`) has no agent whose overrides could apply.

## Decision

We will label every login-off person write "Someone on this computer", never "You", with the line "Login is off, so DorkOS can't confirm who made this change"; with login on it is "You (signed in as …)". Every permission route clears the same two bars the approval decide route clears, reusing its helpers, and records the posture on the event. Unidentified callers resolve against the defaults only: agent layers are skipped, Always allow is never offered, and `request_access` is refused. We accept the residual that an agent set **stricter** than the default which drops its own token gets the default, the same local-trust residual the tier ceiling and `roomsManage` carry today; turning on login closes it. User-facing copy says "Blocked stops an agent that plays by the rules; it isn't a sandbox" and never promises containment.

## Consequences

### Positive

- The audit trail never claims a certainty it does not have.
- The person's own `dorkos call` and tokenless MCP clients are not met with cards.
- No new reach for a local adversary: everything it could do before, it can still do, but now it leaves a visible, undoable history row.

### Negative

- With login off, Blocked is advisory against a hostile local process.
- A stricter-than-default agent can escape to the default by dropping its token.
