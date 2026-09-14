---
title: 'Desktop renderer watchdog hardening — what the platform actually guarantees, and what the supervisor should be built on'
date: 2026-09-14
type: internal-architecture
status: active
tags: [desktop, electron, renderer-health, watchdog, resilience, observability, testing, DOR-2041]
---

# Desktop renderer watchdog hardening

**Date:** 2026-09-14
**Why:** two reload-loop defects shipped to desktop users nine days apart, GitHub #1840 (DOR-2034,
PR #1853) and GitHub #1860 (DOR-2041, PR #1862). Each took roughly a day to diagnose, neither was
catchable by any test in the repo or by the packaged smoke, and both were found only because a user
opened `~/Library/Logs/@dorkos/desktop/main.log` by hand. This report is the input to a more robust
design for the next full release.
**Method:** read the shipped supervisor and every module that replaces the page under it, plus the
spec, the ADR, the plan, the packaged smoke, the boot sentinel, the preload bridge and the two CI
workflows; read both issues and both PRs with `gh`; fetched Electron's `WebContents` and
`webFrameMain` docs, Chromium's `navigation_concepts.md`, `web_contents_observer.h` and
`frame_tree.cc`, and the two Electron issues reporting the subframe behaviour. Nothing was changed.
`research/` holds no prior report on the watchdog; the design history is
`plans/desktop-resilience-program.md` §1/§4 and ADR `260829-085851`.

## TL;DR

- **Both bugs are one bug.** The supervisor arms a deadline on an event that is wider than its own
  contract, and it has no way to tell which document owes it the answer. #1840 was the identity
  half, #1860 the arming half. The shipped patches fix each half separately and leave the shape
  intact.
- **Chromium says arming on navigation _start_ is wrong**, not just wrong for iframes: "a renderer
  process can easily start a navigation which is guaranteed not to commit (e.g. by navigating to a
  URL returning a response with HTTP status code of 204 or a download)"
  (`content/public/browser/web_contents_observer.h`). The reviewer's open `will-navigate` case is
  one instance of a documented class.
- **A live defect nobody has reported yet:** `onDeadlineExpired` re-arms while
  `win.webContents.isLoading()` is true, and Electron documents that method as "Whether web page is
  still loading resources" while `isLoadingMainFrame()` is "Whether the main frame (**and not just
  iframes or frames within it**) is still loading". A page with a slow or streaming iframe suppresses
  a genuine failure for the full 60 s ceiling.
- **The health record lies by construction.** `consecutiveFailures` is the only counter and a
  heartbeat zeroes it, so an infinite reload loop reads as a perfectly healthy install, in the file
  the packaged smoke reads to decide whether the build renders.
- **The desktop main-process log reaches no bug report.** In-app "Send feedback" attaches a _server_
  log excerpt only (`routes/feedback.ts` → `getRecentLogExcerpt`); `main.log` is collected only by
  the manual diagnostics bundle. So the highest-value change here is not the watchdog at all: it is
  that excerpt plus five better log lines, the difference between a day of diagnosis and a paragraph.

## 0. What the platform actually guarantees

Everything below rests on this. Sources: Electron `docs/api/web-contents.md` and
`docs/api/web-frame-main.md` on `main`; Chromium `docs/navigation_concepts.md`,
`content/public/browser/web_contents_observer.h`, `content/browser/renderer_host/frame_tree.cc`.

| Signal                   | Documented contract                                                                                                                                                                                                                                                                                                                      | Consequence here                                                                                                                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `did-start-loading`      | "Corresponds to the points in time when the spinner of the tab started spinning." That is the entire doc text: no frame argument, no same-document note.                                                                                                                                                                                 | Unusable as "a new page is loading". Electron closed #30479, reporting exactly this, as `wontfix`.                                                                                                             |
| (its real trigger)       | `WebContentsObserver::DidStartLoading` fires when "**any document in the frame tree** starts loading for the first time"; `FrameTree::GetLoadingState` returns `LOADING_WITHOUT_UI` when only a subframe is loading. The header also warns there is "no guarantee that calls to DidStartLoading/DidStopLoading are interleaved".         | #1860's measured table is documented Chromium behaviour, not an Electron 41 quirk.                                                                                                                             |
| `did-start-navigation`   | "Emitted when **any frame (including main)** starts navigating." Carries `isSameDocument`, `isMainFrame`, and a nullable `frame`.                                                                                                                                                                                                        | Correct predicate, wrong moment. See the next row.                                                                                                                                                             |
| (Chromium's warnings)    | "There can be more than one navigation ongoing in the same frame at the same time." "Starting a navigation doesn't affect which document is shown ... a renderer process can easily start a navigation which is guaranteed not to commit (e.g. by navigating to a URL returning a response with HTTP status code of 204 or a download)." | A start-armed deadline can be armed twice, out of order, or for a navigation that never commits.                                                                                                               |
| `did-navigate`           | "Emitted when a **main frame** navigation is done. This event is not emitted for in-page navigations."                                                                                                                                                                                                                                   | The only Electron event meaning "a new main-frame document exists now". No frame args to get wrong.                                                                                                            |
| `will-navigate`          | Main frame only. "This event will not emit when the navigation is started programmatically with APIs like `webContents.loadURL` and `webContents.back`." Fires when "the `window.location` object is changed or a user clicks a link". `preventDefault()` "will prevent the navigation".                                                 | A renderer-initiated `location.href` **does** fire it; `loadURL` does not. Both matter in §3.                                                                                                                  |
| `did-fail-load`          | Carries `isMainFrame`. A throttle-cancelled navigation surfaces as `ERR_ABORTED` (-3), which the supervisor ignores by design.                                                                                                                                                                                                           | A blocked navigation leaves an armed deadline nothing will ever clear.                                                                                                                                         |
| `isLoading()`            | "Whether web page is still loading resources", against `isLoadingMainFrame()`: "Whether the main frame (and not just iframes or frames within it) is still loading".                                                                                                                                                                     | The `LOADING_CEILING_MS` re-arm reads the wrong one. See §8.                                                                                                                                                   |
| same-document navigation | Chromium: "A _same-document_ navigation **does not create a new document**, but rather keeps the same document and changes state associated with it." Covers fragments, `pushState`/`replaceState`, `document.open()`, same-document history.                                                                                            | No new document means no new `performance.timeOrigin`, so the #1853 watermark is silent on these. (The `timeOrigin` half is a sound inference from Chromium's wording, not verified against the HR-Time spec.) |

One Chromium warning cuts against the §3 recommendation and is quoted there: "using
DidFinishNavigation to detect changes in the currently active document / page and reset per-document
state is strongly discouraged."

## 1. Logs

**What exists.** Three kinds of line: the failure line (`[renderer] Failure ${rung}: ${reason}.
${action}`), a recovery line on a heartbeat that followed failures, and the #1853 rejection line.
Arming is silent, what armed it is silent, which document answered is silent.

**What #1860's reporter actually had** is six lines alternating "Failure 1: the renderer never
reported a first paint within 10000ms" and "The window came back after 1 failure(s)". Every fact
needed to name the cause (which event armed the clock, for which frame, at which URL, same-document
or not) is absent. They closed the gap by writing a throwaway Electron app and measuring the event
table themselves. That is the cost this section is trying to remove.

**Proposed lines.** A load generation counter (`load#N`, monotonic per process) ties them together.

```
[renderer] load#7 armed 10000ms  by=shell:reload url=http://localhost:4242/ mainFrame=true sameDocument=false
[renderer] load#7 alive after 412ms  timeOrigin=2026-09-14T15:25:25.107Z armedAt=2026-09-14T15:25:24.695Z
[renderer] load#7 heartbeat rejected  timeOrigin=2026-09-14T15:25:14.4Z is 294ms before load#7 was armed (load#6's page)
[renderer] load#7 expired after 10000ms  mainFrameLoading=false waited=10000/60000ms lastChildCrash=none -> failure 1, reloading
[renderer] watchdog: 6 reloads in 62s, 6 of them followed by a heartbeat; rung 1; last armed by=shell:reload; ignored since launch: 41 subframe, 12 same-document, 1 uncommitted
```

Line 1 is the one that matters. `by=` names the arming source from a small closed set
(`shell:initial`, `shell:reload`, `shell:loadURL`, `shell:fallback`, `shell:server-restart`,
`commit:renderer`), and with it #1860 reads as `by=commit:renderer mainFrame=false url=https://dorkos.ai/`
followed ten seconds later by line 4, repeating. That is the mechanism in two lines instead of a day.

**Volume.** Under the §3 contract a route change per second produces **zero** lines, because nothing
arms. The arm/alive pair costs two lines per real main-frame document, a handful an hour on a healthy
install; ignored events are only ever counted into line 5, which fires on each failure and at most
once a minute otherwise. The budget is tight: electron-log 5.4.4 rotates at `maxSize: 1024 ** 2`
(1 MiB, verified in `src/node/transports/file/index.js`) and the diagnostics bundle takes only the
last 500 KiB (`LOG_TAIL_BYTES`). At #1860's own rate of ~12 lines a minute the shipped app already
writes about 1.9 MB a day, so a two-day-old loop has rotated its own opening out of view. Anything
per-navigation makes that worse.

**The bigger finding.** The premise that "the bug-report capture reads the tail of this log" is not
true today. `POST /api/feedback` attaches `serverLogExcerpt` from `getRecentLogExcerpt()`
(`apps/server/src/lib/log-excerpt.ts`: warn-and-above, 200 lines, 30 minutes,
`~/.dork/logs/dorkos.log`). The desktop main-process log is collected in exactly one place,
`collectElectronLog` in the diagnostics bundle, which a person reaches through "Save Diagnostic
Report" on the recovery page. Neither #1840 nor #1860 would have carried one watchdog line into a
bug report.

**Recommendation.** (a) Add the five lines above, keyed on a load generation, with aggregated
counters. (b) Add a `shellLogExcerpt` to the feedback diagnostics: a `getShellLogExcerpt()` on the
preload bridge returning a warn-and-above, 200-line, 30-minute tail of `main.log`, mirroring
`log-excerpt.ts`'s contract, attached only when `isDesktopShell()`. **Size: (a) S, (b) M.**

## 2. Circuit breaker / loop detection

**Why the ladder could not see it.** `onHeartbeat` sets `failuresThisSession = 0` and writes
`consecutiveFailures: 0`. In both incidents a heartbeat arrived roughly 110 to 130 ms after each
reload, so the ladder was reset before it could climb, and the health record said the install was
fine while it reloaded every ten seconds. The ladder measures _consecutive_ failure, which is the
wrong axis for a loop: a loop is a high _rate_ of recovery, not a run of failures.

**Detector.** Keep a rolling window of `{ at, reason, armedBy, answeredByHeartbeat }` for every
page replacement the shell issues, in memory and mirrored to the health record. **Trip when N ≥ 3
replacements occur within M = 5 minutes and each was followed by a heartbeat within 2 s.** That
conjunction is the signature (the page is manifestly healthy and the supervisor is what destroys it)
and it separates cleanly from a genuine crash loop, where the heartbeat is what is missing. Worth
having regardless, and cheaper: **a 60 s minimum interval between shell-issued reloads**, which bounds
any future instance of this class to one reload a minute rather than six without classifying anything.

**On trip:** latch `supervisorStoodDown`, stop arming and reloading for the session, log at `error`
with the last N arm lines inline (rotation may already have eaten the history a reader needs), write
`loopDetected: true`, and show one line in the app. The trip is _not_ a reason to escalate: a cache
clear or a relaunch against a page that is provably rendering makes it worse.

**The in-app notice** goes over a sixth main→renderer channel in the existing shape (`onShellNotice`
plus a `getPendingShellNotice()` drain on mount, as `onNavigate` / `getPendingNavigate` and
`onUpdateStatus` already do, per ADR `260709-210223`). Not a dialog; `background-notice.ts`'s
`showMessageBox` is the wrong weight for "we stopped doing something automatic". One line: "DorkOS
stopped reloading this window automatically because it kept restarting. Your work is unaffected."
Never "watchdog", never a rung number.

**Packaged-smoke assertion.** The negative half belongs in the normal smoke (§6). The positive half
needs fault injection, and `DORKOS_DESKTOP_SUPPRESS_HEARTBEAT` is the precedent: add
`DORKOS_DESKTOP_FORCE_SPURIOUS_ARM=1`, which arms the deadline on a timer regardless of navigation,
and assert the record reaches `loopDetected: true` with `reloadsThisSession` capped rather than
growing. Main-process only, read at module scope, so the shipped preload carries no test branch.

**Recommendation.** Ship the minimum-interval floor and the detector together; the floor alone is a
large fraction of the value at a fraction of the cost. **Size: floor S, detector + notice M.**

## 3. What should arm the clock at all

**The shipped contract** (PR #1862) is `did-start-navigation` filtered on `isMainFrame &&
!isSameDocument`. It is a correct predicate on a signal fired at the wrong moment, and Chromium says
so in its own words: "Starting a navigation doesn't affect which document is shown ... a renderer
process can easily start a navigation which is guaranteed not to commit (e.g. by navigating to a URL
returning a response with HTTP status code of 204 or a download)."

Three cases follow directly:

1. **The reviewer's open case.** `applyLinkPolicy` calls `preventDefault()` on any `will-navigate` to
   a foreign origin. `did-start-navigation` is raised when the navigation request is created, before
   throttles run, so the event fires, the deadline arms, the throttle cancels, and the resulting
   `did-fail-load` carries `ERR_ABORTED` (-3), which the supervisor ignores by design. Ten seconds
   later a healthy window is reloaded. **Reachability today is low, not zero:** every external anchor
   I checked carries `target="_blank"` (`PrivacyTab`, `TunnelSetup`, `TaskBuilder`,
   `TelemetryConsentMoment`) and `markdown-link.tsx` routes through `window.open`, so all take the
   `setWindowOpenHandler` path. The exposure is future first-party markup and marketplace extension
   code, which runs as ordinary modules in the page.
2. **Renderer-initiated `location.href` to our own origin.** `will-navigate` fires and
   `applyLinkPolicy` returns early without preventing it, so it commits and genuinely owes a
   heartbeat. The only client site today is `DevPlayground.tsx`, dev-only. Both contracts handle it.
3. **Concurrency.** "There can be more than one navigation ongoing in the same frame at the same
   time", so a start-armed deadline is armed twice for one eventual document, resetting `waitedMs`.

**The alternative contract.** Arm from two sources, never from navigation start. First, **the shell's
own loads**, through one wrapper: every `loadURL` / `loadFile` / `reload` the shell issues goes
through `replaceSupervisedDocument(reason)`, which arms and records why. Six sites today
(`loadRenderer`'s four branches, `renderer-health`'s two reloads plus its fallback `loadFile`, and
`pointWindowsAtServer`), and call-time arming is the only thing that can supervise a `loadURL`
against a dead server, which never commits. Second, **`did-navigate`**, for main-frame commits the
shell did not issue: no frame argument to get wrong, no subframe ambiguity, and a navigation that
never commits arms nothing. That half catches the View menu's `role: 'reload'` /
`role: 'forceReload'` and the client's five `window.location.reload()` sites, all of which bypass
every stamp in the module today.

**The caveat.** Chromium warns that "using DidFinishNavigation to detect changes in the currently
active document / page and reset per-document state is strongly discouraged"; the upstream advice is
`PrimaryPageChanged`, which Electron does not surface. The mitigation is not to trust event
bookkeeping as identity, which is the change that matters most:

**Fold the watermark into the arming instant.** Replace `documentReplacedAt()` (stamped by hand at
five sites, missed at three more) with `waitingSince`, set by `armForNewLoad()` and nothing else.
`isFromReplacedDocument` becomes "this report's `timeOrigin` predates the load we are waiting on".
Strictly stronger than #1853, it deletes a coupling every future page-replacing caller would
otherwise have to remember, and it covers Cmd+R, the client's own reloads and anything added later
for free. It stays correct under §0's same-document finding: no new document means no `timeOrigin`
moves. `document-watermark.ts` and its two cross-module callers disappear with it.

**Recommendation.** Adopt the wrapper plus `did-navigate` contract, delete the watermark module in
favour of `waitingSince`, and keep `did-start-navigation` only as a source of the `armedBy` /
ignored-counter telemetry in §1. **Size: M.**

## 4. Heartbeat design

Today the page reports once, from both exits of the boot sentinel (`__dorkosBoot.done()` and
`giveUp()`), and `reportAlive` sends `{ timeOrigin }`. "Alive" therefore means "booted once, at some
point".

**Report on every committed route change: no.** Under the §3 contract a route change arms nothing, so
a route-change heartbeat has nothing to clear. It would be inert traffic existing only to satisfy a
deadline the supervisor no longer sets, and it is exactly the mechanism that would tempt someone into
re-arming on route changes later. Decline it explicitly.

**Low-frequency keepalive: yes, later.** It buys the one failure the supervisor is blind to now: a
window that boots, reports, then goes blank. A post-mount React crash that unmounts the tree, or an
error boundary that renders nothing, produces exactly the black rectangle ADR `260829-085851` exists
to prevent, and nothing watches for it after the first ten seconds. Four constraints, because a naive
interval makes things worse:

- **Attest content, not a timer.** Send only when `#root` still has children, the same
  `mountedAlready()` test the sentinel uses. A timer firing from an empty `#root` masks the failure.
- **Chromium throttles hidden pages hard** (background timers clamped to roughly once a minute), so a
  minimized window would miss keepalives and be reloaded for being minimized. Drive it off
  `requestAnimationFrame` (which stops entirely when hidden) and enforce the liveness deadline only
  while `win.isVisible() && !win.isMinimized()`.
- **Two deadlines.** Keep the 10 s boot deadline armed by a document load; after the first heartbeat
  switch to a 60 s liveness deadline (four missed 15 s keepalives). One IPC message and one DOM check
  per interval is nothing.
- **It makes §3's change load-bearing.** More heartbeats in flight means more chances for one to
  arrive from a document just discarded, so the hand-stamped watermark becomes untenable. Do not ship
  the keepalive before the identity change.

**Recommendation.** Not in the next release. Ship it after the §3 contract lands, with the visibility
gate and the content attestation. **Size: M.**

## 5. A real-Electron test in CI

Nothing in CI runs Electron. `desktop-smoke.yml` packages and launches the app but is deliberately a
single job that runs **no tests**, because the native rebuild poisons plain-Node vitest across the
monorepo. Main-process tests run against `apps/desktop/src/main/__tests__/electron-mock.ts`, a
hand-rolled event bus, and the guide says so: "Main-process code is unit-tested against a mocked
`electron` module, never a live Electron ... there is no e2e for the main process."

**Why that could not catch either bug.** The mock emits whatever a test passes. Before PR #1862 no
test ever emitted a subframe or same-document event, so the vocabulary itself was untested: the suite
asserted the code's behaviour given the _test's_ claim about Electron, and the claim was the thing
that was wrong. PR #1862's new cases have the same ceiling: they encode the right table now, and
nothing keeps them right when Electron 42 changes it.

**Two candidates.** Playwright `_electron.launch` on the built main process buys the highest fidelity
(real main process, real client, real server child) at the price of a full desktop build, a server
boot and a whole application's flake surface; `@playwright/test` 1.62.1 is already a dev dependency
in `apps/e2e`. A throwaway harness that esbuild-bundles `renderer-health` with stubbed
`window-manager` / `diagnostics` / `quit-guard` and drives it under real Electron runs in seconds and
needs no server or client bundle. **The reviewer on PR #1862 built exactly the second today**, and
used it to prove the pre-fix source reloads 3 times in 36 s and the branch 0 times.

**Recommendation: the second**, as `apps/desktop/scripts/electron-event-contract.ts`, asserting two
things:

1. **The platform contract, as a checked-in table.** For each of `reload()`, `loadURL()`, `loadURL()`
   to the same URL, `loadFile()`, iframe insert, iframe `src` change, `pushState`, `replaceState`,
   hash change, a `will-navigate`-blocked cross-origin link and an own-origin `location.href`, record
   which of `did-start-loading` / `did-start-navigation(isMainFrame, isSameDocument)` / `did-navigate`
   / `did-fail-load(errorCode)` fired, and compare against
   `apps/desktop/src/main/__tests__/navigation-event-contract.json`. **The unit tests then drive the
   mock from that same file**, which closes the "a test cannot fail" gap: the fixture stops being the
   test author's belief and becomes a measurement, and an Electron upgrade that moves the semantics
   goes red in CI rather than in a user's window.
2. **The supervisor's behaviour on real events.** A page that never reports alive climbs rungs 1, 2, 3
   at 10 s intervals. A healthy page doing one `pushState` and one iframe load is reloaded zero times
   in 40 s. A blocked cross-origin link, zero times in 20 s.

**Where.** A second job in `desktop-smoke.yml`, `runs-on: ubuntu-latest` under `xvfb-run`, on the same
PR path filter (`apps/desktop/**`). Ubuntu is the whole cost argument: that workflow's header is
explicit that macOS runners are the scarcest resource in the repo and that `desktop-release.yml`
competes for them, and navigation semantics are Chromium's, not the platform's. Expect 60 to 90 s
with a warm Electron cache against the existing job's ~6 minutes, and it runs no vitest, so the
native-ABI hazard that keeps the packaged job test-free does not apply. **Size: M.**

## 6. Packaged smoke

`rendererPaintFailure` makes three claims: the record exists, `updatedAt` is after launch, and
`consecutiveFailures === 0`. All three were **true throughout both incidents**. The check is not weak,
it answers a different question ("did anything ever render") from the one a loop poses ("is it still
rendering the same thing").

**Assertion to add.** With §7's fields in place: after `assertRendererPainted` returns, wait 30 s and
assert `reloadsThisSession === 0` and `lastReloadAt` is null. Counting `did-navigate` commits from
outside is not an option (the smoke has no handle on the app's webContents and reads only files under
the throwaway home), so putting the count in the record is both simpler and what §7 wants anyway.

**Time budget.** The job is ~6 minutes end to end with the launch-and-probe at about 8 s, and
`RENDER_BUDGET_MS` is already 45 s. A 30 s quiet window adds roughly 8 % to the job and nothing to
the macOS runner contention the workflow header worries about. It fits.

**What it still cannot see.** The smoke boots to `/`, changes no route and loads no iframe, so it
would have caught #1840 (a boot-time loop) and **not** #1860 (a loop that needs a navigation).
Driving one would mean test-only code in the shipped main process. That case belongs to §5's harness:
the packaged smoke proves the artifact, the Electron harness proves the semantics.

**Recommendation.** Add the quiet-window assertion; do not try to make the smoke drive the UI.
**Size: S.**

## 7. Health record honesty

`RendererHealth` is `{ consecutiveFailures, lastFailureAt, updatedAt, disableHardwareAcceleration }`,
and both of its writers set `consecutiveFailures` (one of them to 0 on every heartbeat). The file
therefore cannot represent "this window is being reloaded constantly and coming back every time",
which is precisely the state both incidents were in.

Add three facts and one verdict:

| Field                              | Meaning                                                                            | Who resets it                          |
| ---------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------- |
| `reloadsThisSession: number`       | every page replacement the shell issued since this process started, failure or not | a fresh launch only, never a heartbeat |
| `lastReloadAt: string \| null`     | when the last one happened                                                         | a fresh launch only                    |
| `lastReloadReason: string \| null` | the same `reason` string the log carries, including `armedBy`                      | a fresh launch only                    |
| `loopDetected: boolean`            | §2's breaker tripped                                                               | a fresh launch only                    |

The load-bearing rule is the right-hand column. A heartbeat may clear `consecutiveFailures`, which
means "failures since something came up". It must not touch these, which mean "what has this session
done to the window", and against which a heartbeat is not evidence.

**Who reads them.** The packaged smoke (§6). The diagnostics bundle, which **does not collect
`renderer-health.json` at all today** (only `collectElectronLog`, `collectServerLog`,
`collectUpdateState`, `collectRedactedConfig`) and should. The recovery page, which can then say
"DorkOS reloaded this window 6 times in the last minute" instead of only offering three buttons. And,
once §1(b) lands, the bug report, beside the shell log excerpt. Keep `readRendererHealth`'s doctrine
intact: an unparseable `reloadsThisSession` is 0, not a reason to stand down.

**Size: S.**

## 8. Others in the same family

**A live defect: `isLoading()` in the ceiling path.** `onDeadlineExpired` re-arms while
`win.webContents.isLoading()` is true, up to `LOADING_CEILING_MS` (60 s). Electron documents that as
"Whether web page is still **loading resources**" and provides `isLoadingMainFrame()`, "Whether the
main frame (and not just iframes or frames within it) is still loading", specifically to distinguish
them. `FrameTree::GetLoadingState` returns `LOADING_WITHOUT_UI` when only a subframe is loading,
which is not `NONE`, so a page with a slow, streaming or perpetually-open iframe (the canvas browser
again) reports `isLoading() === true` indefinitely, and a genuine renderer failure on it is deferred
a full minute before the first rung. Same root cause as #1860, a WebContents-level signal read as a
main-frame signal, in the same file, not yet reported. One word, plus `isLoadingMainFrame` on the
mock. **Size: S.**

**Every place the shell replaces or reloads the page**, complete as of `origin/main` at
`0d5d7eb1e`:

| Site                                                                                                                                  | Stamps the watermark today?                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `window-manager.ts` `loadRenderer` (4 branches)                                                                                       | only through `renderer-health`'s `loadRealRenderer`; `createWindow`'s own first load does not |
| `renderer-health` rungs 1 and 2 `webContents.reload()`, and `loadFallbackPage()`                                                      | yes                                                                                           |
| `server-crash-recovery.ts` `pointWindowsAtServer`                                                                                     | yes (added by #1853)                                                                          |
| `menu.ts` `role: 'reload'` and `role: 'forceReload'` (Cmd+R, Cmd+Shift+R)                                                             | **no**                                                                                        |
| client `window.location.reload()` ×5 (`ServerRestartOverlay`, `CanvasErrorBoundary`, `route-error-fallback`, `app-crash-fallback` ×2) | **no**                                                                                        |

The last two rows are the DOR-2034 hole reopened from another direction: Cmd+R during a slow boot can
have the outgoing document's heartbeat accepted against the incoming load. Narrow, and §3's
`waitingSince` closes every row at once without anyone having to remember.

**Timers keyed on wider-than-assumed events.** `navigation.ts`'s `registerReadinessReset` already uses
`isMainFrame && !isSameDocument` on `did-start-navigation` (the precedent #1862 copied), so it is
correct; it shares §3's uncommitted-navigation weakness but fails safe, since clearing a readiness
mark early only re-queues a navigate message. `revealWhenReady` uses `win.once('ready-to-show', ...)`,
so the 4 s reveal and its `maximize()` cannot recur on a reload. `close-tab.ts`'s 3 s timeout and
`quit-guard`'s confirmation are event-shaped but not navigation-shaped.

**Tests that cannot fail.**

- The mock-vocabulary problem generalised: a main-process test can only be as right as its fixture's
  claim about the platform. §5's contract file is the fix.
- `isFromReplacedDocument` accepts a report with no `timeOrigin` "defensively", and a test pins that
  permissiveness. A preload regression that stopped sending the payload would silently restore
  DOR-2034 with nothing red. There is no test at all over `apps/desktop/src/preload/`; one asserting
  `reportAlive` sends a finite `timeOrigin` on `ALIVE_CHANNEL` closes it. **Size: S.**
- The two 10 s deadlines, in `apps/client/index.html` and `renderer-health/index.ts`, are held equal
  by a comment in each and nothing else. ADR `260829-085851` lists this under Consequences/Negative
  and it still holds. A test reading the sentinel's constant out of `index.html` and comparing it to
  `HEARTBEAT_DEADLINE_MS` is cheap. **Size: S.**

## 9. Prioritised

### In the next full release

1. **`shellLogExcerpt` in the bug report (§1b, M).** The only item that attacks "a day each to
   diagnose" directly. The rest shorten a diagnosis we can already do; this one puts the evidence in
   front of us without asking a user to find a log file.
2. **The five log lines with an `armedBy` reason (§1a, S).** Cheap, and what makes item 1 worth
   having. Neither incident's log contained the fact that named the cause.
3. **One arming contract: the shell's own loads plus `did-navigate`, with `waitingSince` replacing the
   hand-stamped watermark (§3, M).** The structural fix. Closes the reviewer's open `will-navigate`
   case, the uncommitted-navigation class Chromium documents, the two un-watermarked menu roles and
   the five client reloads, and deletes a module and a coupling rather than adding one.
4. **Honest health record plus the quiet-window smoke assertion (§7 S, §6 S).** Together they let the
   packaged gate fail on a loop instead of passing through one.
5. **`isLoadingMainFrame()` in the ceiling path (§8, S).** A live defect of the same family, one word.
6. **The reload floor: at most one shell-issued reload a minute (§2, S).** Bounds the blast radius of
   the next instance of this class, whatever it is, without having to detect it.

Items 3 and 4 are one PR and should land together: the assertion in 4 is the proof that 3 did what it
claims.

### Later

7. **The real-Electron contract harness in CI (§5, M).** The right answer to "nothing pins the
   platform's semantics", and its fixture is what makes the existing mock honest. Later only because
   1 to 6 stop the next user-visible loop; this stops the one after an Electron upgrade.
8. **The loop detector, the in-app notice and the fault-injection flag (§2, M).** Item 6 already takes
   most of the user-visible harm out, so this is the part that makes the state legible rather than
   the part that stops it.
9. **The content-attested, visibility-gated keepalive (§4, M).** Makes "alive" mean alive and closes
   the post-boot blank-window gap. Strictly after item 3: it multiplies heartbeat traffic and depends
   on the identity check being sound.
10. **The two cheap test gaps (§8, S each):** a preload payload test, and one tying the two 10 s
    deadlines together.

### Not worth doing

- **A heartbeat on every committed route change (§4).** Nothing arms on a route change under the
  recommended contract, so it would be inert traffic whose main effect is to tempt someone into
  re-arming on route changes later.
- **Teaching the packaged smoke to drive a route change or an iframe load (§6).** Test-only code in
  the shipped main process, to reach a question §5's harness answers in a second on a cheaper runner.
- **Playwright `_electron.launch` against the full built app (§5).** Fidelity we do not need for a
  question that is entirely about Chromium's navigation events, at the price of a server boot and a
  whole application's flake surface in a job that runs no tests on purpose.
- **Escalating faster, or adding a rung, in response to a loop (§2).** Both incidents were a healthy
  page destroyed by its own supervisor; clearing caches and relaunching against a page that is
  provably rendering makes it worse.
