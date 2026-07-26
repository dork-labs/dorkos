---
id: 260726-022250
title: Agent identity tokens expire on two clocks, seven days idle and thirty days absolute
status: accepted
created: 2026-07-26
spec: agent-trust
superseded-by: null
---

# 260726-022250. Agent identity tokens expire on two clocks, seven days idle and thirty days absolute

## Status

Accepted. Written after the fact on 2026-07-26; the decision was made in code during DOR-447.

## Context

Each spawned agent session gets a per-agent identity token. Because tokens are stored hashed and a hash cannot be reversed, an already-minted secret can never be handed out again, so the runtime env seam mints a fresh token per spawn. Tokens therefore accumulate, one per spawn, and all of them must stay valid at once: concurrent sessions for the same agent cannot be allowed to invalidate each other.

That accumulation makes lifetime a real question rather than bookkeeping. A token minted for a five-minute session last month would otherwise still act as that agent today, and once tiers are enforced against identity, a standing credential is a bypass surface: `tierCeiling` rides on the identity a token resolves to.

The obvious alternative was scoping a token to the session it was minted for. It is weaker here for structural reasons. The mint seam runs at spawn, before a session id exists to bind to, and sessions resume, fork, and are killed with no teardown hook that reliably fires, so "revoke when the session ends" would leak exactly the tokens it was meant to collect.

## Decision

We will expire tokens by time, on two clocks, whichever comes first (`apps/server/src/services/core/agent-identity/agent-identity-service.ts:156-160`):

- `TOKEN_IDLE_TTL_MS`: 7 days without use (`:69`). Long enough that an agent picked back up after a weekend keeps its identity, short enough that tokens from sessions nobody remembers are already dead.
- `TOKEN_ABSOLUTE_TTL_MS`: 30 days from minting, however often it is used (`:75`). Bounds how long any single minted secret can matter, even for an agent that never stops.

A clock needs no event to fire, which is the property session-scoping could not offer.

Expiry applies to the BEARER path only. `resolve()` enforces it, because a presented secret is what expiry protects against. `describeAgent()` does not: it presents no secret (the caller is structurally the agent whose session it is) and exists to read the agent's recorded tier ceiling, so letting a stale clock erase that identity would silently turn the ceiling OFF, which is the opposite of what expiry is for. Revocation, the operator's actual off switch, is an `agentPath`-wide sweep and applies to both.

`lastUsedAt` is rewritten only when it is more than `LAST_USED_WRITE_INTERVAL_MS` (5 minutes, `:84`) stale, so a busy agent writes once per interval rather than once per call.

## Consequences

### Positive

- No agent token is a standing credential. The worst case for a leaked token is bounded at 30 days, and at 7 days if it is not being exercised.
- Concurrent sessions for one agent never invalidate each other, because expiry is per token and revocation is deliberately per agent.
- Expiry needs no lifecycle hook, so it cannot be defeated by the ways sessions actually end (kill, crash, fork, resume).

### Negative

- The two windows are unconfigurable constants. An operator who wants a tighter policy has no knob, and the values are a judgment about how people work rather than anything derived.
- Tokens accumulate per agent, one per spawn, and expiry is evaluated at resolution rather than swept. Rows for dead tokens persist until something touches them; nothing reaps them today.
- The `describeAgent` carve-out means an in-session agent keeps its identity, and therefore its tier ceiling, regardless of token age. That is intended, but it means "agent identity expires" is only true of the token-presenting path, and anyone reasoning about in-session identity from this ADR should read the carve-out rather than the headline.
- Idle expiry is measured against a `lastUsedAt` that is deliberately up to 5 minutes stale, so the effective idle window is 7 days plus a small tolerance, not exactly 7 days.
