---
id: 260903-210711
title: An action's outcome outranks a server report, and the gate enforcing that lives in shared state
status: accepted
created: 2026-09-03
spec: null
superseded-by: null
amends: null
---

# 260903-210711. An action's outcome outranks a server report, and the gate enforcing that lives in shared state

## Status

Accepted

## Context

Two things move remote-access state and they are not peers: an ACTION somebody
took, and a REPORT from the server about what the tunnel is doing. Get the
precedence wrong and the newest fact loses to a stale one. That is GitHub #1458:
the dialog's sync effect listed its own local `state` in its dependencies and
wrote that same `state`, so every local transition re-ran it and pushed the
state back to `off`. A failed start rendered its error view for a single paint
before erasing it — "Try again" was unreachable, and every ngrok failure read to
the operator as "the switch did nothing".

DOR-1739 fixed it with a change gate held in a hook ref: apply a server report
only when it differs from the last one applied. That was correct and it was
un-reusable. When remote access grew two more surfaces (DOR-1743 — a Control
Center row and a top-bar beacon), each would have carried its own copy of that
ref, so each would have had its own idea of what was running: the row could sit
at "Off" while the beacon breathed. The same rule had to be rediscovered and
re-implemented, which is the signal that it was never a property of the dialog.

## Decision

We will treat the precedence rule as the durable decision, and hold the gate
that enforces it in **shared state** rather than in any one consumer.
`entities/tunnel`'s module-scope store owns `lastReport`, so N readers reduce one
report exactly once, and an action taken on any surface is visible on all of them
before the request settles. Consumers read; they do not each decide.

Three further rules follow from putting the gate there, and each is load-bearing:

1. **Read in two grades.** `useRemoteAccess()` is query-backed and reduces the
   server's report; `useRemoteAccessSnapshot()` reads the store alone. ⌘K's
   corpus takes the snapshot, so the command palette gains no data dependency on
   a tunnel and works unchanged in shells that have none.
2. **Mount the app-wide halves exactly once**, from the app shell:
   `useTunnelSync` (cross-tab and `tunnel_status` SSE) and
   `useRemoteAccessAnnouncer` (the toasts). Both were previously app-wide only by
   accident of `DialogHost` keeping the dialog mounted forever.
3. **Distinguish a re-answer from a replay.** The gate compares `dataUpdatedAt`,
   not just the report's facts. Identical facts at the same timestamp are a
   component MOUNTING and handing the cached answer round; identical facts at a
   newer timestamp are the server having actually been asked again.

## Consequences

### Positive

- The #1458 failure cannot come back per-surface. One reduction, one gate, and
  a local-only state (`starting`, `stopping`, `error`) is never disturbed by a
  report that says nothing about it.
- Adding a fourth surface costs a subscription, not a state machine. There is no
  longer a copy of the rule to get wrong.
- Optimism survives a mount. Opening the Control Center mid-start no longer
  snaps its row to Off over a tunnel that is coming up — the replay case above.
- Stale optimism no longer parks live chrome. A `connected` the server never
  confirms is corrected the next time the server re-answers, so the beacon
  cannot sit green over a dead tunnel until a reload.

### Negative

- The store is module-scope, so tests and the Dev Playground must reset it
  between cases (`resetRemoteAccessStore`, exported `@internal` for exactly those
  two callers).
- The gate now depends on the query's `dataUpdatedAt`. A caller that passes a
  constant collapses the replay and re-answer cases back together, silently.
  That is a sharp edge on an internal API; it is documented on the action and
  pinned by tests on both sides of it.
- **The residual, stated honestly.** The correction in rule 3 fires only when
  the server is asked again — on the config query's 30s staleness, a window
  focus, a `tunnel_status` event, or a cross-tab broadcast. Between a
  `settleStart` the server disagrees with and that next answer, a surface still
  shows the optimistic `connected`. The window is bounded and self-clearing, and
  it is the deliberate price of rule 1: closing it completely would mean
  believing every replay, which is the mount bug above. There is a second, much
  narrower residual in the same trade — if a server ever answered `off` between
  a successful start and its own config catching up, the UI would flicker
  connected → off → connected. `POST /api/tunnel/start` resolves only once the
  tunnel is up and `GET /api/config` reads the live manager, so this needs the
  server to contradict itself; we accept it rather than reintroduce permanent
  stale green.
- A failed start is no longer cleared by opening the dialog — a deliberate
  partial reversal of DOR-1739's opening-edge reset. It could not stand: the
  Control Center row reports the failure continuously and its "Fix…" link exists
  to open the dialog ONTO that failure. Errors now end when something changes (a
  retry, a saved token, a new server report), not when somebody looks at them.
  The dialog's two FIELD errors still clear on the opening edge.
