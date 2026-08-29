---
id: 260829-085851
title: A window is alive only while it keeps saying so, and a legible error counts
status: accepted
created: 2026-08-29
spec: desktop-renderer-supervision
superseded-by: null
amends: null
---

# 260829-085851. A window is alive only while it keeps saying so, and a legible error counts

## Status

Accepted. Shipped in the Desktop Resilience program (DOR-1453).

## Context

The desktop shell supervised its server child with a full state machine (`server-process.ts`) and
its renderer with nothing at all. `window-manager.ts` handled none of `did-fail-load`,
`render-process-gone`, `child-process-gone` or `unresponsive`, and `revealWhenReady`'s 4s timer
revealed whatever was there — including nothing.

v0.63.0 shipped a renderer bundle that threw `ReferenceError: __APP_VERSION__ is not defined` at
module scope. React never mounted, `#root` stayed empty, and an early user sat in front of a
permanently black window for days. **Not one of the four signals Electron offers would have fired.**
The page loaded successfully, the process was healthy and responsive; it simply painted nothing. A
supervisor built on failure events would have watched that window stay black and reported everything
normal, because from Electron's side everything was.

## Decision

**We define renderer health as a heartbeat, never as the absence of a failure event.** The renderer
reports over `renderer:alive` (`ALIVE_CHANNEL`) through the preload bridge; the supervisor arms a
`HEARTBEAT_DEADLINE_MS` (10s) deadline at every load and every navigation, and only a heartbeat
clears it. A heartbeat is counted only from the supervised primary window's own `webContents.id`
(`isSupervisedSender`) — another window cannot vouch for this one. Electron's failure events are
kept as _additional_ triggers, not as the definition.

**The ladder escalates on a counter that survives relaunch**, held in
`<userData>/renderer-health.json`:

| Rung | Action                                                                        |
| ---- | ----------------------------------------------------------------------------- |
| 1    | `webContents.reload()`                                                        |
| 2    | clear the HTTP cache (5s deadline), then reload                               |
| 3    | clear HTTP + GPU/code caches, persist `disableHardwareAcceleration`, relaunch |
| ≥4   | load the bundled static recovery page and stop healing                        |

The rung taken is `max(persistedCount, sessionCount) + 1`, because an unwritable `userData`
directory is a plausible cause of the very failure being recovered from, and a supervisor that
silently stops escalating when its notes stop saving is a supervisor that has stopped working. The
counter resets on any heartbeat; the hardware-acceleration flag is read at the top of
`main/index.ts` before `app.whenReady()` (it has no effect afterwards) and clears on the first
healthy heartbeat, so a GPU-disabled launch lasts one cycle.

**Not every crash is the renderer's fault.** GPU and network-service `child-process-gone` events are
recorded as context but never climb the ladder — Chromium respawns both, and a GPU process that
recovered on its own must not cost a healthy window a reload. They surface only as the _reason_
attached to a heartbeat that then fails to arrive. A load still in flight re-arms the deadline
rather than counting a failure, up to `LOADING_CEILING_MS` (60s): a slow load is not a failed load,
and reloading one makes it worse. Secondary windows get crash logging and no ladder — recovering the
primary is what matters, and two supervisors clearing one shared cache is worse than one.

## Why a painted error counts as alive

The boot sentinel inlined in `apps/client/index.html` reports alive on **both** of its exits: when
React mounts, and when it gives up and paints its own dependency-free panel naming the failure.

That second call looks wrong and is the crux of the decision. The thing this supervisor exists to
prevent is not "React failed to mount" — it is _a person looking at a rectangle that tells them
nothing_. A panel that says "DorkOS couldn't finish starting" is a bad outcome the user can act on,
and reloading it away is strictly worse: reporting only from the success path would have the shell
reload the explanation three times and then restart the app with its graphics acceleration off,
because a bundle threw. The ladder would run its full length against a page that had already done
the right thing.

The two 10s deadlines are deliberately equal. A bundle that throws paints the sentinel ~3s in, well
inside the shell's deadline, so the ladder never touches it. A page where genuinely nothing happens
leaves the sentinel waiting its full timeout, so the shell's deadline fires first and issues the
reload that a stalled load actually needs.

## Why the recovery page's powers are a place, not a flag

The recovery page can wipe storage and relaunch the app. Those three IPC handlers are gated by
`isFallbackPageSender` = the supervised window **and** `isFallbackUrl(contents.getURL())`, asked of
the live URL on every single call.

We deliberately did not latch a boolean when the page is loaded. A flag is a claim about the past;
this is a question about now. Other code (`server-crash-recovery.ts`) navigates that same window
back to the app, and a latch left set through such a navigation would hand the app — and every
third-party extension running inside it — the two actions that wipe storage and restart the
process. `isFallbackUrl` compares `resolve(fileURLToPath(url))` against the resolved fallback path
rather than matching URL text, because `file://` spellings differ in escaping and host form and
this is a security boundary. Same approach, for the same reason, as `window-manager.ts`'s
`isOwnOrigin`.

The recovery page is also the one surface in the app deliberately loaded with `loadFile` rather than
from the bundled server (ADR `260712-005315`), with inline CSS and no network: a page that explains
a failure must not share a dependency with the thing that failed.

## Consequences

### Positive

- The whole "packages green, black on install" class becomes detectable, and the same heartbeat is
  the assertion the packaged smoke test makes — the gate that would have caught v0.63.0.
- Recovery is silent and ordered: most users never learn anything happened, and the loudest outcome
  is a calm page with three buttons.
- Every renderer failure now logs one line with its rung and reason; previously all of it was
  invisible.

### Negative

- The client owes the shell a heartbeat forever. Any future surface loaded in the primary window
  must call `reportAlive()` or it will be reloaded three times and then replaced by the recovery
  page — a coupling from `apps/client` back to the desktop shell that did not exist before.
- The persisted counter is state that can be wrong. A machine that fails four times over four
  months, healing each time before a heartbeat lands, arrives at the recovery page for its fifth
  hiccup.
- Rung 3 spends a relaunch and the user's graphics acceleration on a guess that the GPU is at fault.
- Two 10s deadlines in two repos-worth of files (`index.html` and the supervisor) must stay equal
  and there is no mechanism holding them together, only a comment in each.

### Neutral

- Rung 1 reloads one tick late, via `afterTheStackUnwinds()`. That is measured, not stylistic:
  calling `webContents.reload()` from inside `render-process-gone`'s own stack kills the main
  process with `SIGTRAP`. No mocked test can see it — it was found by crashing a real renderer under
  a real Electron.

## Alternatives rejected

- **Supervising on Electron's failure events alone.** The incident that motivated this program fires
  none of them.
- **Treating the sentinel panel as a failure.** The ladder would reload away the one thing on screen
  that was helping, and end by disabling graphics acceleration because of a JavaScript error.
- **An in-memory counter.** Rung 3 relaunches the app; a counter that resets on relaunch can never
  reach rung 4.
- **A `isOnFallbackPage` boolean.** A latch that survives a navigation elsewhere grants storage-wipe
  and relaunch to ordinary page content.
- **Laddering every window.** Two supervisors clearing one shared cache race each other during the
  exact minute recovery matters.

## Related

- `260712-005315` — the packaged renderer is served by the bundled server over localhost. The
  recovery page is the deliberate exception, and the reason the URL gate can identify it at all.
- `260709-210223` — one `navigate` IPC channel. The same doctrine: a small, audited main→renderer
  surface rather than a growing per-feature one.
- `plans/desktop-resilience-program.md` §1, §4 Workstream 1 — the incident and its four missed
  safety nets.
