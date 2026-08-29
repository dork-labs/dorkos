---
id: 260829-085854
title: The installer's quit is the one quit we never intercept
status: accepted
created: 2026-08-29
spec: desktop-updater-overhaul
superseded-by: null
amends: null
---

# 260829-085854. The installer's quit is the one quit we never intercept

## Status

Accepted. Shipped in the Desktop Resilience program (DOR-1455).

## Context

DorkOS owns quitting, because a quit can interrupt running agents and must stop the server child
cleanly. The quit guard did that uniformly: `before-quit` → `preventDefault()` → ask the person →
stop the server → issue a fresh `app.quit()`.

Applied to an update restart, that sequence cancels the exact termination Squirrel armed its install
against, and the `app.quit()` issued in its place is **a different quit**. The install never ran. A
user clicked "Restart to install" over ten days and got the old version back every time, with no
error anywhere — while the passive install-on-ordinary-quit path, which nothing intercepted, was the
one that eventually worked.

Stopping the server first looked like the whole fix, and it introduced a worse failure than the one
it removed. `MacUpdater.quitAndInstall()` quits only if Squirrel has confirmed the download;
otherwise it registers a deferred listener and **returns having issued nothing**. On that branch,
with the server already down and Squirrel then failing silently, no quit arrives, no `error` fires,
no event of any kind ever comes — and the app sits forever as a window in front of nothing. The old
code merely failed to update.

## Decision

**When the quit guard sees an armed update restart, it returns without calling `preventDefault()`
at all.** Squirrel's termination runs its native course, untouched. Everything the sequence would
have done has already happened, in `prepareUpdateRestart()`, in this order:

1. **Ask about interrupting agents first**, before anything is armed — `quitAndInstall()` is not
   cancellable once called, and on Windows the installer has already run by the time it quits.
2. **Record the install intent**, before the shutdown rather than after: a server that hangs on the
   way down must not cost us the record of what this restart was about to install.
3. **`await stopServer()`**, then arm the restart, then call `quitAndInstall()`.

The ordinary quit keeps the full guarded sequence; `autoInstallOnAppQuit` covers installs on that
path. The two quits are deliberately different code, and the module comment says so: _do not
"simplify" this split without preserving it._

**Stopping the server first is only safe with a recovery, so the recovery is part of this
decision.** Arming the restart also arms a 15s watchdog (`STALLED_RESTART_TIMEOUT_MS`). If the
process is still alive when it fires, `recoverFromStalledRestart()` restarts the server, re-points
every window at it, and pushes the same `install-failed` status a genuinely failed install produces.
The updater's `error` handler races the watchdog to the same recovery and the guard is cleared
before the first `await`, so exactly one of them runs. The confirmation the person gave is spent
once and expires after ten minutes (`RESTART_CONFIRMED_GRACE_MS`) — an answer must never carry into
an unrelated quit hours later.

## Consequences

### Positive

- The install actually applies, and the app relaunches into it: the ten-day failure is removed at
  its cause rather than reported after the fact.
- The stalled branch — previously an app alive in front of a dead server, forever — collapses into
  the honest `install-failed` card, with a working app behind it.
- Agents are protected on both paths, and asked exactly once, before anything irreversible.

### Negative

- Two quit paths exist and must both stay correct. The pass-through branch is one `return` whose
  absence of a call is the load-bearing part — the easiest thing in this codebase to "clean up" into
  a ten-day silent regression, and only a comment and a test defend it.
- Committing before the point of no return means nothing downstream can stop the quit; crash
  recovery has to read `isQuitting()` and stand down.
- The 15s watchdog is a guess about how long a handoff may legitimately take. Too short restarts a
  server that was about to go away; too long extends the dead-window window.
- The server is down during the handoff, so any failure between `stopServer()` and Squirrel's quit
  is only survivable because the watchdog exists.

## Alternatives rejected

- **Keeping the uniform quit sequence.** It is the cause. Squirrel's quit and ours are not
  interchangeable.
- **Stopping the server first with no watchdog** (the spec's original decision 6, amended during
  DOR-1455 review). "The sequence has nothing left to do" is false on the deferred branch, and the
  outcome there is worse than the bug being fixed.
- **Leaving the server running through the install.** The child would outlive the app or die
  uncontrolled mid-install, and its port would still be held by the relaunched version.
- **Asking about agents inside `before-quit`.** Too late to matter — the installer has already
  committed, and on Windows already run.

## Related

- `260829-085852` — an update is not installed until the next launch says so. The watchdog and the
  next-launch verdict deliberately surface through one status.
- `260829-085855` — identity-scoped purge of staged updates, the other half of not letting the
  updater act on things it has not proven.
- `plans/desktop-resilience-program.md` §2B — the evidence, including the `ShipItState.plist` with
  `launchAfterInstallation: false` that identified the passive path as the one that worked.
