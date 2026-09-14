---
slug: desktop-watchdog-hardening
number: 260914-230211
created: 2026-09-14
status: ideation
---

# Desktop renderer watchdog hardening

**Slug:** desktop-watchdog-hardening
**Author:** Quill
**Date:** 2026-09-14
**Research:** `research/20260914_desktop-watchdog-hardening.md`

---

## 1) Intent & Assumptions

- **Task brief:** The desktop app's renderer watchdog shipped two reload-loop defects to users nine days apart. Each took about a day to diagnose, and neither was catchable by any test in this repo or by the packaged smoke. This is the design for a hardening programme that (a) makes the next instance of the class diagnosable from a bug report instead of from a log file a user finds by hand, (b) replaces the arming contract with one that cannot be widened by accident, and (c) bounds the damage of whatever comes next.
- **Primary input:** `research/20260914_desktop-watchdog-hardening.md`, which reads the shipped supervisor, both incidents, both fixes, and the Electron and Chromium documentation behind them. This ideation carries its numbers and quotations forward and departs from three of its recommendations, each departure recorded in section 6.
- **Assumptions:**
  - A new document's `performance.timeOrigin` equals its navigation start, which precedes the commit by the network round trip. This is the load-bearing assumption behind decision D1 and it is the one that must be measured first, not last.
  - The supervisor stays scoped to the primary window. Secondary windows keep crash logging and no ladder, per ADR `260829-085851`.
  - Nothing in CI runs a real Electron today, so any constant derived from platform behaviour is, in phase 1, pinned by a local measurement recorded in the PR rather than by a gate. Phase 2 moves that pin into CI.
  - `renderer-health.json` stays the artifact the packaged smoke reads. There is no new IPC surface between the smoke and the app.
  - The desktop main-process log is the only place the shell's own evidence exists. It is not structured, it rotates at 1 MiB, and roughly 80% of its lines are the server child's forwarded stdout (measured, section 3).
- **Out of scope:**
  - Why first paint exceeds 10 s on the #1840 reporter's machine. That is a performance question with its own evidence trail; this work is about the supervisor turning a slow mount into an unbounded loop.
  - The "can't reach its server" panel being gated on `/api/config` rather than on reachability (#1840 section 7, filed separately).
  - Any change to the recovery ladder's rungs, their order, or their contents. Escalating faster in response to a loop is explicitly rejected (decision D7).
  - Windows and Linux desktop behaviour beyond what is shared. Navigation semantics are Chromium's, so the contract harness runs on Linux deliberately, but no platform-specific supervisor behaviour is added.

## 2) Pre-reading Log

- `research/20260914_desktop-watchdog-hardening.md`: the whole design input. Sections 0 (platform contracts), 1 (logs), 2 (loop detection), 3 (arming), 4 (heartbeat), 5 (a real-Electron test), 6 (packaged smoke), 7 (health record), 8 (same-family defects), 9 (priority).
- `apps/desktop/src/main/renderer-health/index.ts` (891 lines): the supervisor. Arms on `did-start-navigation` filtered `isMainFrame && !isSameDocument`; identity by `documentReplacedAt()`; ladder on `max(file, session) + 1`; `onDeadlineExpired` re-arms while `webContents.isLoading()` up to a 60 s ceiling.
- `apps/desktop/src/main/renderer-health/document-watermark.ts` (44 lines): the identity stamp, in its own module because `server-crash-recovery.ts` must stamp it too and importing the supervisor from there would close the cycle `renderer-health` to `diagnostics` to `server-process` to `server-crash-recovery`. That constraint survives into the new design.
- `apps/desktop/src/main/window-manager.ts`: `loadRenderer` has four branches and only the one reached through the supervisor's `loadRealRenderer` is stamped; `createWindow`'s own first load is not. `applyLinkPolicy`'s `will-navigate` handler is where a foreign-origin navigation is `preventDefault()`ed, and it is therefore where the shell already knows a navigation will not commit.
- `apps/desktop/src/main/menu.ts` lines 243 to 244: `{ role: 'reload' }` and `{ role: 'forceReload' }`. Neither stamps anything, and neither can, while they stay roles.
- `apps/desktop/src/main/server-crash-recovery.ts` `pointWindowsAtServer`: stamps once before the loop (added by #1853), then `loadURL` in a packaged build or `reload` in dev.
- `apps/desktop/scripts/smoke-packaged.ts` lines 780 to 960: `rendererPaintFailure` asserts the record exists, `updatedAt` is after launch, and `consecutiveFailures === 0`. All three were true throughout both incidents. `RENDER_BUDGET_MS` is 45 s and the launch-and-probe is about 8 s of a roughly 6-minute job.
- `apps/server/src/routes/feedback.ts` and `apps/server/src/lib/log-excerpt.ts`: the bug-report path. `withServerLogExcerpt` attaches a warn-and-above, 200-line, 30-minute tail of the server's NDJSON log. `stripServerAuthoredFields` removes any client-supplied value for the two fields the server alone may author. Nothing in this path can see the desktop main-process log.
- `apps/desktop/src/preload/index.ts` lines 74 to 140: the bridge. `reportAlive` sends `{ timeOrigin: performance.timeOrigin }`. `onNavigate` plus `getPendingNavigate` is the established pattern for a main-to-renderer channel with a drain on mount.
- `apps/client/index.html`: the boot sentinel. `BOOT_DEADLINE_MS = 10000` at line 69, held equal to the supervisor's `HEARTBEAT_DEADLINE_MS` by a comment in each file and nothing else. `mountedAlready()` at line 112 is the content test a keepalive would reuse.
- `apps/desktop/src/main/diagnostics/index.ts`: `collectElectronLog`, `collectServerLog`, `collectUpdateState`, `collectRedactedConfig`. `renderer-health.json` is collected nowhere.
- `.github/workflows/desktop-smoke.yml`: one job, `macos-latest`, no tests by design (the native rebuild flips better-sqlite3 and node-pty to Electron's ABI and kills every plain-Node vitest worker in the monorepo). The header is explicit that macOS runners are the scarcest resource in the repo.
- GitHub #1840, #1860, PR #1853, PR #1862: the two incidents and the two fixes. PR #1862's own "Gaps" section names both follow-ups this spec picks up.
- ADR `260829-085851` and `plans/desktop-resilience-program.md` sections 1 and 4: the design history. The ADR already carries a dated amendment saying "at every load and every navigation" was wider than the design meant.

## 3) Codebase Map

- **The supervisor:** `apps/desktop/src/main/renderer-health/index.ts` plus `document-watermark.ts`. Tests at `apps/desktop/src/main/renderer-health/__tests__/index.test.ts` (about 60 cases) against `apps/desktop/src/main/__tests__/electron-mock.ts`, a hand-rolled event bus whose `webContents` exposes `isLoading` and not `isLoadingMainFrame`.
- **Everything that replaces the page under it:** `window-manager.ts` `loadRenderer` (4 branches), the supervisor's own two reloads plus the fallback `loadFile`, `server-crash-recovery.ts` `pointWindowsAtServer`, `menu.ts`'s two reload roles, and the client's five `window.location.reload()` sites (`ServerRestartOverlay`, `CanvasErrorBoundary`, `route-error-fallback`, `app-crash-fallback` twice).
- **The import cycle that shapes the module layout:** `renderer-health/index.ts` imports `window-manager` for `loadRenderer`, and `diagnostics` for the recovery page's third button; `diagnostics` reaches `server-process`, which reaches `server-crash-recovery`. So neither `window-manager` nor `server-crash-recovery` may import the supervisor. Any state both of them touch has to live at a leaf, which is the entire reason `document-watermark.ts` exists as its own file.
- **The bug-report path:** client `use-send-feedback.ts` builds `diagnostics.clientReport`; `FeedbackSubmissionSchema` and `FeedbackDiagnosticsSchema` in `packages/shared/src/telemetry-events.ts` bound it; `routes/feedback.ts` gathers the server-side excerpts; `services/core/feedback-reporter.ts` forwards it.
- **The main-process log, measured on a real install** (`~/Library/Logs/@dorkos/desktop/main.log`, 342 KB live plus a rotated `main.old.log` at 1,048,654 bytes): of the last 2,000 lines, 1,240 were `info`, 365 `error`, 32 `warn`, 1 `debug`. Of the 365 errors, 321 carried the `[server]` tag, which is the server child's forwarded stderr. Of the 32 warnings, 8 were `[renderer]`. The whole 342 KB file contains 16 `[renderer]` lines. This measurement decides decision D8.
- **Blast radius:** the supervisor is the only consumer of the watermark; the health record is read by the supervisor, the packaged smoke, and (after this work) the diagnostics bundle and the bug report. No server code changes except the feedback route's schema passthrough. No client code changes in phase 1 beyond the feedback submission carrying one more optional field.

## 4) Root Cause Analysis

- **Observed:** #1840, on 0.74.0, a roughly 12-second reload cycle that destroyed unsent composer text and partly entered access rules, with the server answering `/api/health` 45 times out of 45 in 1.0 to 5.4 ms throughout and both the server and renderer PIDs stable. #1860, on 0.75.0, a 10.3 to 10.5 second cycle triggered by any in-app navigation or any iframe load, deterministic with a page open in the room canvas browser.
- **Expected:** a window that is rendering is left alone. A window that is not rendering is recovered, escalating until it is or until the recovery page explains itself.
- **Evidence:** #1840's log shows 92 failures across two launches, every one of them "Failure 1", with a heartbeat accepted 108 to 134 ms after each reload against a successful boot that logs "app routes mounted after 4427ms". #1860's log shows the same shape at a 10.3 to 10.5 second period with the page back about 130 ms after each reload. PR #1862's reviewer bundled the pre-fix module under real Electron 41.10.7 and measured 3 reloads in 36 s on a page doing one `pushState` and one iframe load, and 0 on the fixed branch.
- **Root cause, both incidents:** the supervisor arms a deadline on an event wider than its own contract, and it has no way to tell which document owes it the answer. #1840 is the identity half (a heartbeat from the page a reload had already discarded cleared the failure count, so the ladder was pinned on rung 1 forever). #1860 is the arming half (`did-start-loading` fires for sub-frame loads and same-document navigations, neither of which produces a heartbeat). PR #1853 fixed the identity half by hand-stamping a watermark at five sites; PR #1862 fixed the arming half by narrowing the predicate. Both fixes are correct and both leave the shape intact: the stamp is a coupling every future page-replacing caller has to remember, and the predicate is still evaluated at navigation start, which Chromium documents as a moment that may never lead to a document at all.
- **Decision:** treat the two halves as one defect and replace the shape. One wrapper owns every page replacement the shell issues and stamps identity before issuing it; one narrow event covers navigations the shell did not issue; two disarm sources close the navigations that start and never commit; and a floor bounds the damage when all of that is still wrong.

## 5) Research

The full option analysis is in `research/20260914_desktop-watchdog-hardening.md`. What matters here is the three places where the analysis and the design part company, and one measurement that changes a recommendation:

1. **Arming at commit (report section 3) versus arming at call time plus navigation start (decision D1).** The report proposes `did-navigate` as the second arming source and `waitingSince`, set at the arming instant, as the identity stamp. Those two are individually sound and jointly broken: see D1.
2. **A blanket reload floor (report section 2) versus a floor gated on an already-alive page (decision D4).** See D4.
3. **`shellLogExcerpt` at warn and above (report section 1b) versus excluding the server's forwarded output and keeping info (decision D8).** The measurement in section 3 above says a warn-and-above filter on this file returns mostly the server child's stderr, which already travels in the same report as `serverLogExcerpt`, while the `[renderer]` lines that name the cause are at `info`.

**Recommendation:** ship phase 1 as six items plus the two cheap test gaps, in two pull requests (the log and excerpt work can land independently of the arming work; the arming work and the health record must land together, because the packaged smoke's new assertion is the proof the arming change did what it claims). Phase 2 is three items, each independently revertible.

## 6) Decisions

| #   | Decision                                    | Choice                                                                                                                  | Rationale                                                                                                            |
| --- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| D1  | Where the identity stamp is taken           | At or before navigation start, never at commit                                                                          | A new document's `timeOrigin` is its navigation start, so a commit-time stamp rejects the new page's own heartbeat   |
| D2  | How the shell's own loads arm               | One wrapper, `replaceSupervisedDocument(reason, perform)`, stamps and arms before calling `reload`/`loadURL`/`loadFile` | Measured safe in #1853: the stamp landed 0.9 to 1.9 ms before the new page's `timeOrigin`                            |
| D3  | How navigations the shell did not issue arm | `did-start-navigation`, main frame, not same document, with a measured tolerance on the identity test                   | Keeps #1862's predicate; the tolerance covers the gap between navigation start and the main process seeing the event |
| D4  | Navigations that start and never commit     | Disarm, from two sources: the shell's own `preventDefault()`, and a main-frame `ERR_ABORTED` with no newer navigation   | Closes the reviewer's open case deterministically and the 204/download class defensively                             |
| D5  | The reload floor                            | Applies only to a deadline expiry against a page that already reported alive                                            | A page that never reported alive keeps the ladder's full speed; a black window must not recover six times slower     |
| D6  | Cmd+R and Cmd+Shift+R                       | Replace the two menu roles with explicit handlers that go through the wrapper                                           | The wrapper path is exact, the tolerance path is an approximation, and Cmd+R is the one unstamped path with a repro  |
| D7  | Escalating in response to a loop            | Never                                                                                                                   | Both incidents were a healthy page destroyed by its supervisor; clearing caches and relaunching makes that worse     |
| D8  | What `shellLogExcerpt` contains             | Shell-authored lines at info and above, `[server]`-tagged lines excluded                                                | Measured: 1,561 of the last 2,000 lines are forwarded server output, and the `[renderer]` lines are at info          |
| D9  | `loopDetected` in phase 1                   | Set by the reload floor refusing a reload                                                                               | Makes the field honest on the day it ships instead of structurally false until phase 2                               |
| D10 | Where the tolerance constant is pinned      | A local real-Electron measurement recorded in the phase-1 PR; promoted to a CI gate in phase 2                          | The contract harness is phase 2, and phase 1 must not ship a guessed constant with nothing behind it                 |

### D1. The identity stamp stays at or before navigation start. The report's commit-time `waitingSince` is rejected.

**The report's position (section 3).** Arm from `did-navigate` for navigations the shell did not issue, and replace `documentReplacedAt()` with a `waitingSince` set by `armForNewLoad()` and nothing else. `isFromReplacedDocument` becomes "this report's `timeOrigin` predates the load we are waiting on". The case for it is strong and correctly argued: `did-navigate` is the only Electron event that means "a new main-frame document exists now", it has no frame argument to get wrong, a navigation that never commits arms nothing, and folding the stamp into the arm deletes a coupling that five call sites currently have to remember and three currently forget.

**Why this design overrides it.** The two halves of that proposal cancel each other. `performance.timeOrigin` for a new document is its navigation start, which precedes the commit by the whole network round trip. Arm at commit and set `waitingSince` to that instant, and the very next thing that happens is the new page reporting alive with a `timeOrigin` a few hundred milliseconds (or, on a slow fetch, several seconds) _before_ `waitingSince`. The supervisor rejects its own page's heartbeat, waits out the deadline, and reloads. That is one spurious reload per navigation: the exact defect, reintroduced by the fix for it.

**What ships instead.** Keep the stamp at or before navigation start, in two paths:

1. **The shell's own loads** go through one wrapper that stamps `waitingSince` and arms the deadline _before_ calling `reload`, `loadURL` or `loadFile`. This is what PR #1853 already measured as safe: the stamp landed 0.9 to 1.9 ms before the new page's `timeOrigin`, so the new page's heartbeat is always strictly newer than the stamp. **This path needs no tolerance and must not have one.**
2. **Navigations the shell did not issue** keep #1862's predicate, `did-start-navigation` with `isMainFrame && !isSameDocument`. Here the main process learns about the navigation _after_ the renderer has already set the document's `timeOrigin`, so the arm instant is slightly later than the incoming document's `timeOrigin`. The identity test therefore accepts a heartbeat whose `timeOrigin` falls within a small tolerance before the arm, and rejects anything older.

The report's own strongest argument survives intact: the stamp is no longer hand-written at call sites, `document-watermark.ts` and its two cross-module callers disappear, and Cmd+R, the client's five reloads and anything added later are covered without anyone having to remember. Only the _instant_ changes.

### D2. One wrapper owns every page replacement the shell issues.

`replaceSupervisedDocument(reason, perform)` lives in a leaf module, `renderer-health/supervised-load.ts`, for the same reason `document-watermark.ts` lives in one: `window-manager.ts` and `server-crash-recovery.ts` both have to reach it, and neither may import the supervisor without closing the cycle `renderer-health` to `diagnostics` to `server-process` to `server-crash-recovery`. The leaf holds `waitingSince`, the load generation, `armedBy`, and the session counters; the supervisor registers its arm and disarm callbacks with the leaf when it attaches to a window.

### D3. The tolerance is 250 ms, not 50 ms, and the asymmetry is the argument.

The orchestrator's brief suggests "say 50 ms". This design specifies **250 ms**, because the two ways of being wrong are not symmetric:

- **Too small** and the supervisor rejects a new document's own heartbeat, waits out the deadline, and reloads a healthy page. That is the shipped-twice defect.
- **Too large** and the supervisor accepts a heartbeat from a document that started loading less than 250 ms before the one it is waiting on. The cost is one unsupervised load: if that load is black, nothing reloads it until the next navigation. That is a missed recovery, not a destroyed page.

The separation the tolerance has to preserve is large in every measured instance: an arm only happens after a full 10-second deadline has elapsed, so the discarded document's `timeOrigin` sits roughly 10 seconds before the arm in both #1840 and #1860. A quarter of a second of slack does not come close to that, and it absorbs the two things that would otherwise eat a 50 ms budget: a renderer under sustained load (the #1840 install held 40 to 57% CPU) and wall-clock adjustment between the renderer's `timeOrigin` anchor and the main process's `Date.now()`.

One property makes this safe to be wrong about at all: **a tolerance failure costs exactly one reload, never a loop.** The reload the supervisor issues in response goes through the wrapper, which needs no tolerance, so the replacement document's heartbeat is compared exactly and accepted. Decision D5's floor bounds it further.

### D4. Navigations that start and never commit are closed by disarming, from two sources.

**The report's position (section 3).** Chromium documents that "a renderer process can easily start a navigation which is guaranteed not to commit (e.g. by navigating to a URL returning a response with HTTP status code of 204 or a download)", and the reviewer on PR #1862 found a live instance: `applyLinkPolicy` calls `preventDefault()` on any `will-navigate` to a foreign origin, and because `did-start-navigation` is raised before throttles run, the deadline arms, the throttle cancels, and ten seconds later a healthy window is reloaded. The report's answer is to stop arming at start.

**What ships instead.** Arming stays where D1 puts it, and the deadline is disarmed when the navigation it was armed for demonstrably will not produce a document:

1. **The shell's own block.** `applyLinkPolicy`'s `will-navigate` handler already calls `event.preventDefault()`, so at that moment the shell _knows_ the navigation is dead. It calls `noteNavigationBlocked()` on the leaf module, which disarms if the arm it is holding is the one that navigation raised. Deterministic, ordered correctly (Electron raises `did-start-navigation` before throttles run, which the report establishes), and dependent on no platform claim at all.
2. **`ERR_ABORTED` on the main frame.** The 204 and download cases give the shell no advance warning, so they are caught on the way out: a main-frame `did-fail-load` with `ERR_ABORTED` (-3), which the module deliberately ignores as a failure today, disarms the deadline when no other main-frame navigation has started since the arm and the previous document had already reported alive. Logged as `uncommitted`.

The second source rests on an unverified claim, that Electron 41 raises a main-frame `did-fail-load` with `ERR_ABORTED` for a navigation that never commits. The first does not, and it is the one with a named reachability story. Both ship; open question Q1 records the claim and the harness row that settles it.

### D5. The reload floor applies only after a page has reported alive, and never to a hard failure.

**The report's position (section 2).** A 60-second minimum interval between shell-issued reloads: "a large fraction of the value at a fraction of the cost", bounding any future instance of this class to one reload a minute rather than six, without classifying anything.

**Why this design narrows it.** A blanket floor slows recovery of a genuinely black window six-fold. That window is the failure ADR `260829-085851` exists to prevent, and a person staring at a black rectangle for three minutes instead of thirty seconds is the wrong trade for bounding a defect that has always announced itself with a heartbeat. So the floor is gated on the loop's own signature: **refuse a shell-issued reload within 60 s of the previous one when the document being replaced had already reported alive.** A page that never reported alive keeps the full ladder speed of 10 s per rung.

**And it must not apply to a hard failure.** A page that reported alive and then crashed (`render-process-gone`), hung (`unresponsive`) or failed to load (a non-aborted `did-fail-load`) is positively known to be gone, whatever it said a minute ago. Those reloads are exempt from the floor. Without this carve-out the floor would leave a crashed renderer dead for a minute, which would be a regression introduced by a safety measure. This is a sharpening of the brief's verdict C rather than a departure from it, and it is the one part of C that is load-bearing to get right.

**What a refusal does.** It logs, sets `loopDetected: true`, disarms, and leaves the window alone. It does **not** count a failure and does **not** climb a rung: counting one would push the next real failure onto the cache-clearing or relaunching rungs, which is escalation in response to a loop, which is decision D7.

### D6. The two reload menu roles become explicit handlers.

`{ role: 'reload' }` and `{ role: 'forceReload' }` cannot go through the wrapper while they stay roles, so Cmd+R during a slow boot keeps taking the D3 tolerance path. Replacing each with `{ label, accelerator, click }` calling `replaceSupervisedDocument('shell:menu-reload', ...)` costs three lines each, makes the log line say `by=shell:menu-reload` instead of `by=navigation`, and puts the one unstamped path with a named reproduction (the report's section 8 table) onto the exact path instead of the approximate one. The alternative, leaving the roles and relying on the tolerance, is defensible and is not chosen: the wrapper should be the only way the shell replaces a document, and a menu role is the shell replacing a document.

### D7. Nothing escalates in response to a loop.

Carried unchanged from the report. Both incidents were a healthy page destroyed by its own supervisor. Clearing caches and relaunching against a page that is provably rendering makes it worse. The floor refuses; the phase-2 detector stands down; neither adds a rung.

### D8. `shellLogExcerpt` excludes the server's forwarded output and keeps info-level shell lines.

**The report's position (section 1b).** A `getShellLogExcerpt()` returning "a warn-and-above, 200-line, 30-minute tail of `main.log`, mirroring `log-excerpt.ts`'s contract".

**Why this design changes the filter.** `log-excerpt.ts` reads the server's structured NDJSON, where a level means what it says. `main.log` is a different file with a different population: the server child's stdout and stderr are forwarded into it verbatim, at `info` and `error` respectively. Measured on a real install, of the last 2,000 lines, 1,240 were `info` and 365 were `error`, and 321 of those 365 errors carried the `[server]` tag. The whole 342 KB file contained 16 `[renderer]` lines. A warn-and-above tail of this file is therefore mostly the server child's stderr, which already travels in the same bug report as `serverLogExcerpt`, gathered from the structured log where the levels are honest; and the `[renderer]` lines that name the cause are at `info` and would not appear at all.

So: **drop `[server]`-tagged lines entirely, then keep the last 200 shell-authored lines at info and above within 30 minutes.** The shell's own line rate is low by construction (16 lines in 342 KB), so 200 lines is generous, and the excerpt stops duplicating a log the report already carries.

Raising the watchdog's own lines to `warn` so that a warn-and-above filter would catch them was considered and rejected: a level is a claim about severity, and "a new page started loading" is not a warning. The filter is the right place to encode which lines matter.

### D9. `loopDetected` is honest on the day it ships.

The phase-2 loop detector is what the field was designed for, but the phase-1 floor observes the same signature in its minimal form: a page that reported alive, replaced by the shell, and about to be replaced again inside a minute. So the floor sets it, phase 2's detector tightens the rule (three or more replacements in five minutes, each followed by a heartbeat within two seconds) and adds the stand-down and the notice. The field is never written `true` by anything weaker.

### D10. The tolerance is pinned by a measurement in phase 1 and by CI in phase 2.

Verdict A asks for the tolerance to be "a measured constant with a test in the real-Electron harness", and the harness is phase 2. Phase 1 therefore lands the constant with a throwaway real-Electron measurement recorded in the PR body, in the same form PR #1862's reviewer used: the observed gap between `timeOrigin` and the arm across `reload`, `loadURL`, `loadFile`, a menu reload, a client `location.reload()` and an own-origin `location.href`. The acceptance bar is that the largest observed gap is under half the tolerance. Phase 2's harness turns that measurement into a gate.

### The report's recommendations adopted unchanged

The desktop log excerpt in bug reports, gated on the desktop shell. The five log lines keyed on a load generation with `armedBy`. The honest health record (`reloadsThisSession`, `lastReloadAt`, `lastReloadReason`, `loopDetected`, reset only by a fresh launch) plus the 30-second quiet-window assertion in the packaged smoke. `isLoadingMainFrame()` in the ceiling path. `renderer-health.json` joining the diagnostics bundle. A preload test for the heartbeat payload. A test tying the two 10-second deadlines together. Later: the real-Electron contract harness on Linux under xvfb with a checked-in event table the unit-test mock is driven from; the loop detector and the one-line in-app notice; the visibility-gated, content-attested keepalive, strictly after the identity change.

### The report's "not worth doing", adopted unchanged

A heartbeat on every committed route change; teaching the packaged smoke to drive a route change or an iframe load; Playwright `_electron.launch` against the full built app; escalating faster or adding a rung in response to a loop.

### One ordering change from the report

The report puts the two cheap test gaps (a preload payload test, and a test tying the two 10-second deadlines) at item 10, in "Later". They move into phase 1. Both are S, neither depends on anything else in this spec, and the preload test guards the payload that decisions D1 and D3 now depend on completely: `isFromReplacedDocument` accepts a report with no `timeOrigin` "defensively" and a test currently pins that permissiveness, so a preload regression that stopped sending the payload would silently restore DOR-2034 with nothing red.

## 7) Goals

- A person reporting the next reload loop attaches evidence that names the cause, without being asked to find a log file.
- The shell has exactly one way to replace the supervised document, and it stamps identity and arms the deadline itself.
- A navigation that starts and never commits leaves no armed deadline behind.
- The health record can represent "this window is being reloaded constantly and coming back every time", and the packaged smoke fails on it.
- The blast radius of the next instance of this class is one reload a minute against a page that is rendering, not six.
- A genuinely black window recovers exactly as fast as it does today.

## 8) Non-Goals

- Making the supervisor smarter about slow versus dead. The 10-second deadline and the ladder are unchanged.
- Any new always-on renderer traffic in phase 1. The keepalive is phase 2 and is gated on visibility and on content, not on a timer.
- Test-only code in the shipped main process, beyond the module-scope fault-injection flag that already exists and the one phase-2 flag that joins it.
- A second required CI check. The phase-2 harness is a second job in an existing workflow and is not proposed as required.

## 9) Open Questions

- **Q1.** Does Electron 41 raise a main-frame `did-fail-load` with `ERR_ABORTED` for (a) a `will-navigate` cancelled by `preventDefault()`, (b) a navigation to a 204 response, and (c) a navigation converted to a download? D4's second disarm source depends on it and its first does not, so a "no" narrows the fix rather than breaking it. Settled by a harness row; until then the implementer measures it locally and records the answer in the PR.
- **Q2.** What is the actual distribution of the gap between a new document's `timeOrigin` and the main process's `did-start-navigation`, on a loaded machine? D3 picks 250 ms from an argument about asymmetry, not from data. If the measured maximum is above 125 ms the constant moves up, and the reasoning does not change.
- **Q3.** Is `reloadsThisSession` the right thing for the packaged smoke's quiet window to assert on, given the smoke boots to `/` and never navigates? It would have caught #1840 and not #1860. The spec asserts it anyway because it is free, and records that the gap belongs to the phase-2 harness, but if the smoke's 30-second extension ever becomes contentious on runner time this is the assertion to re-argue.
- **Q4.** Should `pointWindowsAtServer` reload _secondary_ windows through the wrapper too? It navigates every window, and only the primary is supervised. Today the stamp is taken once before the loop. The wrapper makes the primary exact and leaves secondary windows unstamped, which is correct but worth confirming against a future where a secondary window is supervised.

## 10) Recommended Next Step

SPECIFY is complete in `02-specification.md`. Next: DECOMPOSE phase 1 into its two pull requests (the diagnosis pair, then the arming and health-record pair) plus the two test-gap commits.
