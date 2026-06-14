# flow — the `/flow` engine

> One unified, PM-agnostic workflow system spanning **capture → done**. A single
> identifiable installable unit: manual stages you drive from the terminal, and
> an autonomous loop seated on DorkOS Pulse.

This README is **the manual**. It is scaffolded in P0 (Phase 0 — Scaffold);
full prose lands in later phases. See [`SPEC.md`](./SPEC.md) for the contract.

> [!IMPORTANT]
> **Autonomous mode depends on a running DorkOS server (Pulse). Manual mode does
> not.** `/flow`, `/flow:<stage>`, and `/flow auto` (terminal draining) run
> without the server. The autonomous Pulse-seated loop (`.dork/tasks/flow-drain/`)
> requires the DorkOS server to be running to host the chokidar watcher + croner.

## Stages

_The spine: one stage model (capture · triage · ideate · specify · decompose ·
execute · verify · review · done). Full content lands in a later phase._

## Modes

_Trigger source (manual CLI vs PM-driven) is orthogonal to execution mode (step
vs autonomous). Manual + Step · Manual + Autonomous (`/flow auto`) · PM-driven +
Step · PM-driven + Autonomous (Pulse). Full content lands in a later phase._

## Command ↔ state map

_How each `/flow:<stage>` command maps to its tracker stage label + state
category. Generated from [`config.json`](./config.json) `stages`. Full content
lands in a later phase._

## Gates

_The hard gates: question / soft-escalation · plan-approval (off by default) ·
human-review (always on) · circuit breaker. Plus the auto-merge recovery ladder.
Full content lands in a later phase._

## Adapter interface

_The `adapters/linear/` skill is the v1 `PMClient`: it owns every tracker call
and fulfils the capability verbs as a documented prose contract. All tracker I/O
flows through this one skill. Full content lands in a later phase._

## Autonomous mode & the server dependency

_The autonomous loop is seated on DorkOS Pulse via a file-based schedule
(`.dork/tasks/flow-drain/SKILL.md`). One tick = one issue. **Autonomous mode
depends on a running DorkOS server (Pulse); manual mode does not.** Full content
lands in a later phase._

## Configuration

Defaults live in [`config.json`](./config.json), validated against the
Zod-generated `config.schema.json`. An optional per-repo `WORKFLOW.md` override
sits at the repo root.
