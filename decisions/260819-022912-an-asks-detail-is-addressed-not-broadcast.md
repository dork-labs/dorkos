---
id: 260819-022912
title: An Ask's detail is addressed, not broadcast
status: accepted
created: 2026-08-19
spec: ask-entitlement
extractedFrom: ask-entitlement
superseded-by: null
---

# 260819-022912. An Ask's detail is addressed, not broadcast

## Status

Proposed (extracted from spec: `ask-entitlement`, DOR-1356).

## Context

The global event stream (`GET /api/events`, served over both a WebSocket and SSE through
`eventFanOut`) has always meant one thing by "broadcast": write this frame to every
connected client. That was true of every event it carried, because each one was a fact the
caller could already read from its own resource route.

`interaction_pending` broke that property. It carries a prompt an agent is parked on,
including the tool name, the command or file path it would run against, and the session's
working directory. Every caller the session gate admits receives it, and a caller
presenting `X-DorkOS-Agent` is one of those: with login off it needs no credential at all,
and with login on an agent legitimately holds one of the person's per-user API keys. So an
agent could hold the stream open and read every pending shell command in every project on
the machine, live, while being structurally unable to answer any of them
(`requirePersonToAnswer`). The same was true of `GET /api/sessions/pending-interactions`.
The unified-conversation programme recorded this as P3's Known Issue 23 and named the fix
as a change to the fan-out's addressing model.

## Decision

An Ask's detail is delivered only to a caller who may act on it, and the fan-out learns
how to say that.

1. Every connection registers with a `CallerPrincipal` — a **required** argument to
   `eventFanOut.addClient`, read from the same `res.locals`-shaped facts both transports
   already carry. A default would be a silent allow for the next stream somebody adds,
   which is the argument `UpgradeRoute.credential` already makes for the upgrade router.
2. `broadcast` takes an **optional** audience predicate. Omitted means everyone, which is
   what every event on this bus has always meant and what all but one still mean. The
   frame is still encoded exactly once per wire format; the audience decides only who it
   is written to, and in-process listeners always receive.
3. One predicate, `askEntitlement(principal, subject)`, answers both the stream and the
   list route, and is the shared statement of who may answer that the six answer routes'
   guard is bound to by a conformance test. Its rule is that the detail follows the answer
   right: an agent gets nothing, the operator gets everything, a program holding the
   person's own key may see but not act, and a person on a bridged chat may act only when
   the room's approver allowlist names them.

## Consequences

### Positive

- The one real reader that could see an Ask and never answer it stops seeing it, and the
  claim "only whoever may answer sees the detail" becomes true rather than nearly true.
- The list route and the live stream cannot drift, because they call one function. That is
  the failure `lib/caller-authority.ts` argues matters more than a wrong answer.
- A second person, whenever DorkOS gets one, is a change to one function rather than to
  four surfaces.
- The bridged approver becomes expressible at all, which is what lets a room-bound Ask
  become actionable on Telegram without inventing a second policy.

### Negative

- The fan-out now carries a second concept, and every future stream that joins it has to
  state a principal. That cost is deliberate and is the point of the argument being
  required.
- One event on the bus behaves differently from the rest, which a reader has to notice.
  Mitigated by the audience being visible at the one call site that passes it.
- `interaction_resolved` is deliberately left unaddressed, so the pair is asymmetric.
  Stated in the spec's "What is not done" rather than smoothed over.
