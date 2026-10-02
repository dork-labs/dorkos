# Implementation Summary: Managed browser delivery

**Created:** 2026-10-01
**Last Updated:** 2026-10-01
**Spec:** specs/shared-browser-control/02-specification.md

## Progress

**Status:** In Progress — bounded prototype first; production scope remains pending.
**Tasks Completed:** 7 / 10 prototype tasks

## Tasks Completed

### Session 1 - 2026-10-01

**Workers:** /root/browser_architecture (analysis/spec review/decomposition), /root/prototype_contracts (task 1.1), /root/prototype_manager (task 1.3 implementation), /root/prototype_control (task 1.4 implementation)

- Task #1.1: evidence contracts and exact runtime loader — worker: /root/prototype_contracts; integrated commits915d7b9ff/748af2880. Compliance passed, quality found sparse-array false pass, fix re-reviewed clean;9/9 Node tests independently pass. No browser-mechanics gate implied. Execution analysis plan: 1.1 → (1.2, 1.3, 1.4) → (2.1, 2.2) → (2.3, 3.1, 3.2) → 3.3. Maximum three isolated writers. Task API is unavailable in this harness; canonical `03-tasks.json` drives statuses and dependencies.

- Task #1.2: isolated fixture — parent implementation, independent /root/browser_architecture compliance and quality re-review passed. Four actual-Chromium fixture tests passed; thirteen foundation tests passed in aggregate. Foreign-host mutant and blocked-release bookkeeping mutant each failed the intended test. Missing executable run exited1 in0.25s (independent0.34s), two expected runtime errors, no leaked server. Persistent, short-lived, expired and session cookie modes are observable; blocked requests expose explicit observation/release. These prove fixture mechanics only.

- Task #1.4: token-bound control — integrated4c762f423/ad4606580 after independent compliance and quality review on2a45c6b59. Initial review found arbitrary loopback navigation and new tabs escaping stopped browsers; both regression tests failed the old implementation. Exact fixture-origin navigation and browser-wide stopped tombstones fixed the findings. Seventeen control tests and thirty aggregate foundation tests pass independently. Actual Page handoff/reset and measured viewer gates remain pending.

- Task #1.3: canonical Chromium manager — integrated e90882e3e/da6e39da8 after independent compliance and quality review. Twenty-four baseline tests passed; quality reproduced unbounded child IPC startup after missing ps. Fix re-review independently observed nonzero exits in0.37s/0.10s and exact child termination regression. Forty-six integrated foundation tests pass. Independently removing proxy-origin guard caused the intended real second-listener test to fail with one forbidden request. Private exact-origin proxy also confines service-worker requests while retaining HTTP cache. Corrupt reservation/recovery-guard state remains a documented manual-repair prototype limitation; Windows process mechanics are unverified.

## Files Modified/Created

Spec/research input seeded selectively; run assumptions, bounded specification and task artifacts written. No production source changed.

## Known Issues

Task1.4 compliance findings were fixed and re-reviewed. Manager exact-origin network confinement passed; no production engine or app integration is implemented yet. Persistence and process gates have worker evidence pending acceptance; viewer, native surface and resource gates remain under verification.

## Implementation Notes

Worktree `/Users/doriancollier/.codex/worktrees/3b8f/dorkos`, branch `codex/shared-browser-control`. Parent owns DOR-2667 tracking, integration, independent review, all merges and cleanup. All subagents use explicitly selected GPT-6.1 Sol / Medium. Shared ignored canonical Flow bookkeeping is authorized by coordinator; source changes stay in worktrees. Explicitly assigned issue route occupies browser programme slot; no unrelated queue dispatch.

## Resume

**Done:** Flow EXECUTE; all four foundation tasks integrated after independent review.
**Next:** independently review viewer2.1 and durability2.2, then measured mechanical/native/resource gates; actual evidence before production SPECIFY.
**Open questions:** native observation availability, input/accessibility/latency/resources outcomes.
**Next command:** execute optional viewer and profile-durability gates in their isolated worktrees.

### Isolated worker checkouts

- `browser-prototype-foundation`, branch `codex/browser-prototype-foundation`: task 1.1 contracts; seeded specs are uncommitted input, scripts only may be committed.
- `browser-prototype-manager`, branch `codex/browser-prototype-manager`: lifecycle/reservation module; contracts integrated; task implementation/review in progress.
- `browser-prototype-control`, branch `codex/browser-prototype-control`: participant/control module; contracts integrated; task implementation/review in progress.

Parent owns all three and will remove them only after their commits are integrated and preserved remotely. Native input reset and document compatibility refinements came from coordinator independent integration audit.

- `browser-prototype-viewer`, branch `codex/browser-prototype-viewer`: task2.1, reviewed foundation seeded, dependencies installed.
- `browser-prototype-durability`, branch `codex/browser-prototype-durability`: task2.2, reviewed foundation seeded, dependencies installed.

Parent also owns these checkouts and their cleanup after remote preservation/verified merge. Preliminary native observation attempts: Dock AX timed out; CUA rejects Codex native app observation by policy. Neither proves Dock/app-switcher or foreground behavior.

### Session 2 - 2026-10-01

**Workers:** /root/prototype_control (task2.1 in viewer worktree), /root/browser_architecture (task2.2 in durability worktree); /root/prototype_manager available for independent viewer review. DOR-2668 readied and claimed through configured Flow after all foundation dependencies passed. Parent owns all tracker writes, integration, independent review, shipping and cleanup.

### Foundation follow-up and mechanical review

Manager source was split into lifecycle, fixture proxy, input and error modules to meet the 500-line convention. Independent review passed after extraction; integrated commit49e50cb7e. Runtime CLI entrypoint now resolves filesystem aliases before deciding whether to execute; independent direct/import/symlink checks passed and the old guard failed the alias receipt assertion. Integrated commitd4d7ca47f; forty-seven foundation tests pass.

Task2.2 first compliance review found invented observation counts on infrastructure failure, silent CLI alias exit, and missing actual two-manager contention. Worker corrections on4c2459f48 passed four independently rerun tests, including three Chromium restarts, clean return, two unattended profiles and actual process exclusion. Subsequent quality mutation substituted an unrelated first browser startup error: the race probe still certified two observations. Acceptance is pending recognized refusal-cause validation and a regression. Session cookies were lost across the three restarts; durable profile persistence does not imply session-cookie preservation.

Task2.1 clipboard tests initially seeded fictitious data without establishing platform pasteboard isolation or preserving previous content. Platform impact is uncertain; no prior contents were captured. Further checks use fixture doubles and explicitly record synthetic permission outcomes. Native clipboard behavior remains unverified.

- Task #2.2: durability and exclusion gates — worker: /root/browser_architecture; independent compliance and quality re-review passed8c2e68fba. Integrated bcc80957d/670cfa0d3/972dd6737/6c8e537b1. Five targeted tests independently pass. Three actual restarts preserve persistent cookies, localStorage, IndexedDB, service worker/Cache Storage and HTTP cache. Unseeded clean context returns to unchanged durable profile; two separate unattended profiles complete200mutations. Separate actual manager processes admit one Chromium holder and refuse one contending open. Infrastructure-only failures record zero observations and unknown crash outcomes; unrelated startup failure cannot count as exclusion. Negative controls fail for ephemeral persistence, seeded clean mode, shared context and per-process reservations. Session-cookie loss is explicit.

Native fixture viewer observation was attempted through a dedicated Chrome tab. Chrome blocked the exact loopback viewer with ERR_BLOCKED_BY_CLIENT; AX reported the block. No security settings changed or alternate address bypass attempted. The created error tab was closed and exact owned fixture-manager PID was gracefully shut down. Native IME/viewer observation remains unverified.

### Prepared next gate checkouts

Parent created `browser-prototype-mechanics` / `codex/browser-prototype-mechanics` and `browser-prototype-resources` / `codex/browser-prototype-resources` from25b19226c. Frozen dependencies installed with lifecycle scripts disabled. These are prepared checkouts, not active task executions: viewer quality fixes must pass before its dependent gate source is written. Parent owns cleanup after verified merge and remote preservation. Resource planning resolves fresh browser-cache scenarios in separate processes and uses explicit `playwright install chromium --no-shell --no-remove`; no system dependencies or silent action downloads.

- Task #2.1: optional authenticated pixel viewer — worker: /root/prototype_control; independent /root/prototype_manager compliance and quality re-review passed1856f065b. Integrated978142410/67ecb46ae. Eight viewer tests independently passed, then sixty integrated prototype tests passed. Pointer cancellation/lost capture now releases the held canonical button. Setup cleanup registers before acquisition and continues through errors; the original missing-PATH reproduction exits naturally in600ms. Wrong-Page bytes with matching metadata fail the independent named-Page pixel oracle. Native IME, phone touch and clipboard remain unverified; engine composition/touch and clipboard doubles are labeled explicitly.

### Session 3 - 2026-10-01

**Workers:** /root/prototype_control (task2.3 in mechanics worktree), /root/browser_architecture (task3.2 in resources worktree), /root (task3.1 native/semantic evidence), /root/prototype_manager (independent changed-scope review). Both task2 dependencies passed before the new gate implementations started. CPU-heavy latency and resource measurements use separate quiet windows; source files and tracker ownership remain disjoint.

Task2.1 reopened during native evidence consolidation: the retained eight-test matrix failed one drag-start precondition after the earlier60-test integration pass. Receipt generation refused the failed baseline. Deterministic delayed-control reproduction proved status-only readiness accepts the previous controller; a separate held-frame reproduction showed an older frame response overwrites a newer control epoch. Viewer worker pauses mechanical gate work to correct state adoption and readiness checks in its original viewer checkout. Resource installation/crash preparation remains independent; performance measurements wait for convergence.

Viewer race corrections passed independent compliance/quality re-review at6556a0519; integrated7844c7c74/2ace73827. Sixty-two integrated tests pass with no skipped tests. Old-client substitutions independently fail both delayed-state assertions after later frames are held through the assertion. Task2.1 is accepted again; mechanics/resource checkouts receive the reviewed dependencies before measurement.

Task3.1 evidence retained seven validated receipts outside source: semantic keyboard path has one observed fixture path and one observer-denial control; six native surface gates remain unverified with zero native samples and concrete next proofs. This is awaiting independent review. Resource sampling uses a separate roughly90-second browser-lane window while mechanics and parent avoid Chromium/tests; the operator and other peers are not claimed idle.

- Task #3.1: native and semantic evidence — worker: /root; independent /root/prototype_manager compliance and quality re-review passed corrected artifact set `browser-native-evidence-Zpaig6`. One actual fixture semantic read/focus/activate path passes with a view-only input refusal control. Six native surfaces remain unverified with zero native samples and concrete next proofs: IME, clipboard, physical phone, actual tunnel, full accessibility parity and Mac presence/focus. First evidence review caught export time labeled as semantic observation time; corrected provenance uses original integration output collection time and20,602.9995ms full-command duration, and explicitly leaves individual semantic timing unavailable. Receipt export time is separate. Completing this bounded evidence task does not establish native or production readiness.

Task 3.2 writer committed `0c9f2e23b`; seven new gate files remain isolated from production source. Seven targeted tests passed after fixing a probe context-close ordering race found by the initial full run (68/69). Independent task review is pending. Explicit cold install and committed-store crash recovery were observed. Separate recent-write abrupt-death probes lost cookie or localStorage state; those failures remain retained. Resource sampling collected 74 observations across five phases on a loaded host; corrected conservative pressure caps recommend zero additional slots. Mechanics now has the exclusive browser-lane measurement window. The initial three-sample RTT smoke exceeded 600 ms; the threshold remains unchanged.

Foundation task 1.3 reopened after the descendant-aware crash probe observed a live Chromium root after its SingletonLock disappeared, while a new profile reservation succeeded. This is a failed recovery gate. Original manager writer is correcting persisted process identity and uncertain launch recovery; parent independently reviews that dependency before downstream Chromium measurements resume. Static gate corrections continue. Mechanical review also requires intended-failure negative controls, changed-revision pixels in both concurrent viewers, bidirectional realpath separation and primary-error preservation during cleanup. Six bounded tasks remain accepted while the lifecycle task is reopened.

Manager recovery corrections passed parent independent changed-scope review through worker head `1f00dca4d`: launch phases and recorded browser PID/birth survive native-lock removal; unknown launches/legacy stale owners require manual repair; unavailable process observations refuse native-holder recovery and clean-directory deletion; fallible post-launch cleanup retains its owned record/directory and fixed primary/cleanup codes. Twenty manager/reservation tests independently passed, including real Chromium and ten Node-only fault controls. Integrated as `46f182d21`, `fb0889ec7`, `5b35436f3`. Resource worker's formerly red descendant-aware gate now passes in its corrected checkout; exact inventory review remains pending before task 1.3 acceptance.

Human requested an interactive fixture test and visible assistant control. A temporary loopback demo uses one clean canonical browser, preissued fake participants and a scripted agent that increments/types every three seconds only while it owns control. Takeover stops its input; handoff to `fixture-agent` resumes it. Temporary same-origin demo bootstrap automatically connects the viewer without token URLs or an enrollment API; this bootstrap is fixture-only, not production authorization. Viewer clipboard buttons are disabled. The demo expires after 30 minutes and stores only owned cleanup metadata under ignored Flow tmp. Dedicated frontend verification observed Connected, canonical width 1280, fixture-agent controller and actual rendered revision/text. Demo interaction evidence is separate from native/performance gates. Formal resource/latency acceptance pauses during the demo; correctness checks use separate temporary fixture/profile roots.

The user stopped the attended demo and reported mild lag plus an invisible typing cursor. Exact demo Node PID 19759 stopped naturally after SIGTERM; its listener and temporary directory were verified absent. No demo remains running. Native caret correction dd4df9d2d independently passed both option and real-pixel tests; parent observed the actual caret screenshot and integrated d5cb50a3e. Protocol correction ca7d75bc1 independently passed nine serialized protocol/viewer tests and integrated 9d799cfec, carrying a genuine post-paint acknowledgement on the next frame request. These are correctness observations, not improved latency measurements. Task 2.4 adds canonical mouse-pointer feedback and stale-lifetime tests. Manager recovery and descendant-aware resource inventory corrections passed exact changed-scope review; tasks 1.3 and 3.2 accepted. Original RTT and recent-write crash failures remain retained.

Task 2.4 accepted after independent compliance and quality review: manager pointer `288333d9b` (integrated `e69fdc476`) passes three targeted tests; viewer pointer `9e8857127` (integrated `757b967cf`) passes four targeted tests. Actual authorized agent/human dispatch supplies immutable tab/navigation/viewport-bound coordinates. Mid-capture pointer changes emit null; reset, navigation, resize and close clear/fence old positions. Viewer scales independently per viewport and hides old-epoch, held-barrier, detached and stale positions. Actual fixture viewer screenshot shows the canonical pointer and native focused caret; parent visually inspected `viewer-pointer-caret-9qNeNU/actual-viewer.png`, and independently reran four tests retaining `viewer-pointer-caret-bIGejB`. No live demo restarted and no improved latency claim made.

Mechanical task2.3 independently accepted after primary-preserving inner-cleanup correction and final100-sample local/RTT/stall resampling at53bdfd705, journal27 clean. New p95 values163.1/542.9/132.6ms pass unchanged250/600/250 targets; originalRTTFAIL remains. Broader integrated98-case run then failed five manager shutdown/recovery cases (93pass), retained120.145s output. Manager writer investigates primary context-close/liveness cause and attributable owned-profile cleanup; no threshold change or failure dismissal. Task3.3 remains in progress and production06/ADR remainProposed; semantic/egress/identity refinements continue statically.

Diagnostic7677fff passed independent changed-scope review (journal28), integratedde91d45f7. Fixed allowlisted close rejection/timeout and bounded shutdown summaries preserve existing2s budgets and reservation/PID-birth policy. Fresh serialized integrated102/102 cases passed85.053s with exit0 and no skips/cancellations. The original five failures remain retained with unproven cause; the pass is current-head verification, not a retrospective cleanup fix. Four clean-profile roots lack historical rootPID/birth records and remain retained for manual repair; no complete descendant cleanup proof is claimed. Final exact pushed-head independent review must include these limitations. Proposed07 semantic review requires secret-action dispatch, local virtual-focus continuity and exact notification/continuation/refusal schema corrections before approval.

Proposed 06 identity and egress additions passed independent compliance and quality review at `350046b35` (journal 29). Proposed 07 corrections passed independent two-stage re-review at `8fc5822ad95480a5de25478558d3cb3a15250e35` (journal 32), integrated as `eb5f4036a`. Explicit secret dispatch, exact wire variants, bounded same-field edit continuation and actor-bound event ordering address the prior P2 findings. These are reviewed proposals; implementation and assistive-technology evidence remain pending. Supported runtime policy and native metadata initialization before target execution still require concrete design and proof before production decomposition. Prototype source is unchanged since the passing `de91d45f7` correctness run.

Fresh nonauthor whole-branch compliance review at pushed `8e3cb6935896faae6adc3e6413a398a6e7f3b56b` returned changes: one Important finding (journal 35). Durability negative controls classify every `AssertionError` as detected; four injected unrelated setup assertions consequently produced passing receipts, including two invented exclusion observations. Task 2.2 is reopened and nine of eleven tasks remain accepted. The originating author corrects cause-specific detection and counts in the isolated resource checkout. Native-metadata feasibility work paused before writes or browser acquisition; no owned contexts are active. Task 3.3 and PR creation wait for correction, independent task review and a fresh exact pushed-head whole-branch review. The original durability observations remain retained; the classifier defect does not itself establish that those observations failed.

Durability correction passed independent compliance and quality re-review at `29fb3472a202822828e14c4e89f393e05d225a85` (journal 37), integrated as `f29ee31ad` and `3098682a2`. Matching typed observations require the exact intended behavior; unrelated assertions, forged fields and wrong causes return unverified with zero negative samples. Actual negative counts are asserted as `[1, 1, 200, 2]`; a real Chromium count mutation from 200 to 1 fails that assertion. The old runner independently reproduces the false pass. Main was reconciled without conflicts; requested base `e3210be2cb14c823696a213f4df0ab21fa8acdd8` is now the actual merge base. At exact `3098682a2310f2562be5c70b8b238c7357d55b48`, the serialized integrated suite passes 104/104 tests, no skips/cancellations, exit zero, duration 67,189.596375 ms. Explicit whole-prototype ESLint passes. Task 2.2 is accepted again; task 3.3 waits for renewed exact pushed-head whole-branch compliance and quality review. Original shutdown failures, retained roots, native gaps and crash limitations remain unchanged.
