---
number: 61
title: Use Spawn-and-Exit Pattern for Server Restart
status: accepted
created: 2026-03-01
spec: settings-reset-restart
superseded-by: null
---

# 61. Use Spawn-and-Exit Pattern for Server Restart

## Status

Accepted

## Context

DorkOS needs a server restart capability triggered from the client UI. The server runs in two modes: development (via turbo/nodemon) and production (via the `dorkos` CLI). In dev mode, `process.exit(0)` is sufficient because nodemon detects the exit and auto-restarts. In production CLI mode, there is no external process manager watching the server — `process.exit(0)` would simply terminate the process with no restart.

Alternative approaches considered: cluster module (overkill for single-user local tool), pm2/systemd integration (external dependency, not DorkOS's concern), and exit-only with a "re-run manually" message (poor UX).

## Decision

Use a spawn-and-exit pattern for production mode: spawn a new server process using `child_process.spawn(process.argv[0], process.argv.slice(1), { detached: true, stdio: 'inherit', env: process.env })`, unref the child, then call `process.exit(0)`. In development mode (`NODE_ENV === 'development'`), use `process.exit(0)` alone since nodemon/turbo handles restart.

The `triggerRestart()` helper branches on `NODE_ENV` to select the appropriate strategy.

## Consequences

### Positive

- Automatic restart without user intervention in all modes
- Inherits all environment variables set by the CLI (DORK_HOME, DORKOS_PORT, etc.)
- Simple implementation with no external dependencies
- Clean process lifecycle — old process fully exits before new one takes over

### Negative

- Small window where no server is running (not zero-downtime)
- `process.argv[0]` may behave differently on Windows (needs testing)
- Spawned child inherits stdio but not terminal control — interactive CLI features may differ
