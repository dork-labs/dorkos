---
id: 260829-085852
title: An update is not installed until the next launch says so
status: accepted
created: 2026-08-29
spec: desktop-updater-overhaul
superseded-by: null
amends: null
---

# 260829-085852. An update is not installed until the next launch says so

## Status

Accepted. Shipped in the Desktop Resilience program (DOR-1454).

## Context

An early user spent ten days on v0.59 while the app downloaded and staged 0.60, 0.61, 0.62 and 0.63
in turn. She clicked "Restart to install" repeatedly; each time the app quit and came back on the
old version. **No error was raised anywhere** — not in the UI, not in the log, not by the updater.
Squirrel's install runs after our process is gone and its failures are undetectable in-process
(electron/electron#8912), so nothing inside the running app was ever in a position to notice.

The card made it worse rather than merely failing to help. `foldStatus` deliberately kept "Restart
to install" showing over any later `error`, and `lastStatus` lived in memory, so a failure could not
survive the restart that caused it. The app's only claim about updates was one it had no way to
check, and it repeated that claim for ten days.

## Decision

**We will treat "installed" as a claim verified at the next launch, not an outcome assumed at
quit.** Before the app quits to install, `recordUpdateInstallIntent()` writes
`<userData>/updater-intent.json` — `{ offeredVersion, attemptedAt, attempts }` — from **both**
install paths (the explicit restart and the `autoInstallOnAppQuit` quit), guarded so one restart
counts once. On the next launch, `judgeLastInstallAttempt()` runs before the first update check and
compares the running version against the offered one: at or above it, the attempt succeeded and the
file is deleted; below it, the install failed, and the app says so with an `install-failed` status
carrying the version and the attempt count.

**A failed install is never papered over by a later success signal for the same version.** The
updater re-stages the same build on every 4-hourly check, so `install-failed` is cleared only by a
`downloaded` for a strictly _newer_ version.

**We never re-offer the restart that just failed.** The card drops the restart button entirely and
offers "Download fresh copy — your settings and agents stay put", opening the platform's download
page. That bypasses Squirrel, which is the one remedy that works for every known per-machine wedge.

The intent file is a plain JSON file, deliberately not `conf`-backed config: it is machine state
about one attempt rather than a preference, and it is written from a quit path where a schema
migration is the last thing anybody wants running. A record whose `offeredVersion` does not parse as
strict semver is discarded on read rather than kept, because every comparison against an unreadable
version answers "below", which reads as failure — a permanent, unclearable failure card.

## Departures from the spec, made during implementation

- **The fallback is offered on the first failure, not after two.** `02-specification.md` decision 4
  gated "Download fresh copy" behind `attempts >= 2`. As shipped there is no threshold in the
  client. Asking someone to re-run the thing that just silently failed, to earn the remedy, is the
  behaviour this program exists to delete.
- **The attempt count never reaches the UI.** It stays on the wire status for the main process's
  log line. The card says the same thing on the first failure as on the fifth, because the remedy is
  the same and a tally is not something the reader can act on.

## Consequences

### Positive

- The ten-day silence is structurally impossible: an install that does not take is reported by the
  next launch, from evidence on disk, without needing the updater to admit anything.
- The verdict rests on the app's own version number — the one fact that cannot be wrong about
  whether an install happened.
- The remedy in front of the user is the one that actually works, on the first failure.
- `main.log` now reconstructs the whole story end to end: click, server stop, `quitAndInstall`,
  intent written, next-launch verdict.

### Negative

- The failure is reported one launch late. Between the failed quit and the next start, the app still
  shows nothing wrong — the honest bound of detecting this from outside the process.
- A false positive is reachable: someone who manually downgrades after a successful install gets an
  `install-failed` card for an install that worked. The manual-overwrite path clears the intent when
  it purges, which covers the common shape of this, not all of it.
- A user who genuinely cannot install ever again sees the same card forever, with no escalation and
  no path back to the automatic updater without a manual download.
- One more file in `userData` that must be written on a quit path, kept parseable, and reasoned
  about whenever the version scheme changes.

## Alternatives rejected

- **Trusting the updater's `error` event.** It never fires for this failure. That is the entire
  problem.
- **Keeping the status in memory.** A failure that cannot survive the restart that caused it cannot
  be reported.
- **Letting `downloaded` keep priority over `error`.** The behaviour that made the card lie for ten
  days.
- **Gating the fresh download behind two attempts.** It charges the user a second silent failure for
  information we already have.
- **Storing intent in `~/.dork/config.json`.** A migration running inside a quit-to-install sequence
  is a new way to lose the record of what the restart was for.

## Related

- `260829-085854` — never intercept the updater's quit. Its stalled-restart watchdog reports through
  this ADR's `install-failed` status; the two ship as one honest surface.
- `260829-085855` — the staged-update purge, which clears this record when it removes an install
  nobody attempted.
- `260713-133412` — the Windows alpha, which rides the same release train and the same card.
- `plans/desktop-resilience-program.md` §2 — the user's ten-day log, evidence for every claim here.
