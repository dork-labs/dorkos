# Managed browser prototype evidence

This report is in progress. It records the bounded experiment, not production readiness. The full parent remains open until production implementation, independent pushed-head review, merges and cleanup are complete.

## Reproduction and runtime

```sh
node scripts/browser-control-prototype/runtime.mjs /absolute/path/to/dorkos
node --test scripts/browser-control-prototype/__tests__/*.test.mjs
```

Foundation and durability integration at `6c8e537b1` passed 52 tests independently. Viewer fixes integrated through `67ecb46ae` then passed 60 tests. A later retained viewer matrix failed one drag-start precondition; acceptance was reopened for the deterministically reproduced stale-control-state race. No native receipt was accepted from that failed run. Subsequent fixes integrated through `2ace73827` passed 62 tests with no skipped tests.

| Runtime field      | Observed value                                                     |
| ------------------ | ------------------------------------------------------------------ |
| Playwright library | 1.63.0                                                             |
| Chromium revision  | 1243                                                               |
| Executable SHA-256 | `8319963f6625accf51c0dd4f55091ceaf9f09ed39e7a52fed4fae12b2a6b668a` |
| Host               | darwin 25.6.0, arm64                                               |
| Launch             | Exact pinned full Chromium executable, headless                    |

Absolute executable paths are local-only. The loader never installs a browser during an action. Tests use private fixture profiles and fictitious identities; none uses personal authenticated sites or paid inference.

## Accepted observations

| Gate                        | Evidence                                                                                                                                       | Limits                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Durable profile             | Three actual Chromium restarts preserve persistent cookie, localStorage, IndexedDB, service worker, Cache Storage and deterministic HTTP cache | Session cookies disappear on each restart; expired and short-lived cookies are refused  |
| Clean mode and return       | New context has no seeded state or controlling service worker; returning leaves the durable profile unchanged                                  | Site expiry still governs authentication                                                |
| Independent unattended work | Two separate profiles complete 100 mutations each, with capture forbidden and zero viewers                                                     | Viewer detach/rejoin is a later gate                                                    |
| Process exclusion           | Two independent actual managers contend for the same profile: one live Chromium holder, one recognized exclusion refusal                       | Corrupt owner and orphan recovery guard require manual repair in this prototype         |
| Manager crash               | Owned manager is killed; either Chromium exits or surviving Chromium causes live-holder refusal, followed by exact owned cleanup and recovery  | Both outcomes have occurred across runs; neither may be invented when observation fails |
| Origin confinement          | Navigation, redirects and service-worker requests stay on the exact fixture origin                                                             | Prototype restriction, not production network policy                                    |
| Control authority           | Participant credentials, exact origin, tab generation, viewport and control epoch fail closed                                                  | Native input and full measured handoff gate are pending                                 |

Durability baseline and negative controls distinguish ephemeral persistence, seeded clean mode, shared contexts and per-process reservations. An infrastructure failure yields zero observed samples and unverified status. An unrelated browser startup error cannot be certified as profile exclusion. CLI filesystem aliases execute rather than silently exit.

## Viewer review and preliminary mechanical observations

Viewer review resolved pointer cancellation and early cleanup; eight tests passed independently before integration. Native evidence consolidation then found that status-only readiness can accept the previous controller, and an old frame response can overwrite a newer control epoch. Both behaviors are deterministically reproduced. State-adoption and readiness corrections passed independent re-review at `6556a0519`. Both exact old-client state regressions failed the intended assertions; later frames are held so they cannot mask the fault.

An exploratory 100-round actual-Page handoff run aborted all 100 old composite tails. Acknowledgment p95 was 0.022 ms; first human input p95 was 66 ms, maximum 109 ms. This does not certify the formal gate: queued-action, composition, missing acknowledgment and fault controls are still required. It is not viewer render latency.

## Unverified surfaces

- Native viewer/IME: a dedicated Chrome fixture viewer was blocked with `ERR_BLOCKED_BY_CLIENT`; its AX state reported the block. The created error tab and exact owned fixture process were cleaned up. No security settings changed or alternate-address bypass attempted.
- Native clipboard: an earlier test wrote fictitious data without establishing platform isolation or preserving previous contents. Mac clipboard impact is uncertain, and prior contents were not captured. Further platform writes are stopped. Fixture doubles prove synthetic permission outcomes only. Any later native proof needs an isolated or preserve-and-restore arrangement first.
- Physical phone: desktop touch events and a phone-sized viewport do not prove physical phone input.
- Actual tunnel: injected round-trip delay will remain distinct from an observed fixture-only tunnel.
- Accessibility: the semantic keyboard experiment is not full accessibility parity with the underlying page.
- Dock/app-switcher/focus: Dock AX timed out and Codex app observation was denied by the native tool policy. App inventory does not establish icon or foreground behavior. A usable observer and visible test-app positive control are still required.
- Installation, crash and resource gate review remains pending; observations are recorded below.

## Artifact handling

Validated local receipts retain the executable path; public JSON redacts it. Profile contents, credentials, action text, raw URLs and console/network payloads are excluded. Screenshots show only the fake fixture. The accepted durability worker retained four public gate receipts in a private temporary artifact directory; profile directories were removed. Formal gate runners will use injected artifact directories and exclusive writes, and this report will identify their commands and results after acceptance.

## Accepted native evidence record

Independent compliance and quality re-review passed. Seven validated receipts are retained in `/var/folders/64/06xfpz_s2kj5xc29cmm6f2fw0000gn/T/browser-native-evidence-Zpaig6`. The semantic keyboard fixture path has one actual observed path and one observed view-only input refusal. Six native gates have zero native samples and remain unverified. The retained `viewer-matrix.tap` contains the corrected 62-test integration run; its broad test count is not counted as native observations.

Initial forced-crash testing lost a just-written persistent cookie. That failed observation is retained separately from committed-store recovery after clean close/reopen. Recent acknowledged writes and committed profile state are distinct recovery promises; neither a committed-store pass nor a later run erases the earlier loss. Installation/resource measurements are retained; independent review of commit `0c9f2e23b` is pending.

Semantic receipt timing describes the full integration command: output collection began at 21:53:21.582 UTC, reported duration 20,602.9995 ms. Individual semantic path timing was not recorded. Receipt export is separately identified in `run-provenance.json`. Unavailable native receipts label zero timing as bookkeeping rather than a successful native observation.

## Resource and recovery observations awaiting review

Task 3.2 source is committed as `0c9f2e23b` in the resource worktree. Explicit installation of pinned full Chromium into an empty private cache passed, and an action with no installed executable refused without downloading. The committed-store recovery probe passed three renderer, browser and manager crash subjects. Two in-flight fixture actions failed without replay. These results use a clean close and reopen to establish the stored baseline; they do not erase the separate recent-write failures.

Resource sampling retained 74 observations over five phases with two managed browsers and two real viewer Pages. The host was heavily loaded. The corrected pressure calculation in `resources-pressure-caps.json` recommends zero additional slots under the observed conditions. A passing observation gate certifies recorded measurements, not adequate capacity or latency. RSS sums can double-count shared pages; OS free memory excludes reclaimable cache.

Local artifact directories are under `/var/folders/64/06xfpz_s2kj5xc29cmm6f2fw0000gn/T/`:

- `browser-cold-install-evidence-emz36grb/artifacts`: explicit install and absent-executable control.
- `browser-recovery-evidence-nzrf5lyj/artifacts`: committed-store recovery and separately retained recent-write failure.
- `browser-resource-measured-0s9ch_aq/artifacts`: resource distributions and corrected pressure calculation.

Seven targeted resource tests passed after the initial full run exposed a context-close ordering race in the probe. Independent task review is pending. Formal mechanical measurements remain active; an initial three-sample injected-RTT smoke exceeded the 600 ms threshold and is retained as a failure.

## Formal render observations awaiting review

The formal render window ran from 22:12:52 to 22:14:31 UTC. All samples measure from the real viewer pointer event through canonical-page revision pixels decoded and drawn in that viewer, using one frontend clock. Parent-side pixel verification selects the observed render; it does not extend the elapsed time.

| Condition                         | Samples |      p95 | Result                               |
| --------------------------------- | ------: | -------: | ------------------------------------ |
| Local viewer                      |     100 | 112.4 ms | Pass against 250 ms target           |
| Injected 150 ms RTT               |     100 | 629.9 ms | Fail against unchanged 600 ms target |
| Fast viewer with stalled observer |     100 | 112.8 ms | Pass over 13.660 s                   |

The RTT distribution ranged from 590.6 to 645.1 ms. The stalled subscriber retained at most one pending frame, 44,458 bytes, and dropped 223 superseded frames. Host one-minute load was approximately 4.16 to 3.99; no globally idle host is claimed. Produced JPEG rate and acknowledged delivered payload rate are reported separately.

Receipts remain in `/var/folders/64/06xfpz_s2kj5xc29cmm6f2fw0000gn/T/mechanics-formal-render2-E8alLB/receipts`. This is injected-delay evidence, not an actual tunnel. The RTT failure remains retained while the protocol critical path is investigated. Independent mechanical gate review is pending. Resource compliance review separately found that the manager-death probe did not inventory Chromium descendants; its combined crash pass is unaccepted until corrected and reviewed.

## Recovery correction and interactive demonstration

The descendant-aware manager probe exposed a reservation defect: original Chromium remained alive after native lock removal while reservation acquisition succeeded. This failed observation is retained as a recovery blocker. Manager corrections through `1f00dca4d` persist launch phase and root PID/birth, refuse uncertain observations and launches, and retain failed-cleanup profiles. Independent parent review and 20 manager/reservation tests passed; the corrected resource gate passed in its worker checkout and awaits final inventory review.

A human-requested temporary fixture demo shows scripted counter updates and typing, explicit human takeover and handoff, and optional same-page views. Its fixture-only automatic bootstrap is not production authentication. Dedicated frontend verification observed actual rendered updates; it establishes no native input, macOS presence, physical-phone, tunnel or performance gate. Formal performance acceptance remains paused during the demo.

## Current acceptance and attended feedback

Exact resource head `1c7b7423e` passed independent compliance and quality review, including eight tests. The corrected isolated descendant-aware recovery receipt is `/var/folders/64/06xfpz_s2kj5xc29cmm6f2fw0000gn/T/browser-corrected-crash-isolated-aDoRDx/artifacts/distinct-shutdown.json`: three subjects, two reported lost in-flight actions, 30 distinct Chromium PID/birth identities, original/recovery trees of seven each, root alive at refusal snapshot and live-root reservation refusal despite absent native lock. `managerSurvivor:true` names that deliberate refusal observation, not a residual process after cleanup. Successful return requires final checks that no matching non-zombie recorded identity remains; the artifact has no separate final process snapshot or all-gone field. Node worker exit is checked separately. The aggregate corrected run remains **unverified, zero observations**, retained at `browser-manager-corrected-evidence-mou6278u/artifacts`; the isolated pass does not erase it. Recent-write crash losses and loaded-host limits remain unchanged.

The human reported that the demo worked, was mildly laggy, and lacked a visible typing caret and mouse pointer. The demo stopped at their request: exact Node PID 19759 exited naturally with code zero; the temporary directory was removed and listener refused. Cleanup receipt is local ignored `.dork/flow/tmp/interactive-fixture-demo-stop.json`. No demo remains running.

Native caret capture correction `dd4df9d2d` (integrated `d5cb50a3e`) independently passed two tests. The actual screenshot shows Chromium's native caret, with 47 contrast pixels versus zero in the hidden variant; the fixture changes caret color solely to identify pixels and invents no caret overlay. Parent rerun retained `manager-caret-evidence-K3jJAO` and visually checked its screenshot. Blink sampling is bounded and resets focus.

Combined post-paint acknowledgement/next-frame correction `ca7d75bc1` (integrated `9d799cfec`) independently passed nine serialized protocol/viewer tests. Only a genuine rendered prior receipt acknowledges delivery; missing/wrong/replayed receipts are refused, lost transport replaces the subscription, and the pending frame remains bounded. These are correctness observations, not improved latency measurements. The original RTT failure remains retained. Task 2.4 adds actual canonical pointer coordinates, scaling and stale control-lifetime regressions before formal resampling.

Task 2.4 accepted after independent compliance and quality review: manager pointer `288333d9b` (integrated `e69fdc476`) passes three targeted tests; viewer pointer `9e8857127` (integrated `757b967cf`) passes four targeted tests. Actual authorized agent/human dispatch supplies immutable tab/navigation/viewport-bound coordinates. Mid-capture pointer changes emit null; reset, navigation, resize and close clear/fence old positions. Viewer scales independently per viewport and hides old-epoch, held-barrier, detached and stale positions. Actual fixture viewer screenshot shows the canonical pointer and native focused caret; parent visually inspected `viewer-pointer-caret-9qNeNU/actual-viewer.png`, and independently reran four tests retaining `viewer-pointer-caret-bIGejB`. No live demo restarted and no improved latency claim made.

## Combined-render protocol formal resampling

A new serialized browser-lane measurement window ran at exact integrated head `53bdfd7057fffdd4148e5b0ef0719c9b92322257`, 2026-10-01 23:26:14.410–23:27:59.161 UTC. Sixty-one tracked prototype source digests and HEAD were unchanged before/after. Parent and browser workers avoided competing browser/tests; unrelated programme verification and operator activity were not stopped or claimed idle. One-minute host load decreased from 39.19 to 25.60. This is scoped observation, not a universal service guarantee.

| Condition                           | Samples |      p95 |  Maximum | Observed result                   |
| ----------------------------------- | ------: | -------: | -------: | --------------------------------- |
| Local input-to-drawn render         |     100 | 163.1 ms | 216.8 ms | Pass against 250 ms p95           |
| Injected 150 ms RTT                 |     100 | 542.9 ms | 662.7 ms | Pass against unchanged 600 ms p95 |
| Fast viewer beside stalled observer |     100 | 132.6 ms | 136.5 ms | Pass against 250 ms p95           |

The slow subscription lasted 15.715 seconds and retained at most one pending frame / 44,458 bytes, with 236 superseded-frame drops. Each gate detected the intended missing-render-ACK negative once. All 100 observations were retained in the measured distribution; no slow observations were removed. Capture/JPEG cost and produced versus acknowledged JPEG payload rates are reported separately, excluding total wire overhead. The original RTT100 p95 629.9 ms failure remains retained. The new injected-delay pass is not actual tunnel proof.

Receipts and exact ESM invocation/provenance remain at `/var/folders/64/06xfpz_s2kj5xc29cmm6f2fw0000gn/T/mechanics-formal-combined-B74q45/receipts/window.json`. An equivalent CLI recipe is `node scripts/browser-control-prototype/mechanics/mechanics-gates.mjs <repository> <private-profiles> <private-artifacts> render-local render-synthetic-rtt stream-stall`; that recipe was not separately rerun. Runtime remains Playwright 1.63.0, Chromium revision 1243 and the previously recorded executable SHA on Darwin25.6.0 arm64. Owned contexts shut down and profiles were removed; the final process-path scan found no command containing the exact profiles path. That scan is not a complete birth-identity descendant inventory; the separate resource recovery gate retains that stronger proof. Independent compliance and quality review accepted the final measurement set (journal27 clean), including exact Git-blob comparison of all61 source digests; no rerun.

The subsequent serialized integrated correctness run at the same source head failed: `node --test --test-concurrency=1 scripts/browser-control-prototype/__tests__/*.test.mjs`, 98 cases / 93 pass / 5 fail, duration120,144.800834ms. All five failures occurred in manager shutdown/recovery in `manager.test.mjs`; aggregate shutdown errors conceal the specific cause in four cases, and stop-recovery reports `BROWSER_STOP_FAILED`. Output is retained in local ignored `.dork/flow/tmp/browser-integrated-final.tap`. The cause remains unproven; it is not discarded as host interference. The successful formal render evidence is separate from integrated verification and full production readiness.

## Shutdown diagnostics and current integrated verification

Independent changed-scope review accepted `7677fff8ffe208a3820830ff2fdf881b066a1124` (journal28), integrated `de91d45f7`. This preserves both two-second close/root observation budgets, strict PID/birth checks and reservation policy. A fixed `stopFailureCode` distinguishes context-close rejection from timeout; shutdown summaries retain at most32 opaque browser IDs and fixed allowlisted codes, without raw exception/page content. Four old-source diagnostic regressions fail and four corrected tests pass. This is classification, not a demonstrated correction of the earlier failures.

One fresh serialized integrated run at `de91d45f7` passed102/102 cases, no skips/cancellations, exit0, duration85,053.399041ms. Output is retained in local ignored `.dork/flow/tmp/browser-integrated-diagnostic.tap`. All five earlier failing cases pass in this run, but no retrospective root cause is established and the original failed TAP remains unchanged. Review must assess reliability using both observations.

The earlier failed fixture run left four owned clean-profile roots (`browser-manager-OfuEtc`, `browser-manager-tI9nN4`, `browser-manager-nmK8Pb`, `browser-manager-38RQDY`) under the recorded private temporary parent. Their historical browser root PID/birth records are unavailable, so they remain retained for manual repair. A current profile-path process scan cannot replace that missing attribution and is not a complete descendant cleanup proof. The persistent `browser-manager-D9Mr7H` record retained manager43462/browser46266 with recorded birth identities; authoritative absence and existing reservation guards allowed precise owned cleanup. These automated-fixture remnants are separate from the attended demo, whose process, listener and directory were verified stopped/removed.

## Whole-branch review correction pending

Fresh nonauthor compliance review of pushed `8e3cb6935896faae6adc3e6413a398a6e7f3b56b` against requested base `e3210be2cb14c823696a213f4df0ab21fa8acdd8` found one Important defect. The actual merge base is `996161118a84f938fe76b6e569ba077dfb7a574a`; review used the complete three-dot diff rather than attributing unrelated main changes to this branch.

The durability runner's shared observer marks any `AssertionError` as a detected negative control. A bounded no-browser reproduction through supported `probeOverrides` throws an unrelated setup assertion in each negative path: all four receipts incorrectly report pass/detected, including two claimed exclusion observations. Task 2.2 is reopened pending cause-specific detection, actual observation counts, unrelated/wrong-cause regressions and re-review. Historical durability receipts and current test results remain retained; they do not excuse the classifier defect, and the reproduction does not by itself invalidate their actual stored-state observations. No PR exists and whole-branch quality review waits for a corrected pushed head.

## Cause-specific durability correction and reconciled verification

Independent changed-scope compliance and quality review accepted `29fb3472a202822828e14c4e89f393e05d225a85` (journal 37), including source correction `4d20564b9`. The observer accepts only a matching typed negative observation raised after the exact intended state: all durable stores empty on a real restarted clean context, seeded state in supposed clean mode, the same live Page with exactly 200 mutations and worker-B stores, or two separate reservation contenders both becoming holders. Negative counts come from those observations: `[1, 1, 200, 2]`. Generic setup assertions, forged fields and wrong typed causes cannot certify detection; baseline setup assertions count zero observations.

Independent no-browser reproduction returns unverified and zero negative samples for all four unrelated-assertion controls after correction; substituting the old runner reproduces its incorrect pass/detected output. The actual Chromium matrix asserts the negative counts. Changing shared-context count 200 to 1 fails that exact assertion; restored source passes. These controls verify classification and counts, without changing the earlier stored-state or crash promises.

After conflict-free reconciliation with main, exact integrated source `3098682a2310f2562be5c70b8b238c7357d55b48` passes the serialized suite: 104/104 tests, no skips/cancellations, exit zero, duration 67,189.596375 ms. Output is retained in local ignored `.dork/flow/tmp/browser-integrated-durability-corrected.tap`. Explicit ESLint over the whole prototype passes. Requested base `e3210be2cb14c823696a213f4df0ab21fa8acdd8` is now the actual merge base, so the next review uses a reconciled branch. Task 2.2 is accepted again; a new exact pushed-head whole-branch compliance and quality review is still required before PR creation. The original 98-case shutdown failure and later 102-case pass remain retained; this durability correction does not establish their retrospective cause. Formal latency evidence remains frozen at its measured head, without resampling.
