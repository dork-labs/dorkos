---
number: 72
title: Cascade Disable Pulse Schedules on Agent Unregister
status: accepted
created: 2026-03-04
spec: agent-tools-elevation
superseded-by: null
---

# 72. Cascade Disable Pulse Schedules on Agent Unregister

## Status

Accepted

## Context

Agent-first scheduling links Pulse schedules to agents by `agentId`. When an agent is unregistered from Mesh, its linked schedules become orphaned — the agent ID no longer resolves to a project path. Three options were considered: (1) graceful fallback to stored CWD, (2) fail with error per-run, (3) auto-disable the schedule and record an error.

## Decision

Combine options 2 and 3: auto-disable all linked schedules when an agent is unregistered, AND fail any in-progress run with a clear error. The `disableSchedulesByAgentId()` method on PulseStore sets `enabled=0, status='paused'` for all schedules with the given `agentId`. The `resolveEffectiveCwd()` method throws an error if the agent is not found, causing the run to fail with a descriptive message. Unregistering an agent should remove it from all communications and schedules.

## Consequences

### Positive

- Prevents orphaned schedules from running against stale or wrong directories
- Immediate feedback — schedules visibly disabled in the UI
- Clear error message guides the user to re-link or delete the schedule
- Consistent with the principle that agent unregister is a significant lifecycle event

### Negative

- Requires re-enabling schedules manually after re-registering an agent
- If an agent is accidentally unregistered, all linked schedules stop immediately
- Adds coupling between Mesh unregister flow and Pulse subsystem
