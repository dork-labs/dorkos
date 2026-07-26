---
id: 260726-234120
title: A supervised server refuses the lifecycle operations only its supervisor can perform
status: accepted
created: 2026-07-26
spec: null
superseded-by: null
---

# 260726-234120. A supervised server refuses the lifecycle operations only its supervisor can perform

## Status

Accepted (2026-07-26, DOR-532, PR #503).

## Context

`POST /api/admin/restart` and `POST /api/admin/reset` both end the server process
and count on something bringing it back. `triggerRestart()` (`routes/admin.ts:79`)
does that by spawning `process.argv[0]` with the current argv and exiting 0. That
works for the CLI, which really is a Node process re-execing itself, and in dev,
where `tsx watch` restarts on exit.

It cannot work when the Electron shell owns the process. In a packaged build the
server runs as an Electron `UtilityProcess`, where `process.argv[0]` is the **app
executable, not Node** — there is nothing to re-exec into (`server-spawn.ts:41-51`).
The endpoint therefore spawned something that could never serve, then exited 0. At
the time, the desktop inferred liveness from an exit-code heuristic and treated 0 as
normal, so nothing was reported and `getServerPort()` kept handing the renderer a
dead port (`apps/desktop/src/main/server-process.ts:12-16`).

`/reset` was worse: it deletes the data directory _before_ it exits
(`routes/admin.ts:159-168`). The failure mode was "your data is gone and the app
is now talking to nothing."

Both endpoints are wired to shipped buttons in Settings → Advanced
(`apps/client/src/layers/features/settings/ui/AdvancedTab.tsx`, via
`system-methods.ts:485` and `:496`).

## Decision

**A server that knows it is supervised refuses the operations only its supervisor
can perform.** A supervisor that starts DorkOS as a child it does not restart
declares itself by setting `DORKOS_MANAGED_BY` in the server's environment; the
desktop shell sets `desktop` before spawning (`server-spawn.ts:52`, `:296`). The
admin router then answers 409 with the stable code `MANAGED_BY_DESKTOP` instead of
exiting (`routes/admin.ts:130-139`). Setting the variable is the supervisor's half
of the contract; refusing is the router's half, and neither half knows anything else
about the other.

The refusal is `router.use` over the whole router, not a check inside each handler
or a path allowlist. Every route here ends the process and one of them deletes the
data directory first, so "which path is this" must not be able to decide whether the
guard runs. An earlier revision keyed off `req.path` and Express 5's non-strict
routing walked around it — `POST /api/admin/reset/` reached the handler and ran
`fs.rm(dorkHome, { recursive: true })` in the one mode the guard exists to prevent.
Only the message copy is chosen by path, and that lookup is allowed to fall back
(`routes/admin.ts:117-124`, `:59`).

It also sits **ahead of** the rate limiter (`routes/admin.ts:141`). A desktop-managed
refusal is a fixed fact about the deployment, not load to shed; behind the limiter, a
person tapping Restart four times got "Too many admin requests" for five minutes
instead of the explanation.

The 409 copy completes the user's actual intent where it honestly can: restart says
to quit and reopen the app, which does the same thing; reset says plainly that
nothing was deleted and names the folder to remove (`routes/admin.ts:31-40`).

## Consequences

### Positive

- The destructive path is closed in the mode where it was destructive. Reset cannot
  delete the data directory out from under a shell that will not restart the server.
- The contract is one environment variable, so a future supervisor (a launchd agent,
  a systemd unit, a container entrypoint) opts in by setting it, with no new code
  server-side. `desktop` is the only value today.
- Refusing at the router means a new admin route inherits the guard rather than
  having to remember it.
- The desktop app is no longer reachable from a state where its own UI ends its
  server.

### Negative

- **A working feature was traded for safety.** Desktop users get a 409 and an
  explanation where they previously got a button that appeared to work. Quit-and-
  reopen is a real substitute for restart; there is no in-app substitute for reset.
- **This is a stop-gap, not the destination.** The proper fix routes both actions
  through the supervisor that already owns the lifecycle — the state machine DOR-533
  landed in `apps/desktop/src/main/server-process.ts`, which since #500 treats every
  unexpected exit as a crash and can stop and restart the child deliberately. That
  work is **DOR-542** ("Desktop: make Restart Server and Reset All Data work again,
  via the supervisor"). Whoever picks it up should replace this refusal, not build
  alongside it.
- The client does not branch on `MANAGED_BY_DESKTOP` yet. `system-methods.ts` throws
  the raw response text and the Advanced tab passes it to `toast.error`, so a person
  is shown the whole JSON body with the sentence inside it. Each message is written
  to survive that, which is a workaround for a client fix that is still owed
  (`routes/admin.ts:11-18`).
- `triggerRestart()`'s `process.argv[0]` assumption is still wrong in principle; it
  is now merely unreachable in the one environment that broke it.

### The same lesson from the other end

This ADR says a lifecycle operation belongs to whoever owns the lifecycle. The
converse is also true and is easier to miss: **an operation the supervisor delegates
to a platform installer may silently not happen, so the code either side of it must
not assume the process is about to exit.** `autoUpdater.quitAndInstall()` is the live
example — reached from the in-app "Restart to install" card via `restartToInstall()`
(`apps/desktop/src/main/auto-updater.ts:267`) and from the native dialog
(`:156`), with `index.ts:231-241` describing a two-stage quit dance built on the
assumption that the call is on its way out of the process. Review of PR #511 found
that assumption does not hold: on macOS the call can return with the app still alive
whenever the native download has not finished, and `update-downloaded` — which raises
the card at `auto-updater.ts:139` — fires well before that point, which is exactly
when a person clicks. Nothing here is decided by this ADR (#511 has not merged), but
whoever revisits either side of the lifecycle boundary should treat "I called the
thing that exits" as a request, not a fact.

### Alternatives considered

- **Detect the supervisor instead of being told.** Sniffing `process.versions.electron`
  or the executable name works today and breaks the moment a second kind of
  supervisor appears; a declared contract costs one variable and generalizes.
- **Make the restart work under Electron** (re-exec the app, or ask the shell over
  the existing message channel). Rejected for this PR: it is the right answer, it
  belongs on the desktop side of the boundary, and it was not going to be written
  correctly in a security fix. Filed as the follow-up above.
- **Refuse only `/reset`.** Rejected: restart's failure is quieter but not smaller —
  the app is left pointed at a dead port, which is indistinguishable from a hang.
- **Key the refusal off the path.** Rejected on evidence: that is the revision Express 5's
  non-strict routing defeated with a trailing slash.
