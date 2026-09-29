# Consumer adoption implementation record

**Status:** Implemented. DOR-2342 — Shared UI: finish consumer adoption and opposing-theme overlay correctness.

## Session

Public worktree: `codex/shared-ui-consumer-adoption`, pinned base `dbff5a6f6b3005d4e9815d1b3d485446528f2900`. Community worker uses its own worktree from the same base. All docs/scratch writes are isolated. Earlier extraction projects remain historical completed work.

Workers: `/root`, `/root/adoption_inventory` (Community), `/root/adoption_decompose` (decomposition and distribution proof). Configured opus binding is unavailable; explicit gpt-6-sol workhorse fallback used for delegation. No Task API exists; JSON task ledger is canonical. Independent implementation details remain outside this public repository.

## Evidence to date

- Current baseline reproduces missing Dialog foreground in Chromium: rgb(23,23,23) on rgb(10,10,10), token 87% gray.
- Dialog, AlertDialog, Sheet now pair their own background with foreground. Outline Button pairs foreground and border too; already paired popover/menu/tooltip surfaces preserved.
- Package 73 behavior tests and catalog 9 tests pass. All 15 built catalog browser cases pass, including new class-only opposing-host tests at 390/1280px with real focus return/cancel/portal placement. Enlarged-text overflow introduced by longer catalog triggers was corrected before passing.
- Newsletter baseline 7 tests pass. Live newsletter and feedback forms now use shared Button/Input/Textarea. Explicit light/card and dark/compact form scopes preserve marketing presentation under either system preference. Mobile column layout uses `sm:flex-1` so the shared input keeps its 44px height.
- Four real Next browser cases pass (light/dark system, 390/1280px): newsletter Enter submit, feedback failure then success, 44/36px computed input height, no page overflow. Requests intercepted locally; no email or feedback sent.

## Pending gates

Implementation, publication, and independent consumer delivery are complete. This final receipt follows the normal documentation review and merge path before tracker closure. The chronological records below preserve earlier gate states and failures.

## Boundaries

Native select/date/file/radio behavior, custom channel geometry, Fumadocs and marketing layout are intentionally local. Client Card/Badge/Skeleton remain local due to application elevation, status vocabulary and animation contracts, not simply lack of extraction effort. The retired Obsidian host is not part of the maintained consumer contract.

## September 27 continuation

Reconciled the saved adoption branch against pinned public main `5794f638160a68811382347356fd29b31ee2e911`. Preserved the Obsidian retirement and account handover configuration; no auth or route changes belong to this UI change. The registry still serves `0.2.0`. The operator explicitly authorized the normal compatible package release after review, archive proof and delivery gates; `0.2.1` remains the candidate, not a published result.

- Closed compliance findings: error recovery uses shared Button with a real home Link; ordinary feedback/newsletter labels use shared Label; consent actions use shared Button.
- Narrowed Community native textarea/button CSS to exclude shared data slots so typography and disabled cursor behavior stay package-owned.
- Fresh focused site verification: 26 tests in four files pass. Fresh catalog production-browser suite: 15 pass. Eight real Next browser scenarios pass across light/dark preference and phone/desktop, covering newsletter/feedback and sign-in/reset flows with intercepted requests.
- Refreshed full affected verification, production site build, Community database-backed browser proof, current independent consumer audit and final reviews remain in progress. Previous archive hashes are historical; the refreshed dependency baseline requires new exact-archive proof before publication.

- Fresh package/catalog typecheck, lint and component tests pass (73 package tests, 9 catalog tests); fresh site production build passes.
- Refreshed archive proof passes: 117 allowed files, 30 export entries / 27 JavaScript modules, declarations, one React/ReactDOM runtime, generated CSS and 15 browser cases. Candidate SHA256 `a88daa8ba7169d8e57d233761eda6c746c59d429bec57259a86f3e048dd8f1d4`, 55,736 bytes. Source maps contain no embedded source content; package has no absolute/private references. These exact bytes are retained for release.
- Independent public compliance review passed against the refreshed pinned base after restoring the source-pattern cells in the guide coverage table. The coverage-map check passes. Quality review and delivery gates remain outstanding.

- Refreshed Community verification passes: build, typecheck, lint (no errors), 52 component tests and 41 PostgreSQL-backed browser tests across 14 files. Browser report validation also passes. Native-control inventory remains intentional. Concurrent pairing behavior is owned separately and will be reconciled if it lands before this delivery.
- A phone-sized opposing-theme Dialog/AlertDialog/Sheet focus regression was recorded as WebM from the independently installed archive. This harness has no annotated-GIF capture; the local recording supplements the executable browser suite and test summary.

- The full affected run passed 67 typecheck/lint/build tasks. The site suite passed 140 files / 1,450 tests; the client passed 1,305 files / 16,441 tests, while three other client suites could not initialize because the disk was full. After removing only this task's stopped, regenerable Next preview/cache/server output, those three suites passed all 30 tests in a targeted rerun. Original failure and recovery logs are retained; the full gate remains incomplete because downstream tasks were interrupted.
- Preliminary independent quality review found no blocking issue at `892930d02235ad2e9b7d15c52865e8bf9d3afa57`. Final approval still requires the pairing reconciliation and verification of the pushed branch. The retry-control browser assertion now explicitly checks shared Button ownership; its combined browser rerun remains pending.
- Serialized recovery completed the Community (309 passed, one skipped), Mesh (431), memory (111), e2e helper (134), and agent gateway (149) unit suites. The server passed 21,713 tests but one unchanged room-file test timed out at five seconds; its complete file then passed all 34 tests in isolation without a source or timeout change. Both receipts are retained. Desktop, CLI, and eval unit tasks continue separately after the interrupted run.
- The remaining desktop (814 tests), CLI (1,337 passed, two skipped), and eval (572 passed, one skipped) suites pass. All interrupted package tasks now have results; no broad run is mislabeled as wholly green. The strengthened shared Button assertion passes with all seven non-database Community browser cases. Final reconciliation and review still wait for the separately owned pairing change to merge.

## September 28 pairing reconciliation

Pairing recovery merged separately in PR #2257 at `b7a7fb3feb0e907cfcf4fc0187d84f90c6c9174f`. Reconciled against pinned main `a1710cbc1b0d357b44c6600274c3153a823b605a`, preserving its callback boundaries, recovery after expired sessions or changed membership, terminal-request refresh, and acceptance of existing passwords shorter than eight characters. The new Google, GitHub, and SSO controls use shared Buttons; no sign-in or request logic changes belong to this reconciliation. The browser proof now checks shared ownership and explicit button types while retaining the merged callback assertions. Its screenshot goes to the isolated test output directory.

The new main's architecture and Community documentation updates are preserved. The spec manifest retains both the newly merged entries and this adoption entry. A read-only inventory found no new generic Community controls outside Pairing, and refreshed compliance review passed. Community production build and typecheck pass; all 13 combined pairing and shared-control browser cases pass against the rebuilt application and an isolated PostgreSQL database. The test database and container were removed after verification. Final pushed-branch quality review remains before PR creation.

Automated PR review found that paused membership choices lost their unavailable cursor/background when the shared Button's data slot excluded them from the old native-button rule. The unavailable style now belongs specifically to `.community-choice[aria-disabled='true']`, keeping the row focusable while restoring both visual cues. The strengthened browser assertion first failed with cursor `default` instead of `not-allowed`; after the scoped selector fix and a fresh Community build, all seven shared-control browser cases pass, including the unavailable background, focus, and blocked navigation.

## Published release and registry proof

Public implementation PR [#2270](https://github.com/dork-labs/dorkos/pull/2270) merged at `391660bccc84c953266a646f065363cf77b49593` after required CI, independent review, automated re-review, and the normal merge queue. The final review reported no blocking issues.

The authorized `@dork-labs/ui@0.2.1` release is available from npm. Its downloaded registry archive is byte-identical to the tested candidate: 55,736 bytes, SHA256 `a88daa8ba7169d8e57d233761eda6c746c59d429bec57259a86f3e048dd8f1d4`, integrity `sha512-xOn4gt37T6uHw9e1qYcl0/pLqvVvdQlup2glY6zQUGVYFwfv48E4Z/OMQClr2bntLlbKoVrlKegMJ6V0dYaI0A==`.

A clean install from the actual registry version passed independent typecheck, production build, and all 15 browser cases. All 27 JavaScript export modules loaded, declarations resolved, generated styles worked, and React/ReactDOM remained single instances. The lockfile resolves the npm registry archive with the same integrity; no source alias or workspace resolution is involved. Independent consumer registry delivery is complete.

## Final consumer delivery

The independent consumer now pins the published `0.2.1` version with a frozen registry lockfile whose integrity matches the verified release. Its affected component and browser checks, typecheck, lint, production build, and normal push checks passed. Independent compliance and quality reviews approved the final pushed branch with no blocking findings; all required CI checks passed and the consumer change merged through its normal protected PR path. Detailed implementation and delivery receipts remain with that consumer.

All four phases and every implementation task are complete. Package, catalog, Community, site, registry fixture, and independent consumer evidence are recorded above or in their owning records. No live deployment or paid test gate was part of this delivery.
