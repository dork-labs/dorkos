---
slug: desktop-watchdog-hardening
number: 260914-230211
created: 2026-09-14
status: specified
---

# Desktop renderer watchdog hardening

**Status:** Specified (Frozen)
**Author:** Quill
**Date:** 2026-09-14
**Ideation:** `specs/desktop-watchdog-hardening/01-ideation.md`
**Research:** `research/20260914_desktop-watchdog-hardening.md`
**Project:** Desktop Resilience

## Overview

The desktop app's renderer watchdog shipped two reload-loop defects nine days apart (GitHub #1840, fixed by PR #1853; GitHub #1860, fixed by PR #1862). Each took about a day to diagnose, each was found only because a user opened `~/Library/Logs/@dorkos/desktop/main.log` by hand, and neither was catchable by any test in this repo or by the packaged smoke.

This specification replaces the shape both defects came from. The shell gets exactly one way to replace the document it supervises, and that one way stamps the identity of the load and arms the deadline before issuing it. Navigations the shell did not issue keep the narrow predicate PR #1862 introduced, with a measured tolerance on the identity test and two ways to disarm a navigation that starts and never commits. A reload floor bounds the damage of whatever comes next. The health record stops being able to say a looping install is healthy, the packaged smoke fails on a loop, and a bug report carries the shell's own log so the next diagnosis is a paragraph instead of a day.

Phase 1 is the next full release. Phase 2 is the real-Electron contract harness, the loop detector with its in-app notice, and the keepalive that makes "alive" mean alive.

## Background / Problem Statement

`apps/desktop/src/main/renderer-health/index.ts` arms a 10-second deadline when it believes a new document is loading, and counts silence past that deadline as a failure that walks a recovery ladder ending in a static recovery page (ADR `260829-085851`). Both incidents are one defect seen twice: the supervisor arms on an event wider than its own contract, and it cannot tell which document owes it the answer.

- **#1840 (0.74.0), the identity half.** A heartbeat from the page a reload had already discarded arrived 108 to 134 ms later and was accepted, zeroing `failuresThisSession`. The ladder was pinned on rung 1 forever: 92 failures across two launches, all "Failure 1", while `/api/health` answered 45 out of 45 in 1.0 to 5.4 ms and both PIDs stayed stable. PR #1853 added a hand-stamped watermark at five call sites.
- **#1860 (0.75.0), the arming half.** `did-start-loading` fires on the host `webContents` for sub-frame loads and for same-document navigations (`pushState`, `replaceState`, hash), none of which produce a heartbeat. Any in-app route change, and every iframe load in the room canvas browser, armed a deadline nothing could clear. PR #1862 narrowed the predicate to `did-start-navigation` with `isMainFrame && !isSameDocument`.

What is left after both fixes:

1. The identity stamp is a coupling five call sites must remember and three still forget (`window-manager.ts` `createWindow`'s own first load, and the two `menu.ts` reload roles).
2. `did-start-navigation` is evaluated at navigation start, which Chromium documents as a moment that may never lead to a document: "a renderer process can easily start a navigation which is guaranteed not to commit (e.g. by navigating to a URL returning a response with HTTP status code of 204 or a download)". The reviewer on PR #1862 found a live instance: `applyLinkPolicy` calls `preventDefault()` on a `will-navigate` to a foreign origin, and the resulting `did-fail-load` carries `ERR_ABORTED`, which the supervisor ignores by design.
3. `onDeadlineExpired` re-arms while `win.webContents.isLoading()` is true. Electron documents that as "whether web page is still loading resources", against `isLoadingMainFrame()`, "whether the main frame (and not just iframes or frames within it) is still loading". A page with a slow or streaming iframe defers a genuine failure for the full 60-second ceiling. Same root cause, same file, not yet reported.
4. `RendererHealth` has one counter and a heartbeat zeroes it, so an infinite reload loop reads as a perfectly healthy install, in the file the packaged smoke reads to decide whether the build renders. All three of `rendererPaintFailure`'s claims were true throughout both incidents.
5. The desktop main-process log reaches no bug report. `POST /api/feedback` attaches a server log excerpt only; `main.log` is collected only by the manual diagnostics archive, reached from the recovery page.

## Goals

- A person reporting the next reload loop attaches evidence that names the cause, without being asked to find a log file.
- One wrapper owns every page replacement the shell issues, and stamps identity and arms the deadline itself.
- A navigation that starts and never commits leaves no armed deadline behind.
- The health record can represent "this window is being reloaded constantly and coming back every time", and the packaged smoke fails on it.
- The next instance of this class costs at most one reload a minute against a page that is rendering.
- A genuinely black window recovers exactly as fast as it does today.

## Non-Goals

- Why first paint exceeds 10 s on the #1840 reporter's machine.
- The "can't reach its server" panel being gated on `/api/config` rather than reachability (#1840 section 7, filed separately).
- Any change to the ladder's rungs, their order or their contents. Escalating faster in response to a loop is rejected.
- A heartbeat on every committed route change; teaching the packaged smoke to drive a route change or an iframe load; Playwright `_electron.launch` against the full built app.
- Any new required CI check.

## Technical Dependencies

- Electron 41.10.7 (`apps/desktop` devDependency `electron: ^41.10.7`). No version change.
- `electron-log` 5.4.4. Its file transport rotates at `maxSize: 1024 ** 2` and renames the previous file to `main.old.log` beside it.
- `@dorkos/shared/error-report` for `redactPaths` and `redactTokens`. Already imported in the main process by `apps/desktop/src/main/server-output.ts`, so the import path is proven.
- `@dorkos/shared/telemetry-events` for `MAX_LOG_EXCERPT_LEN` (8,000) and the feedback schemas.
- Phase 2 only: `xvfb-run` on `ubuntu-latest`, and `esbuild` (already a desktop dependency) for the harness bundle.

## Detailed Design

### 1. Module layout

`renderer-health/` becomes three files. The split is forced by an existing import cycle, not by taste: `renderer-health/index.ts` imports `window-manager` (for `loadRenderer`) and `diagnostics` (for the recovery page's third button), and `diagnostics` reaches `server-process`, which reaches `server-crash-recovery`. So neither `window-manager.ts` nor `server-crash-recovery.ts` may import the supervisor, and any state all three touch has to live at a leaf. That is the reason `document-watermark.ts` exists today, and the reason its successor does.

| File                                            | Owns                                                                                                                         | Imports                    |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `renderer-health/supervised-load.ts` (new leaf) | the load generation, `waitingSince`, `armedBy`, the session counters, the wrapper, and the two disarm notes                  | `electron-log` only        |
| `renderer-health/health-file.ts` (new leaf)     | `RendererHealth`, `readRendererHealth`, `writeRendererHealth`, `rendererHealthFilePath`, `shouldDisableHardwareAcceleration` | `electron`, `electron-log` |
| `renderer-health/index.ts`                      | the deadline, the ladder, the IPC surface, the floor policy, the recovery page                                               | both leaves, as today      |
| `renderer-health/document-watermark.ts`         | **deleted**                                                                                                                  |                            |

Two consequences worth stating because they are load-bearing:

- `diagnostics/index.ts` may now import `health-file.ts` to collect `renderer-health.json` without closing the cycle it would close by importing the supervisor.
- `shouldDisableHardwareAcceleration()` moves to `health-file.ts`, so the top of `main/index.ts` (which must call it before `app.whenReady()`) stops pulling the whole supervisor, and with it `diagnostics`, into the pre-ready path.

> **Amended 2026-09-15, A2(a).** Both new leaves must stay under `renderer-health/`, as written here. `apps/desktop/src/main` already holds 25 loose `.ts` files and the DOR-2045 review treated that as its ceiling, which is why the shell log excerpt became a folder module.

### 2. The supervised-load wrapper

```
/** Why the shell is replacing the supervised document. A closed set; it is what `by=` prints. */
type ShellLoadReason =
  | 'shell:initial'        // createWindow's own first load, through loadRenderer
  | 'shell:retry'          // the recovery page's Try Again, through loadRealRenderer
  | 'shell:reload'         // recovery rungs 1 and 2
  | 'shell:fallback'       // the bundled recovery page, through loadFile
  | 'shell:server-restart' // pointWindowsAtServer, after the server child came back
  | 'shell:menu-reload';   // Cmd+R and Cmd+Shift+R

/** How a load was armed. The seventh member is every navigation the shell did not issue. */
type ArmSource = ShellLoadReason | 'navigation';
```

`replaceSupervisedDocument(win, reason, perform)` is the only way the shell replaces the supervised document. In order, it:

1. asks the registered `isSupervised(win)` hook; when the window is not the supervised one it simply calls `perform()` and returns, stamping and counting nothing;
2. increments the load generation;
3. records `{ generation, armedBy: reason, armedAt: Date.now(), waitingSince: armedAt, url, previousDocumentReportedAlive }`;
4. increments `reloadsThisSession` unless `reason === 'shell:initial'`, and sets `lastReloadAt` and `lastReloadReason`;
5. sets `pendingShellLoad = generation` (see the double-arm guard below);
6. calls the registered `arm()` hook, which is the supervisor's `armForNewLoad()`;
7. calls `perform()`.

**Steps 3 and 6 happen before step 7, and that ordering is the whole design.** PR #1853 measured the stamp landing 0.9 to 1.9 ms before the new page's `performance.timeOrigin`, so a page loaded through this wrapper always reports a `timeOrigin` strictly newer than the `waitingSince` it is being judged against. **This path takes no tolerance and must never be given one.**

**The double-arm guard.** A shell-issued load also raises `did-start-navigation`, and the handler must not arm a second time for the same load. The wrapper leaves `pendingShellLoad = generation`; the handler, on a main-frame non-same-document navigation, consumes it when it equals the current generation (recording the event's `url` on the existing record and returning) and otherwise arms as `navigation`. The wrapper overwrites the token on every call, so a token leaked by a throwing `perform()` self-heals on the next shell load, and its only cost in the meantime is one foreign navigation that does not arm, which is the safe direction.

**Call sites to convert:**

| File                                                   | Today                                                                   | After                                                                                                                                        |
| ------------------------------------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `window-manager.ts` `createWindow`                     | `loadRenderer(win, options)` at line 360, unstamped                     | wrapped, `shell:initial`                                                                                                                     |
| `window-manager.ts` `loadRenderer`                     | four branches, each `void win.loadURL(...)` or `void win.loadFile(...)` | unchanged internally; the wrapper is applied by its callers, not inside it                                                                   |
| `renderer-health/index.ts` `loadRealRenderer`          | `noteDocumentReplaced(); loadRenderer(...)`                             | wrapped, `shell:retry`                                                                                                                       |
| `renderer-health/index.ts` `climbLadder` rungs 1 and 2 | `noteDocumentReplaced(); win.webContents.reload()`                      | wrapped, `shell:reload`                                                                                                                      |
| `renderer-health/index.ts` `loadFallbackPage`          | `noteDocumentReplaced(); await win.loadFile(...)`                       | wrapped, `shell:fallback`                                                                                                                    |
| `server-crash-recovery.ts` `pointWindowsAtServer`      | `noteDocumentReplaced()` once, then a loop over every window            | the supervised window goes through the wrapper as `shell:server-restart`; other windows navigate unwrapped                                   |
| `menu.ts` lines 243 to 244                             | `{ role: 'reload' }`, `{ role: 'forceReload' }`                         | `{ label, accelerator: 'CmdOrCtrl+R', click }` and `{ label, accelerator: 'Shift+CmdOrCtrl+R', click }`, each wrapped as `shell:menu-reload` |

The menu handlers take the `browserWindow` argument Electron passes to `click`, return early when it is absent, and call `webContents.reload()` and `webContents.reloadIgnoringCache()` respectively inside `perform()`.

### 3. Identity: `waitingSince` and the tolerance

`documentReplacedAt()` and `noteDocumentReplaced()` are gone. `isFromReplacedDocument(report)` becomes a single comparison against the current load record, with no branch on how the load was armed:

```
a heartbeat belongs to an already-replaced document when
  the current load's waitingSince is non-zero
  and the report carries a finite numeric timeOrigin
  and timeOrigin < waitingSince
```

The tolerance is folded into `waitingSince` at arm time rather than into the comparison, so there is exactly one rule and one place it can be got wrong:

| Armed by                              | `waitingSince`                              |
| ------------------------------------- | ------------------------------------------- |
| any `ShellLoadReason` (the wrapper)   | `armedAt`                                   |
| `navigation` (`did-start-navigation`) | `armedAt - FOREIGN_NAVIGATION_TOLERANCE_MS` |

```
/**
 * How far before an arm the shell did not issue a heartbeat's `timeOrigin` may
 * fall and still be treated as the new document's own.
 *
 * A new document's `performance.timeOrigin` IS its navigation start, and the
 * main process learns about a navigation it did not issue only after the
 * renderer has already set that value, so the arm is always slightly later than
 * the document it is waiting on. The shell's own loads go through the wrapper,
 * which stamps before issuing, and get no tolerance at all.
 *
 * Being wrong in the two directions costs very different things. Too small and
 * the supervisor rejects a healthy new page's own heartbeat and reloads it,
 * which is the defect this programme exists for. Too large and it accepts a
 * heartbeat from a document that started loading less than this long before the
 * one being waited on, which costs one unsupervised load. The separation it has
 * to preserve is roughly ten seconds in every measured instance, because an arm
 * only happens after a full deadline has elapsed.
 */
const FOREIGN_NAVIGATION_TOLERANCE_MS = 250;
```

The permissive fallback stays exactly as it is: a report with no usable `timeOrigin` is accepted, because the safe failure is the behaviour that shipped before the guard existed. The preload test in phase 1 is what keeps that fallback from silently becoming the normal path.

### 4. Disarming a navigation that never commits

Two sources, and the first depends on no platform claim at all.

**4a. The shell's own block.** `applyLinkPolicy`'s `will-navigate` handler in `window-manager.ts` already calls `event.preventDefault()` for a foreign origin. It now also calls `noteNavigationBlocked(event.url)` on the leaf. The leaf disarms when the current load was armed by `navigation` and nothing has armed since. Ordering is documented: Electron raises `did-start-navigation` when the navigation request is created, before throttles run, so the arm is always already in place when the block happens. The URL is logged, not compared: `will-navigate` follows its own `did-start-navigation` immediately, so "nothing has armed since" is the tighter test, and a URL mismatch must not leave a healthy window armed.

**4b. `ERR_ABORTED` on the main frame.** The `did-fail-load` handler keeps ignoring `ERR_ABORTED` as a failure and gains a disarm. It disarms when all of:

- `isMainFrame` is true and `errorCode === ERR_ABORTED` (-3);
- no main-frame navigation has started since the current load was armed (the generation has not moved);
- `previousDocumentReportedAlive` is true, that is, the document still on screen had already reported alive.

The third condition is what keeps a genuine boot that aborted from silently disabling the ladder: a page that never came up keeps its armed deadline and still escalates.

### 5. The reload floor

```
/**
 * How long the shell must wait before replacing a page that already reported
 * alive for a second time.
 *
 * The loop signature is a high RATE of recovery, not a run of failures: in both
 * incidents a heartbeat arrived roughly 110 to 130 ms after every reload, so the
 * ladder reset before it could climb. This bounds any future instance of that
 * class to one reload a minute instead of six, and it is deliberately NOT a
 * blanket floor: a page that never reported alive keeps the ladder's full speed,
 * because slowing the recovery of a genuinely black window six-fold is the wrong
 * trade for bounding a defect that has always announced itself with a heartbeat.
 */
const RELOAD_FLOOR_MS = 60_000;
```

The floor is policy and lives in the supervisor, not the leaf. It is consulted in `recoverFrom` and only when **all** of:

- the failure being answered is a heartbeat-deadline expiry (`onDeadlineExpired`), and
- `previousDocumentReportedAlive` is true, and
- `Date.now() - lastShellReplacementAt < RELOAD_FLOOR_MS`.

**Hard failures are exempt, always.** A reload answering `render-process-gone`, `unresponsive`, or a non-aborted `did-fail-load` is never floored. Those are positive evidence the page is gone whatever it reported a minute ago, and leaving a crashed renderer dead for a minute would be a regression introduced by a safety measure.

**What a refusal does:** logs at `error`, writes `loopDetected: true`, disarms the deadline, and leaves the window alone until something arms again. It does **not** count a failure and does **not** climb a rung. Counting one would push the next real failure onto the cache-clearing or relaunching rungs, which is escalation in response to a loop.

### 6. The arming contract, as a state table

`Arms?` means a 10-second deadline is started. `Stamps?` means a new load record with a new generation and a new `waitingSince`. `Counts?` means `reloadsThisSession` increments.

| #   | Event                                                         | What the supervisor sees                                             | Arms?         | Stamps?                         | `armedBy`              | Disarms?                                                         | Counts?                                       |
| --- | ------------------------------------------------------------- | -------------------------------------------------------------------- | ------------- | ------------------------------- | ---------------------- | ---------------------------------------------------------------- | --------------------------------------------- |
| 1   | shell reload (recovery rungs 1 and 2)                         | the wrapper, then `did-start-navigation` main frame (token consumed) | yes           | yes, `waitingSince=armedAt`     | `shell:reload`         | no                                                               | yes                                           |
| 2   | shell `loadURL` (`createWindow`'s first load)                 | the wrapper, then the same navigation event                          | yes           | yes, exact                      | `shell:initial`        | no                                                               | **no**                                        |
| 3   | shell `loadURL` (the recovery page's Try Again)               | the wrapper, then the same navigation event                          | yes           | yes, exact                      | `shell:retry`          | no                                                               | yes                                           |
| 4   | shell `loadFile` (the bundled recovery page)                  | the wrapper, then the same navigation event                          | yes           | yes, exact                      | `shell:fallback`       | no                                                               | yes                                           |
| 5   | server-restart `loadURL` (`pointWindowsAtServer`)             | the wrapper, then the same navigation event                          | yes           | yes, exact                      | `shell:server-restart` | no                                                               | yes                                           |
| 6   | Cmd+R / Cmd+Shift+R (the two menu items)                      | the wrapper, then the same navigation event                          | yes           | yes, exact                      | `shell:menu-reload`    | no                                                               | yes                                           |
| 7   | client `window.location.reload()` (five sites)                | `did-start-navigation`, main frame, not same document                | yes           | yes, `armedAt - 250ms`          | `navigation`           | no                                                               | no                                            |
| 8   | renderer `location.href` to our own origin                    | `will-navigate` passes, then the same navigation event               | yes           | yes, `armedAt - 250ms`          | `navigation`           | no                                                               | no                                            |
| 9   | a `will-navigate`-blocked link to a foreign origin            | the navigation event arms, then `preventDefault()`                   | yes           | yes, `armedAt - 250ms`          | `navigation`           | **yes**, `blocked`                                               | no                                            |
| 10  | an iframe loading, or an existing iframe's `src` changing     | `did-start-navigation` with `isMainFrame: false`                     | no            | no                              | n/a                    | no                                                               | no                                            |
| 11  | `pushState` / `replaceState` / a hash change                  | `did-start-navigation` with `isSameDocument: true`                   | no            | no                              | n/a                    | no                                                               | no                                            |
| 12  | main-frame `did-fail-load` with `ERR_ABORTED` (204, download) | not a failure, as today                                              | no            | no                              | n/a                    | **yes**, `uncommitted`, under the three conditions in section 4b | no                                            |
| 13  | main-frame `did-fail-load` with any other code                | a failure                                                            | no            | no                              | n/a                    | the ladder takes over; **exempt from the floor**                 | no (the ladder's own reload counts, as row 1) |
| 14  | `render-process-gone` (not `clean-exit`), `unresponsive`      | a failure                                                            | no            | no                              | n/a                    | as row 13, **exempt from the floor**                             | as row 13                                     |
| 15  | the loading ceiling re-arm inside `onDeadlineExpired`         | the same load, still fetching                                        | yes, re-armed | **no**, the record is untouched | unchanged              | no                                                               | no                                            |

Rows 10 and 11 increment the `subframe` and `same-document` ignored counters, which appear only on the summary line. Row 9 increments `blocked`, row 12 increments `uncommitted`.

### 7. Log lines, verbatim

Eight formats, all prefixed `[renderer] ` as every line in this module already is, all keyed on a monotonic per-process load generation printed as `load#N`. Timestamps inside a message are ISO-8601 UTC (`new Date(x).toISOString()`); electron-log's own local-time prefix is unchanged.

```
[renderer] load#7 armed 10000ms  by=shell:reload url=http://localhost:4242/ mainFrame=true sameDocument=false waitingSince=2026-09-14T15:25:24.695Z
[renderer] load#7 alive after 412ms  timeOrigin=2026-09-14T15:25:25.107Z waitingSince=2026-09-14T15:25:24.695Z
[renderer] load#7 heartbeat rejected  timeOrigin=2026-09-14T15:25:14.400Z is 10295ms older than load#7's waitingSince=2026-09-14T15:25:24.695Z (load#6's page)
[renderer] load#7 disarmed  reason=blocked url=https://example.com/ (the shell refused the navigation this deadline was armed for)
[renderer] load#7 disarmed  reason=uncommitted url=https://example.com/ (ERR_ABORTED, no newer main-frame navigation, load#6 had reported alive)
[renderer] load#7 expired after 10000ms  by=shell:reload mainFrameLoading=false waited=10000/60000ms lastChildCrash=none
[renderer] load#7 reload refused  the reload floor: load#6 reported alive and the shell replaced the page 12043ms ago (floor 60000ms); leaving the window alone
[renderer] watchdog: 6 reloads in 62s, 6 of them followed by a heartbeat; rung 1; last armed by=shell:reload; ignored since launch: 41 subframe, 12 same-document, 1 uncommitted, 1 blocked
```

Levels: `armed`, `alive` and `disarmed` at `info`; `heartbeat rejected` and `expired` at `warn`; `reload refused` at `error`, matching the existing doctrine that the rung which stops trying logs at `error`.

**The existing failure line is unchanged.** `[renderer] Failure ${rung}: ${reason}. ${action}` is what both issue bodies quote and what a user recognises in their own log; the new `expired` line sits immediately before it and carries only the facts the failure line lacks, so nothing is said twice.

**Volume.** Under this contract a route change per second produces zero lines, because nothing arms. A real main-frame document costs the `armed` and `alive` pair, a handful an hour on a healthy install. The summary line fires on each failure and at most once a minute otherwise. That budget matters: electron-log rotates at 1 MiB and the diagnostics archive takes only the last 500 KiB, so at #1860's own rate of about 12 lines a minute a two-day-old loop has already rotated its own opening out of view.

With these lines, #1860 reads as `by=navigation mainFrame=false` (which under this contract never arms at all) or, in whatever the next instance is, as one line naming the source. That is the mechanism in two lines instead of a day.

### 8. The health record

`renderer-health.json` gains four fields. The file now carries two classes of field and the difference is the point.

| Field                                  | Class       | Meaning                                                                                             | Reset by                                              |
| -------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `consecutiveFailures: number`          | persisted   | renderer failures since the last time one reported alive                                            | a heartbeat, and Try Again; read back across launches |
| `lastFailureAt: string \| null`        | persisted   | when the last failure was counted                                                                   | never cleared, only overwritten                       |
| `updatedAt: string`                    | persisted   | when the file was last written; the freshness the packaged smoke reads                              | every write                                           |
| `disableHardwareAcceleration: boolean` | persisted   | whether the next launch starts with hardware acceleration off                                       | a heartbeat; read back across launches                |
| `reloadsThisSession: number`           | **session** | shell-issued page replacements since this process started, `shell:initial` excluded, failure or not | **a fresh launch only. Never a heartbeat.**           |
| `lastReloadAt: string \| null`         | **session** | when the last one happened                                                                          | **a fresh launch only**                               |
| `lastReloadReason: string \| null`     | **session** | the `armedBy` of the last one, the same string the log carries                                      | **a fresh launch only**                               |
| `loopDetected: boolean`                | **session** | the reload floor refused a reload (phase 1); the loop detector tripped (phase 2)                    | **a fresh launch only**                               |

**The rule that makes the session fields un-lie-able:** they are projections of in-memory state held in `supervised-load.ts`, and every `writeRendererHealth` call composes them from that state. They are never read back out of the file to make a decision. A heartbeat may clear `consecutiveFailures`, which means "failures since something came up"; it must not touch these, which mean "what has this session done to the window", and against which a heartbeat is not evidence.

`readRendererHealth`'s doctrine is unchanged and extends to the new fields: an unreadable, missing or wrong-typed value reads as `0` / `null` / `false`, never as a reason to stand down.

`loopDetected` is honest on the day it ships: the phase-1 floor sets it when it refuses a reload, which is the loop signature in its minimal form (a page that reported alive, replaced by the shell, about to be replaced again inside a minute). Phase 2's detector tightens the rule and adds the stand-down and the notice. Nothing weaker ever writes it `true`.

### 9. `isLoadingMainFrame()` in the ceiling path

`onDeadlineExpired` reads `win.webContents.isLoading()`. Change it to `win.webContents.isLoadingMainFrame()` and add `isLoadingMainFrame` to `apps/desktop/src/main/__tests__/electron-mock.ts` beside the existing `isLoading`. One word plus one mock method. Without it, a page with a slow, streaming or perpetually open iframe (the canvas browser again) reports `isLoading() === true` indefinitely and a genuine renderer failure on it is deferred for the full 60-second ceiling before the first rung.

> **Amended 2026-09-15, A1. Shipped as DOR-2046 / PR #1867.** The change is right and this sentence's reason for it is not: `isLoadingMainFrame()` does not mean "the main frame's own document is still fetching". Read A1 before quoting this paragraph.

### 10. The shell log excerpt in bug reports

**New module `apps/desktop/src/main/shell-log-excerpt.ts`.**

> **Amended 2026-09-15, A2(a).** Built as `apps/desktop/src/main/shell-log-excerpt/index.ts`, a folder module.

```
/** How many shell-authored lines a bug report carries. */
export const DEFAULT_SHELL_EXCERPT_MAX_LINES = 200;
/** How far back a line may be to qualify: 30 minutes. */
export const DEFAULT_SHELL_EXCERPT_MAX_AGE_MS = 30 * 60 * 1000;
/** Channel the renderer asks for it on. */
export const SHELL_LOG_EXCERPT_CHANNEL = 'shell:log-excerpt';

export function getShellLogExcerpt(maxLines?: number, maxAgeMs?: number): string | undefined;
// Amended 2026-09-15, A2(b): built as registerShellLogExcerptHandler(getRendererUrl).
export function registerShellLogExcerptHandler(isOwnOrigin: (url: string) => boolean): void;
```

Reading and filtering, in order:

1. Take the tail of `log.transports.file.getFile().path`. When the number of matching entries is below `maxLines`, fold in the sibling `main.old.log` ahead of it, oldest first, mirroring `findPriorRotatedFile` in `log-excerpt.ts`. electron-log rotates at 1 MiB, so a report filed just after a rotation would otherwise see almost nothing.
2. Parse each line as `[YYYY-MM-DD HH:MM:SS.mmm] [level]  rest`. A line that does not match is a continuation (a stack frame) and is attached to the entry above it, capped at 20 continuation lines per entry, so a shell-authored stack survives intact.
3. **Drop every entry whose `rest` begins with `[server]`.** This is the one place this module deliberately differs from `log-excerpt.ts`, and it is measured rather than assumed: on a real install, of the last 2,000 lines of `main.log`, 1,240 were `info` and 365 were `error`, and 321 of those errors carried `[server]`, which is the server child's forwarded stdout and stderr. The same report already carries the server's own log as `serverLogExcerpt`, gathered from the structured NDJSON where the levels mean what they say. Re-sending the child's stream here would duplicate it and displace the shell's own lines, of which the whole 342 KB file contained 16.

   > **Amended 2026-09-15, A2(c) and A6.** The prefix to drop is `[server:`, not `[server]`: twelve shell call sites write their own `[server]` prose that a report needs. The line counts in this step were measured on a log polluted by test output; the conclusion does not rest on them.

4. Keep levels `error`, `warn` and `info`. The shell's own line rate is low by construction, and the `[renderer]` lines that name the cause are at `info`: a warn-and-above filter on this file returns almost nothing useful. Raising the watchdog's own lines to `warn` so a warn-and-above filter would catch them was considered and rejected, because a level is a claim about severity and "a new page started loading" is not a warning.

   > **Amended 2026-09-15, A6.** "The shell's own line rate is low by construction" is false. The filter keeps roughly 7,000 of 11,700 lines on the operator's log. Keeping `info` is still right, for the reason in the second half of this step.

5. Keep entries whose timestamp is within `maxAgeMs`. The timestamps are local time with no zone, which `new Date('2026-09-14 15:25:25.123')` parses as local, so no conversion is needed and none may be added.

   > **Amended 2026-09-15, A2(d) and A2(e).** True, and untestable on a UTC runner without the timezone pin A2(e) describes. Split lines on `\r?\n`, not `\n`, or the Windows build returns nothing.

6. Take the last `maxLines`, join, then `redactTokens(redactPaths(...))`.

   > **Amended 2026-09-15, A2(f).** Three passes, not two: `redactTokens(redactPaths(stripUrlQueries(...)))`. What that does and does not scrub is A2(f).

7. Bound to `MAX_LOG_EXCERPT_LEN` (8,000), **cutting from the front with a leading ellipsis**, exactly as `log-excerpt.ts` does and for the same reason (DOR-1976): a report is filed about the moment at the end of the log.

   > **Amended 2026-09-15, A2(h).** This is the bound that binds. `DEFAULT_SHELL_EXCERPT_MAX_LINES` never does: 8,000 characters is about 87 lines of this log.

8. Never throw. A missing file, an unreadable directory or an unparseable line all resolve to `undefined`.

**Who may ask.** `registerShellLogExcerptHandler` answers only a sender on the app's own origin, using the same `isOwnOrigin` accessor `window-manager.ts` gives its link and permission policies. That is a weaker gate than the three recovery actions get, and deliberately so: the feedback dialog lives in the app's own page, not on the recovery page.

> **Amended 2026-09-15, A2(b).** The gate is `window-manager.ts`'s existing `isCockpitSender(event, getRendererUrl)`, not a bare origin predicate; the handler takes `getRendererUrl`. The paragraph's reasoning is unchanged.

**The bridge.** `apps/desktop/src/preload/index.ts` gains:

```
getShellLogExcerpt: (): Promise<string | undefined> => ipcRenderer.invoke(SHELL_LOG_EXCERPT_CHANNEL)
```

**The schema.** `FeedbackDiagnosticsSchema` in `packages/shared/src/telemetry-events.ts` gains `shellLogExcerpt: z.string().max(MAX_LOG_EXCERPT_LEN).optional()`.

**The client.** `apps/client/src/layers/features/feedback/model/use-send-feedback.ts` attaches it when the report is a bug, `includeServerLogs` is on, and `isDesktopShell()` is true. `FeedbackPreviewDialog.tsx` shows it, because the preview promises the exact payload that will be sent.

**The server.** `stripServerAuthoredFields` in `apps/server/src/routes/feedback.ts` strips `transcriptExcerpt` and `diagnostics.serverLogExcerpt` and must **not** strip `shellLogExcerpt`. This is the one deliberate exception to that module's "the server authors the diagnostics" doctrine and it needs its reason written at the call site: the server child does not run in the Electron main process and cannot see `main.log` at all, so the shell is the only process that can gather it. The alternative, injecting the shell's log path into the server child through the environment so `log-excerpt.ts` could gather it server-side, was rejected as a new coupling between the shell and the server for one diagnostic, against a path (`log-location.ts`) that exists precisely because the shell is the authority on where its own log is. The trade is that a page can put up to 8,000 characters of its own choosing into a report a person deliberately sent; the schema bound is the mitigation, and the same person is already authoring the free-text message beside it.

> **Amended 2026-09-15, A2(g).** Incomplete: the durable render in `feedback-reporter.ts` also had to change, or the desktop section is deleted outright whenever the server excerpt is at its bound.

### 11. The diagnostics archive

`apps/desktop/src/main/diagnostics/index.ts` gains `collectRendererHealth(collector)` beside `collectElectronLog`, reading `rendererHealthFilePath()` from the new `health-file.ts` leaf and attaching it as `renderer-health.json`. Independently attempted and independently allowed to fail, like every other source there. Today the archive collects the two logs, the update state and the redacted config, and not the one file that says what the shell has been doing to the window.

### 12. The packaged smoke's quiet window

`apps/desktop/scripts/smoke-packaged.ts`: after `assertRendererPainted` returns, wait 30 s and assert `reloadsThisSession === 0`, `lastReloadAt === null` and `loopDetected === false`. `rendererPaintFailure`'s three existing claims are unchanged; a new exported `rendererQuietFailure(contents: string): string | null` carries the new one so both stay unit-testable from `apps/desktop/scripts/__tests__/smoke-packaged.test.ts`.

The job is about 6 minutes end to end with the launch-and-probe at about 8 s, and `RENDER_BUDGET_MS` is already 45 s, so 30 s adds roughly 8 per cent and nothing to the macOS runner contention the workflow header worries about.

What it still cannot see: the smoke boots to `/`, changes no route and loads no iframe, so it would have caught #1840 and not #1860. Driving one would mean test-only code in the shipped main process. That case belongs to the phase-2 harness: the packaged smoke proves the artifact, the harness proves the semantics.

## Testing Strategy

Every test named below must be **shown red before the fix and green after**, by reverting the source hunk and running it. A test that cannot fail is the failure mode this whole programme is about: before PR #1862 no test ever emitted a subframe or same-document event, so the suite asserted the code's behaviour given the test's claim about Electron, and the claim was the thing that was wrong.

### New file: `apps/desktop/src/main/renderer-health/__tests__/supervised-load.test.ts`

- `'stamps the identity watermark before the load it is arming for'`
- `'gives a shell-issued load no tolerance at all'`
- `'gives a navigation the shell did not issue exactly the measured tolerance'`
- `'counts every shell replacement except the first load of the session'`
- `'consumes its own navigation event instead of arming a second time'`
- `'arms a foreign navigation again after a shell load whose perform threw'`

### Existing: `apps/desktop/src/main/renderer-health/__tests__/index.test.ts`

Under `what starts the clock`:

- `'accepts the heartbeat of a page the shell itself just reloaded'`: **this is the case that goes red under a commit-time stamp**, and it is the reason decision D1 exists. Drive it with a `timeOrigin` a few hundred milliseconds after the wrapper's stamp.
- `'accepts a heartbeat that predates an arm the shell did not issue by less than the tolerance'`
- `'rejects a heartbeat that predates the arm by more than the tolerance'`
- `'disarms when the shell refuses the navigation the deadline was armed for'`
- `'disarms on an aborted main-frame navigation when the page it replaced was alive'`
- `'does not disarm on an aborted navigation when a newer main-frame navigation has started'`
- `'does not disarm on an aborted navigation when the previous page never reported alive'`

New `describe('the reload floor')`:

- `'refuses a second reload within a minute of a page that had reported alive'`
- `'records the refusal as a detected loop without counting a failure or climbing a rung'`
- `'reloads at the ladder's full speed when the page never reported alive'`
- `'never floors a reload that answers a renderer that went away'`
- `'never floors a reload that answers a window that stopped responding'`
- `'never floors a reload that answers a page that failed to load'`

Under `a slow load is not a failed load`:

- `'waits on the main frame only, not on an iframe that never finishes'`: requires `isLoadingMainFrame` on the mock; red today because `isLoading()` answers true.

Under `the health record`:

- `'counts every shell reload in this session and never lets a heartbeat clear it'`
- `'starts a fresh session with the reload counters at zero, whatever the file says'`
- `'writes a detected loop that only a fresh launch clears'`

New `describe('the log')`:

- `'names what armed the clock, on one line, with the load generation'`
- `'says which document a rejected heartbeat belonged to'`
- `'prints the ignored-event counters on the summary line'`

### Existing files, new cases

- `apps/desktop/src/main/__tests__/menu.test.ts`: `'reloads the focused window through the supervised-load wrapper'`, `'force-reloads through the wrapper too'`, `'does nothing when no window is focused'`.
- `apps/desktop/src/main/__tests__/window-manager.test.ts`: `'arms the supervisor for the window's first load'`, `'tells the supervisor when it refuses a navigation to a foreign origin'`.
- `apps/desktop/src/main/__tests__/server-crash-recovery.test.ts`: `'points the supervised window at the new port through the wrapper'`, `'leaves secondary windows unstamped'`.
- `apps/desktop/src/main/diagnostics/__tests__/index.test.ts`: `'collects the renderer health record'`, `'still writes an archive when the health record is missing'`.
- `apps/desktop/scripts/__tests__/smoke-packaged.test.ts`: `'fails a record that shows the shell reloading a window that keeps coming back'`, `'passes a record from a quiet session'`.
- `apps/server/src/routes/__tests__/feedback.test.ts`: `'keeps a desktop shell log excerpt the client attached'`, `'still strips a client-supplied server log excerpt'`.
- `apps/client/src/layers/features/feedback/__tests__/FeedbackDialog.test.tsx`: `'attaches the desktop shell log to a bug report when the shell is present'`, `'attaches nothing extra in a browser'`.

### New file: `apps/desktop/src/main/__tests__/shell-log-excerpt.test.ts`

> **Amended 2026-09-15, A2(a).** Written as `apps/desktop/src/main/shell-log-excerpt/__tests__/index.test.ts`.

- `'drops the server child's forwarded output'`
- `'keeps the shell's own info-level lines'`
- `'keeps a stack trace with the entry it belongs to'`
- `'folds in the rotated file when the live tail is thin'`
- `'scrubs home directories and secret-shaped tokens'`
- `'cuts from the front when it exceeds the length bound'`
- `'returns undefined rather than throwing when the log file is unreadable'`

### New file: `apps/desktop/src/preload/__tests__/index.test.ts`

There is no test at all over `apps/desktop/src/preload/` today, and `isFromReplacedDocument` accepts a report with no `timeOrigin` "defensively" with a test pinning that permissiveness. A preload regression that stopped sending the payload would silently restore DOR-2034 with nothing red. The desktop vitest project's `include` already covers `src/**/__tests__/**/*.test.ts`, so the directory needs no config change.

- `'sends a finite timeOrigin on the alive channel'`
- `'sends nothing but the timeOrigin on the alive channel'`

### New file: `apps/desktop/src/main/renderer-health/__tests__/deadlines.test.ts`

- `'holds the boot sentinel's deadline equal to the supervisor's'`: reads `BOOT_DEADLINE_MS` out of `apps/client/index.html` by regex, from a path resolved off `import.meta.url`, and compares it to `HEARTBEAT_DEADLINE_MS`. The two constants are held equal today by a comment in each file and nothing else; ADR `260829-085851` lists this under Consequences/Negative and it still holds.

> **Amended 2026-09-15, A5. Shipped as DOR-2046 / PR #1867.** There is a third copy of the constant, in `apps/client/src/__tests__/boot-sentinel.test.ts`, which this test does not reach. PR 3 closes it.

### Mocking strategy

Unchanged: `apps/desktop/src/main/__tests__/electron-mock.ts` gains `isLoadingMainFrame` on its `webContents` double and nothing else. Phase 2 is what stops the mock being only as right as its author's belief about the platform.

> **Amended 2026-09-15, A7.** Two further gaps the phase 1 reviews named and nothing in this spec closes: no test derives the log line format from electron-log itself, and nothing in CI executes any of this on Windows.

### Phase 2: the real-Electron contract harness

`apps/desktop/scripts/electron-event-contract.ts` esbuild-bundles `renderer-health` with stubbed `window-manager`, `diagnostics` and `quit-guard` and drives it under a real Electron. It runs in seconds and needs no server and no client bundle. The reviewer on PR #1862 built exactly this by hand and used it to prove the pre-fix source reloads 3 times in 36 s and the branch 0 times.

**Assertion 1, the platform contract as a checked-in table.** For each of `reload()`, `loadURL()`, `loadURL()` to the same URL, `loadFile()`, an iframe insert, an iframe `src` change, `pushState`, `replaceState`, a hash change, a `will-navigate`-blocked cross-origin link, an own-origin `location.href`, a navigation to a 204 response, and a navigation converted to a download, record which of `did-start-loading`, `did-start-navigation(isMainFrame, isSameDocument)`, `did-navigate` and `did-fail-load(errorCode)` fired, and compare against `apps/desktop/src/main/__tests__/navigation-event-contract.json`. **The unit tests then drive the mock from that same file**, so the fixture stops being the test author's belief and becomes a measurement, and an Electron upgrade that moves the semantics goes red in CI rather than in a user's window. The last two rows are what settles open question Q1.

**Assertion 2, the supervisor's behaviour on real events.**

- a page that never reports alive climbs rungs 1, 2 and 3 at 10-second intervals;
- a healthy page doing one `pushState` and one iframe load is reloaded zero times in 40 s;
- a `will-navigate`-blocked cross-origin link is reloaded zero times in 20 s;
- a navigation to a 204 response is reloaded zero times in 20 s;
- **the tolerance has headroom:** across every arming row, the largest observed gap between the incoming document's `timeOrigin` and the arm is under half of `FOREIGN_NAVIGATION_TOLERANCE_MS`, and zero or negative for every row the wrapper arms.

**Where.** A second job in `.github/workflows/desktop-smoke.yml`, `runs-on: ubuntu-latest` under `xvfb-run`, on the same PR path filter (`apps/desktop/**`). Ubuntu is the whole cost argument: that workflow's header is explicit that macOS runners are the scarcest resource in the repo and that `desktop-release.yml` competes for them, and navigation semantics are Chromium's, not the platform's. Expect 60 to 90 s with a warm Electron cache against the existing job's roughly 6 minutes. It runs no vitest, so the native-ABI hazard that keeps the packaged job test-free does not apply, and the existing job comment saying "never add a test step to this job" stays true because this is a different job.

## Performance Considerations

- Two log lines per real main-frame document, and nothing per route change or iframe load. On a healthy install that is a handful of lines an hour against a 1 MiB rotation, which is what keeps a two-day-old incident's opening inside the window a reader needs.
- No new always-on renderer traffic in phase 1. The keepalive is phase 2 and is gated on `requestAnimationFrame` plus `win.isVisible() && !win.isMinimized()`, because Chromium clamps background timers to roughly once a minute and a naive interval would get a minimized window reloaded for being minimized.
- The packaged smoke gains 30 s on a roughly 6-minute job.
- The phase-2 harness adds 60 to 90 s on a Linux runner, not a macOS one.

## Security Considerations

- `getShellLogExcerpt` answers only a sender on the app's own origin and returns content already run through `redactPaths` and `redactTokens`, so no home directory, absolute path or secret-shaped token leaves the main process. Marketplace extension code runs as ordinary modules in that page and can therefore call it; that is already true of every bridge method, and a scrubbed, 8,000-character log tail is a lower-value target than the diagnostics archive the recovery page can already write to the Desktop.

  > **Amended 2026-09-15, A3.** "No home directory, absolute path or secret-shaped token leaves the main process" overclaims. A3 carries the replacement sentence; use it, not this one.

- `shellLogExcerpt` is the one client-authored field in a diagnostics payload whose siblings are server-authored. Bounded by the schema at `MAX_LOG_EXCERPT_LEN`, and only ever attached to a report a person deliberately sent.
- The three recovery-page actions keep their strict `isFallbackPageSender` gate. Nothing in this work widens it.
- The phase-2 fault-injection flag `DORKOS_DESKTOP_FORCE_SPURIOUS_ARM` is read at module scope in the main process only, like `DORKOS_DESKTOP_SUPPRESS_HEARTBEAT` before it, so the shipped preload carries no test-only branch.

## Documentation

- `contributing/desktop-app-development.md`: the arming contract table from section 6, and the sentence that main-process code is unit-tested against a mock gains the phase-2 qualifier that the mock is driven from a measured fixture.
- ADR `260829-085851`: a second dated amendment recording that the identity stamp and the arming instant are now one thing, that the shell has one wrapper, and that the two-deadline coupling is now held by a test rather than by a comment.
- A changelog fragment per pull request, under `changelog/unreleased/`. The user-facing one is the bug-report change: reports sent from the desktop app now carry the app's own log.
- No `docs/` change. Nothing here is a user-facing feature.

## Implementation Phases

### Phase 1 (the next full release)

Three pull requests, deliberately ordered so that the largest one is the last and is therefore cleanly revertible.

**PR 1 (M): the shell log excerpt.** Section 10. New `shell-log-excerpt.ts`, the preload method, the schema field, the client attachment, the preview row, the `stripServerAuthoredFields` carve-out with its reason at the call site. Report item 1.

**PR 2 (S): the cheap, independent gates.** Section 9 (`isLoadingMainFrame` plus the mock method), the preload payload test, and the two-deadline test. Report items 5 and 10. These touch nothing PR 3 rewrites, so they can land in either order.

**PR 3 (M): the arming contract, the health record and the floor.** Sections 1 to 8, 11 and 12. The two leaf modules, the wrapper, `waitingSince` and the tolerance, the two disarm sources, the floor, the eight log lines, the four session fields, the diagnostics collector and the packaged smoke's quiet window. Report items 2, 3, 4 and 6, as amended by decisions D1 through D6 and D9. Items 3 and 4 are one PR on purpose: the smoke's new assertion is the proof that the arming change did what it claims.

**Acceptance criteria for phase 1**

1. A bug report filed from the desktop app carries a `shellLogExcerpt` containing the shell's own lines and none of the server child's forwarded output. Verified by filing one against a local ingest and reading the payload.
2. Every one of the tests named in Testing Strategy is demonstrated red with its source hunk reverted, and green with it in place. The PR body lists each with its mutation.
3. Every row of the section 6 state table is covered by a test, and the tests that assert "does not arm" outnumber neither the rows nor the truth: a test that would pass with the handler deleted does not count.
4. `FOREIGN_NAVIGATION_TOLERANCE_MS` is justified in the PR body by a real-Electron measurement, in the form PR #1862's reviewer used: the observed gap between `timeOrigin` and the arm for `reload`, `loadURL`, `loadFile`, a menu reload, a client `location.reload()` and an own-origin `location.href`. The largest observed gap is under half the constant.
5. `grep -rn "noteDocumentReplaced\|documentReplacedAt" apps/desktop/src` returns nothing, and `document-watermark.ts` is deleted rather than left unused.
6. Every site that replaces the supervised document goes through `replaceSupervisedDocument`. Demonstrated by a test that fails when any one of the seven call sites is reverted to a direct `reload`/`loadURL`/`loadFile`.
7. The packaged smoke fails on a synthetic health record showing `reloadsThisSession > 0` after the quiet window, proven by the unit test over `rendererQuietFailure`.
8. `pnpm --filter @dorkos/desktop typecheck`, `pnpm --filter @dorkos/desktop lint` and `pnpm vitest run apps/desktop/src/main` are clean; `desktop-smoke.yml` is green on each PR that touches `apps/desktop/**`.

   > **Amended 2026-09-15, A4.** The test command must be `pnpm vitest run apps/desktop/src`. `.../src/main` never reaches `src/preload`.

9. Open question Q1 is answered in PR 3's body, by measurement, whatever the answer is.

**Rollback**

Each PR is a single revert. PR 3 is the only one that deletes a file; reverting it restores `document-watermark.ts` and the five hand-stamped call sites exactly as they are today, and touches nothing PR 1 or PR 2 added. PR 2 landing before PR 3 is what keeps that true, which is why the order is what it is. PR 1 touches no desktop supervisor code at all and can be reverted independently at any time; the only cross-package artifact it leaves is an optional schema field, which an older client simply never sets.

### Phase 2 (later)

**P2-1 (M): the real-Electron contract harness.** The Testing Strategy section above. Later only because phase 1 stops the next user-visible loop; this stops the one after an Electron upgrade. Report item 7.

**P2-2 (M): the loop detector, the in-app notice, and the fault-injection flag.** A rolling window of `{ at, reason, armedBy, answeredByHeartbeat }` for every shell replacement, mirrored into the health record. Trips when three or more replacements occur within five minutes and each was followed by a heartbeat within two seconds: the page is manifestly healthy and the supervisor is what destroys it, which separates cleanly from a crash loop, where the heartbeat is what is missing. On trip: latch `supervisorStoodDown`, stop arming and reloading for the session, log at `error` with the last arm lines inline (rotation may already have eaten the history a reader needs), write `loopDetected: true`, and show one line in the app. **The trip is not a reason to escalate.**

The notice goes over a sixth main-to-renderer channel in the existing shape (`onShellNotice` plus a `getPendingShellNotice()` drain on mount, as `onNavigate`/`getPendingNavigate` and `onUpdateStatus` already do, per ADR `260709-210223`). Not a dialog; `background-notice.ts`'s `showMessageBox` is the wrong weight for "we stopped doing something automatic". One line: "DorkOS stopped reloading this window automatically because it kept restarting. Your work is unaffected." Never "watchdog", never a rung number.

`DORKOS_DESKTOP_FORCE_SPURIOUS_ARM=1` arms the deadline on a timer regardless of navigation, read at module scope in main, so the packaged smoke can assert the record reaches `loopDetected: true` with `reloadsThisSession` capped rather than growing. Report item 8.

**P2-3 (M): the visibility-gated, content-attested keepalive.** Strictly after P1's identity change: more heartbeats in flight means more chances for one to arrive from a document just discarded. Send only when `#root` still has children, the same `mountedAlready()` test the boot sentinel uses, because a timer firing from an empty `#root` masks the failure. Drive it off `requestAnimationFrame`, which stops entirely when the page is hidden, and enforce the liveness deadline only while `win.isVisible() && !win.isMinimized()`. Two deadlines: the 10-second boot deadline armed by a document load, then a 60-second liveness deadline (four missed 15-second keepalives) after the first heartbeat. This closes the one failure the supervisor is blind to now, a window that boots, reports, then goes blank. Report item 9.

**Acceptance criteria for phase 2**

1. `navigation-event-contract.json` is produced by the harness, not written by hand, and the unit tests read the mock's event vocabulary from it. Demonstrated by editing one row and watching a unit test go red.
2. The harness job reports on `pull_request` for `apps/desktop/**` and completes under three minutes. It is not proposed as a required check; that is a branch-protection change and the operator's to make.
3. The loop detector trips under `DORKOS_DESKTOP_FORCE_SPURIOUS_ARM=1` in the packaged smoke, and does not trip on a healthy launch.
4. The keepalive is proven not to fire from an empty `#root` and not to be enforced against a minimized window, by a test for each.

**Rollback**

Each of the three is independently revertible and none is a dependency of the others, except that P2-3 must not land before phase 1's PR 3. P2-1 adds a workflow job and a fixture; reverting it returns the unit tests to their own fixtures. P2-2 adds one channel, one field's second writer and one env flag. P2-3 adds renderer code and a second deadline; reverting it returns the supervisor to a single boot deadline.

## Open Questions

- **Q1.** Does Electron 41 raise a main-frame `did-fail-load` with `ERR_ABORTED` for (a) a `will-navigate` cancelled by `preventDefault()`, (b) a navigation to a 204 response, and (c) a navigation converted to a download? Section 4b depends on it and section 4a does not, so a "no" narrows the fix rather than breaking it. Answered by measurement in PR 3 and pinned by the phase-2 harness's last two contract rows.
- **Q2.** What is the real distribution of the gap between a new document's `timeOrigin` and the main process seeing `did-start-navigation`, on a loaded machine? `FOREIGN_NAVIGATION_TOLERANCE_MS = 250` comes from an argument about asymmetry, not from data. If the measured maximum exceeds 125 ms the constant moves up and the reasoning is unchanged.
- **Q3.** Is `reloadsThisSession` the right thing for the packaged smoke's quiet window to assert on, given the smoke boots to `/` and never navigates? It would have caught #1840 and not #1860. Asserted anyway because it is nearly free; if the 30-second extension ever becomes contentious on runner time, this is the assertion to re-argue.
- **Q4.** Should `pointWindowsAtServer` reload secondary windows through the wrapper too? It navigates every window and only the primary is supervised. The design leaves secondary windows unstamped, which is correct today and worth revisiting if a secondary window is ever supervised.

## Related ADRs

- `260829-085851`, renderer supervision: the heartbeat, the ladder, and the two 10-second deadlines. Already carries one dated amendment from PR #1862; this work adds a second.
- `260709-210223`: the main-to-renderer channel shape (`onX` plus `getPendingX`), which the phase-2 notice follows.

## References

- `research/20260914_desktop-watchdog-hardening.md`: the design input, and the source of every measurement quoted here that is not re-measured in section 3 of the ideation.
- GitHub #1840 (DOR-2034), PR #1853: the identity half.
- GitHub #1860 (DOR-2041), PR #1862: the arming half, and the "Gaps" section that names both follow-ups this spec picks up.
- `specs/desktop-renderer-supervision/02-specification.md`: the original supervisor design.
- `plans/desktop-resilience-program.md` sections 1 and 4: the programme this belongs to.
- Electron `docs/api/web-contents.md`, `docs/api/web-frame-main.md`; Chromium `docs/navigation_concepts.md`, `content/public/browser/web_contents_observer.h`, `content/browser/renderer_host/frame_tree.cc`: the platform contracts quoted in the ideation and in Background.

## Amendments (2026-09-15)

Phase 1's first two pull requests went through adversarial review, and the reviewers measured several things this specification asserted. Where a claim was wrong, the amendment below carries the corrected one and the sentence it replaces keeps a one-line pointer in place, rather than being quietly rewritten: a reader who quoted the original deserves to find out that they did.

**Status of phase 1 at the time of writing:** PR 2 (DOR-2046) merged as #1867. PR 1 (DOR-2045) is in review on `fix/dor-2045-shell-log-excerpt`. PR 3 (DOR-2047) has not been written, and A8 is the list of things it must carry forward.

### A1. What `isLoadingMainFrame()` actually measures (section 9; DOR-2046, PR #1867, merged)

Section 9 justified the change with "a page with a slow, streaming or perpetually open iframe reports `isLoading() === true` indefinitely". The change is correct and that reason is not what the predicate does. Measured by the reviewer on Electron 41.10.7:

- `isLoadingMainFrame()` is **not** "the main frame's own document is still fetching". It stays `true` for the whole load a main-frame navigation started, including the stretch where only an iframe **declared in the initial HTML** is still fetching. An iframe in the first response therefore holds it `true` exactly as it always did.
- It reads `false` only for a **sub-frame navigation that begins after that load finished**. That is the canvas browser's shape, and it is the shape both incidents were about, which is why the fix is right for this product's sequence.
- The slow-load grace survives intact where it has to: a main-frame navigation hanging before headers, a committed main frame still streaming its body, a redirect chain and late headers all read `true` under both predicates.
- Both predicates read `false` for post-load dynamic `import()`, `<script src>`, `fetch()` and `<img>`. Neither has ever waited on those and neither does now.
- A normal settled page and the `file://` recovery page read `false` under both.

The rule for anyone writing about this again: say what the predicate measures, which is "a load that a main-frame navigation started is still in flight", not "the main frame's document is still arriving".

### A2. The shell log excerpt as built (section 10; DOR-2045, in review)

**(a) It is a folder module.** `apps/desktop/src/main/shell-log-excerpt/index.ts`, with `__tests__/index.test.ts` beside it, not the flat `shell-log-excerpt.ts` section 10 names. `apps/desktop/src/main` already holds 25 loose `.ts` files and the review treated that as the ceiling. **This binds PR 3:** `supervised-load.ts` and `health-file.ts` go under `renderer-health/`, which is where section 1's table already puts them. Do not flatten them into `main/`.

**(b) The handler is gated through the existing sender check.** `registerShellLogExcerptHandler(getRendererUrl)`, gated by `window-manager.ts`'s `isCockpitSender(event, getRendererUrl)`, not by a bare `isOwnOrigin(url)` predicate the module composes for itself. Same security property, one fewer way for two origin tests to drift apart.

**(c) `[server]` is not exclusive to the forwarded child output, and this was the sharpest correction of the round.** Twelve shell call sites across `server-process.ts`, `server-crash-recovery.ts`, `server-port.ts`, `server-cwd.ts`, `shell-path.ts` and `server-spawn.ts` write their own `[server]` prose, and "the server stopped unexpectedly" is precisely the line a bug report needs. Dropping every `[server]` entry, as step 3 says, would have thrown away the shell's own account of the failure it was written to explain. So the forwarder now tags relayed child output `[server:stdout]` and `[server:stderr]`, and the filter drops the **`[server:` prefix only**. The shell's own `[server]` prose has no colon and is kept.

**(d) Lines split on `\r?\n`, not `\n`.** electron-log writes `os.EOL`, so on Windows every line would keep a trailing `\r`, no line would match the parser, and the excerpt would come back empty on the one platform nothing in CI executes.

**(e) The local-time parse needs a pinned zone to be testable.** Step 5's "the timestamps are local time" is true and its test is vacuous on a UTC runner. `apps/desktop/vitest.config.ts` now pins `TZ=Etc/GMT-3`, set on `process.env` as well as through `test.env` (Node reads `TZ` before `test.env` is applied), unconditionally rather than with `??=` so a runner exporting `TZ=UTC` cannot silently take its own zone back.

**(f) Redaction is three passes, and its scope is narrower than section 10 and Security Considerations imply.** In order: `stripUrlQueries` (http and https query strings and fragments removed), then `redactPaths`, then `redactTokens`. `TOKEN_PATTERNS` in `@dorkos/shared/error-report` gained `(access|refresh|id)[_-]?token` (the existing `\btoken` pattern never matched `access_token=` because `_` is a word character) and a parameter-shaped URL `code=` (parameter-shaped on purpose, so it does not redact "exit code=1"). What is **not** scrubbed, the same as the server excerpt and stated here so nobody has to rediscover it: absolute paths outside the home directory (`/Applications`, `/Volumes`, `/private/var`), email addresses, and tunnel hostnames. `stripUrlQueries` may end up shared with the server excerpt; **PR 3 should check where it lives** before importing it.

**(g) The durable render had to change too, and section 10 does not mention it.** `feedback-reporter.ts` now budgets the header, the breadcrumbs, the server excerpt and the shell excerpt by max-min fair share of `DURABLE_DIAGNOSTICS_MAX_LEN`, with each log section front-cut so its newest end survives. Without it the old head slice deleted the desktop section **entirely** whenever the server excerpt was at its bound, which is the case a desktop bug report is most likely to be in. A diagnostics field that is attached and then silently dropped downstream is worse than one that was never added.

**(h) `DEFAULT_SHELL_EXCERPT_MAX_LINES` never binds.** `MAX_LOG_EXCERPT_LEN` (8,000 characters) binds first, at about 87 lines of the real log against the 200-line nominal. The constant stays as a ceiling; nothing should be reasoned from it.

### A3. Security Considerations, replacement text

Replace the first bullet's claim with this. It is the honest scope, and it is the same scope the server excerpt has always had:

> `getShellLogExcerpt` answers only a sender the `isCockpitSender` check accepts, and returns content already run through `stripUrlQueries`, `redactPaths` and `redactTokens`, so no home directory, no URL query string or fragment, and no secret-shaped token leaves the main process. It is **not** a general anonymiser: absolute paths outside the home directory, email addresses and tunnel hostnames survive, exactly as they do in `serverLogExcerpt`, and any surface offering this excerpt must not describe it as safe to send unread.

### A4. Phase 1 acceptance criterion 8, replacement command

The test command is `pnpm vitest run apps/desktop/src`, the whole desktop suite. `pnpm vitest run apps/desktop/src/main` never reaches `apps/desktop/src/preload/__tests__/`, where the heartbeat payload test this spec asks for actually lives, so the criterion as written would have been satisfied by a run that could not execute one of its own deliverables.

### A5. A third copy of the boot deadline (Testing Strategy; DOR-2046 review)

`deadlines.test.ts` ties `apps/client/index.html`'s `BOOT_DEADLINE_MS` to `HEARTBEAT_DEADLINE_MS`, and shipped. `apps/client/src/__tests__/boot-sentinel.test.ts` declares its **own** `BOOT_DEADLINE_MS = 10_000`, a third copy that the parity test does not reach and that would keep a stale value green. PR 3 either reads it from `index.html` there too, or all three import one shared constant. The parity test also reads the source `index.html` rather than the built artifact, which is a smaller gap and is recorded rather than fixed.

### A6. The D8 line counts were measured on a polluted log (ideation D8, section 10 steps 3 and 4)

The counts quoted in the ideation's D8 and in section 10 step 3 (1,240 `info`, 365 `error`, 321 `[server]`, 16 `[renderer]`) came from a `main.log` that desktop vitest runs had been writing into: the test suite emits real lines and stack frames into the operator's own log (DOR-2042). On the same log, the filter as built keeps roughly 7,000 of about 11,700 lines, dominated by 5,619 `[permissions]` entries that are themselves mostly test pollution. So "the shell's own line rate is low by construction" is wrong.

**The conclusion is unchanged and rests on something else.** Keeping `info` and dropping the child's relayed output is right because of **which lines carry the cause**, not because of how many there are: the `[renderer]` lines that name a reload loop are at `info`, and the child's relayed stream already travels in the same report as `serverLogExcerpt` from the structured log where levels mean what they say. An argument from counts was never the strong form of it, and A2(c) is the proof: the counts would also have justified dropping the shell's own `[server]` prose, which would have been a mistake.

### A7. Two gaps the reviews named and nothing here closes

1. **No test derives the log line format from electron-log itself.** Every fixture in `shell-log-excerpt` shares the parser's own belief about how a line is shaped, so an electron-log upgrade that changes the prefix goes green here and empty in a user's bug report. This is the same class as the mock-vocabulary gap the phase-2 contract harness exists for, in a different file.
2. **Nothing in CI executes any of this on Windows**, which is the platform A2(d) exists for. The Windows desktop build rides the release train as an early alpha and has no smoke.

Neither is in phase 1 or phase 2 scope. They are recorded so the next person does not mistake green for covered.

### A8. What PR 3 (DOR-2047) must carry forward

1. New leaves go under `renderer-health/`, per A2(a). Do not add loose files to `apps/desktop/src/main`.
2. Check where `stripUrlQueries` lives before importing it, per A2(f).
3. Close the third copy of `BOOT_DEADLINE_MS`, per A5.
4. Use `pnpm vitest run apps/desktop/src` as the acceptance command, per A4.
5. Quote A3's sentence, not the original, wherever the excerpt's scrubbing scope is described.
6. Sections 1 through 8, 11 and 12 are otherwise unamended. Nothing the reviews measured touches the arming contract, the identity tolerance, the disarm sources, the reload floor, the log lines or the health record.
