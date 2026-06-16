---
number: 277
title: Seat the v1 Autonomous Loop on DorkOS Pulse
status: proposed
created: 2026-06-14
spec: unified-workflow-system
superseded-by: null
---

# 277. Seat the v1 Autonomous Loop on DorkOS Pulse

## Status

Proposed

## Context

The poller must spawn a fresh, isolated, resumable session per issue (required by the context strategy and crash-recovery design). The existing autonomous Stop-hook and the /loop tick both keep a single session alive and accumulate context, so neither fits. DorkOS Pulse already provides a contextless croner loop that dispatches a fresh per-run agent session (sessionId = run.id), file-defined as a SKILL.md task.

## Decision

Seat v1 autonomous mode on Pulse: a project-scoped `.dork/tasks/flow-drain/SKILL.md` (cron) where each tick is one fresh per-issue run carried to its gate. This revises the original "v1 ships without a server" stance — autonomous mode now depends on a running DorkOS server (documented honestly in the package README). Manual mode (`/flow`, `/flow:<stage>`, `/flow auto`) stays server-free and portable; a generic `claude -p`-per-issue watcher is the documented portable fallback seat, not built in v1.

## Consequences

### Positive

- No scheduler to build; fresh, resumable, runtime-agnostic sessions with console visibility; collapses a chunk of DOR-89 server scope.
- Schedules are version-controlled files (file-first, ADR-0043 pattern).

### Negative

- Autonomous mode requires the DorkOS server (a deliberate, documented DorkOS-specific dependency).
- Reduces portability of the autonomous path until the generic watcher is built.
