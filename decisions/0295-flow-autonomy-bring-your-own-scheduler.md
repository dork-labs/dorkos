---
number: 295
title: /flow autonomy is bring-your-own-scheduler (pluggable scheduler)
status: accepted
created: 2026-06-26
spec: flow-marketplace-package
superseded-by: null
---

# 295. /flow autonomy is bring-your-own-scheduler (pluggable scheduler)

## Status

Accepted (implemented in spec: flow-marketplace-package; shipped in `dork-labs/marketplace` `plugins/flow/`)

## Context

Autonomous `/flow` (Pulse) was assumed to require the DorkOS server, but that coupling is incidental:
the only server-specific piece is that the `flow-drain` tick happens to be fired by the server's
task-scheduler. The per-tick work (`/flow auto` and the single-tick `runTick`) is already server-free.
Claude Code has no native scheduler (plugin "monitors" are session-scoped event streams, not crons), so
a portable plugin cannot self-schedule; an external scheduler must fire the tick.

## Decision

Autonomy is bring-your-own-scheduler: the same tick `SKILL.md` is fired either by the DorkOS
task-scheduler (the premium host: a UI, token-efficient idle ticks via a deterministic pre-check, and
ADR-D's production-gate + leader-lock) or by OS-cron / CI (server-free). The P5 server is the premium
host, not a prerequisite for autonomy. A headless stop-and-ask parks on the tracker and nudges
(`comment-and-nudge`), since no human is at the terminal.

## Consequences

### Positive

- Autonomy ships without the P5 server; any repo can wire OS-cron or CI.
- One tick definition serves every host; the scheduler is swappable.

### Negative

- The portable plugin defines the schedulable tick but cannot fire it itself; the adopter must wire a
  scheduler (the `enabled: false` default keeps this opt-in).
- Cloud 24/7 (laptop closed) still requires a hosted runner (CI or a deployed DorkOS server), independent
  of this decision.
