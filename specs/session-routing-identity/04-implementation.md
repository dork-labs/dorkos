# Implementation Summary: Private routes and cross-runtime session identity

**Created:** 2026-10-06
**Last Updated:** 2026-10-07
**Spec:** specs/session-routing-identity/02-specification.md

## Progress

**Status:** Implementation complete; review and delivery tracked on DOR-2733
**Tasks Completed:** 9 / 9

## Tasks Completed

### Session 1 - 2026-10-06

**Workers:** /root/spec, /root/sessions, /root/routes, /root/locations

Tasks 1.1–3.2 accepted after focused verification and independent Stage 1 source review. Task 4.1 is in progress.

## Workspace

- Workspace: isolated managed `session-id-links` worktree; this task has written no files in primary main; unrelated concurrent work is preserved.
- Branch: `codex/session-id-links`
- Tracker: DOR-2733; related existing bug DOR-2716.
- Resume: existing uncommitted directory-binding fix retained; fresh workers seeded from the diff.

## Known Issues

Final independent review of the replacement pushed head, PR checks, merge and cleanup remain at this implementation checkpoint. Nothing is merged yet.

## Implementation Notes

- User approved full summarized scope, autonomous execution, PR merge and cleanup on 2026-10-06.
- Configured opus/sonnet workers unavailable in Codex harness; use available default gpt-6.1-sol, never expand billing to paid inference.
- Task API unavailable in this harness. 03-tasks.json is canonical and task status is recorded there; no substitute task IDs invented.
- Worktree already existed at EXECUTE; intent artifacts kept there to preserve explicit instruction to keep primary main clean.
- No new project created: one umbrella work item captures accepted scope; avoids unnecessary project gate.

## Review and Verification

Independent Stage 1 found and drove fixes for authoritative cwd on reads and writes, unavailable native storage, owner-scoped durable discovery, cold-list creation inference, and separate legacy profile subjects. Its final source review reported no remaining blockers; independent focused rounds passed 8 files and 202 tests.

Worker-focused server verification passed 149 core/stream/socket/native-reader tests, 33 launch/existence/continuation tests, and 184 Codex/OpenCode/search/migration tests. Client profile/lifecycle batches passed, including a distinct Host conversation and Linked profile with opaque references. Web build passed. Copy, vocabulary and documentation coverage checks passed. Final gates are recorded below only after their actual completion.

A preliminary full client run identified obsolete URL/cache assertions; it was stopped after regression fixes because simultaneous targeted runs invalidated shared lint fixtures. The final client run uses Turbo in isolation. Earlier browser boots exposed compilation errors while source was still changing; those runs provided no browser proof and are not counted as passes.

The full client regression run passed 1,448 files and exposed three outdated launch-hook fixtures plus a parser test running against an earlier transformed schema. Fresh launch/parser verification passed all 26 tests after correcting the fixtures. A final full run is in progress. The pre-commit directory-size guard also required splitting the session service domain; no hook was bypassed.

### Session 2 - 2026-10-07

**Workers:** resumed /root/routes for fixture corrections; /root owns integration and delivery.

The final full client run completed through Turbo: 1,450 files and 18,541 tests passed. Five isolated browser cases passed, including portable folder launches on a second runtime, canonical session rekeying, ID-only history loading, missing-session errors, route aliases and separate legacy conversation/profile subjects. WebM recordings are preserved outside the worktree for cleanup.

Stage 1 and Stage 2 independent reviews passed pushed head `42a1f40`. Later fixture and web/desktop plugin peer fixes require a final review of the replacement pushed head. Both web and desktop builds passed; the shared router configuration now exports options so each app uses its own Vite plugin peer.

The initial full server run was interrupted and is not counted as a pass. A 75-file fixture sweep exposed missing registry mocks and one malformed generated mock. Those are being corrected, with a fresh bounded sweep. An isolated room-file rerun passed all 36 tests after the sweep's timeout. The session-cwd suite passed 21 tests, including the new regression that an existing native session cannot be moved into a requested workspace.

Main advanced during the interrupted run. Integration must preserve its newer space gating, runtime compaction and audit migration. The new session tables must be generated after that migration, with an existing-database upgrade test; retaining their older timestamps would let Drizzle skip them on upgraded installations. No PR has opened or merged at this checkpoint. Explicit user authorization covers completing review, merging and cleaning only this worktree.

### Final implementation verification

- Main reconciled at pinned `993235b4`: newer space gating, compaction and audit code retained. Three new compaction imports updated for the moved session helpers.
- Affected client suite: 122 files / 1,980 tests passed. The earlier full Turbo client suite passed 1,450 files / 18,541 tests.
- Affected backend sweep: 169 files passed (4,187 tests, 27 skipped); its sole failure was the admission census expecting 69 mounts after adding session-locations. Updated to explicitly cover that mount, with all 7 admission tests passing. The initial broader interrupted server run is not a passing result.
- Registry/test-runtime regressions passed, including native source preservation on canonical rekey. An upgrade from the audit-era database passed and retained existing rows; Drizzle reports no schema changes.
- Five fresh browser cases passed on isolated free runtimes, including the secondary-runtime portable draft, canonical rename and cold ID-only history. A preceding failed run caught a cleanup render loop and missing scripted-runtime discovery; both were corrected. One later boot refused an orphaned test Vite port; the owned leaf was stopped before a fresh isolated run. Five final WebMs are preserved outside the worktree.
- Client, server and desktop typechecks passed; package/root lint has no errors (existing advisory warnings remain). Web build and complete desktop renderer/server packaging passed, including all 77 runtime specifiers and copied migrations. OpenAPI and generated reference docs regenerated. Copy/vocabulary guards passed.
- Task 4.1 records implementation verification only. Independent final pushed-branch review, PR/queue checks, actual merge and worktree cleanup are the Flow delivery gates, not claimed complete in this source artifact. User authorization to finish them autonomously is recorded on DOR-2733.

### Final review corrections

Review of pushed `e78a223` found three blockers before PR creation. Settings PATCH could turn a missing draft detail query into success and clear creation intent; a display-only metadata read could erase a verified native account; unavailable OpenCode native history could appear as an empty transcript. These are delivery-blocking regressions, not accepted limitations.

The account regression fails before preserving the prior verified source when display metadata omits it. Known or deterministic native OpenCode identities now propagate storage unavailability; only unbound drafts retain the event-log fallback. Fresh focused verification passed 291 tests across registry, OpenCode runtime and mapper; conformance/compaction passed 72 tests with 9 live-runtime tests skipped. Scoped backend types and lint passed (two existing size warnings); server packaging passed. The client fix requires separate authoritative GET evidence before draft cleanup. Its actual settings-PATCH/account regression and all-runtime first-send hints passed (54 focused tests); client types and scoped lint passed. Replacement pushed-head reviews remain pending.

The stronger portable-draft browser test changes permissions before its first send and checks both stored settings and canonical native metadata. It exposed the free scripted runtime rejecting draft settings, then failing to carry shared saved settings into a second runtime. Its implementation now separates pending settings from native existence and uses the same settings port as production runtimes. Earlier browser retries also exposed a test assertion tied to a toolbar chip that moves into overflow; the test waits for the actual changed-setting offer instead. None of those failed runs is counted as browser acceptance.

Fresh review-fix verification passed all five browser cases, now including a real pre-message permissions PATCH, retained portable draft, stored choice, chosen-runtime first send, canonical permission preservation and cold ID-only reopen. Five new recordings are preserved outside the worktree. Final scripted/shared-settings verification passed 168 tests (4 skipped), with 45 neighboring route/control/render tests passing after updating an obsolete draft-PATCH404 assertion. Final server types, scoped lint and server packaging passed; client/web and complete desktop builds passed on the corrected client. Replacement pushed-head reviews, PR gates and actual merge remain delivery work.

Draft PR CI caught an own manifest-formatting regression: the spec/ADR insertions had escaped existing Unicode, so the repository round-trip fixture could no longer verify canonical writer behavior. Restoring original Unicode reduced the manifests to the intended added entries and supersession fields. The original fixture failed locally; all 52 script fixtures now pass. No routing/runtime behavior changed in this correction. Replacement-head review and CI remain required before landing.

The clean CI lint job exposed a build-order dependency in the route rule: its package export pointed at absent shared/dist. Directly reading the data-only shared TypeScript source under the repository's supported Node runtime removes that dependency without duplicating route constants. The actual import failed with its built target absent before the correction and passed afterward. A source-only temporary-checkout regression plus the existing AST cases passed13tests. Automated review of468cd39 reported no blockers but disclosed that GitHub's300-file diff cap prevented full coverage; the two independent local reviewers did inspect the full source diff. The lint correction requires renewed pushed-head review and CI.

CI also caught two stale fixtures: the exact database table census did not list the new session tables, and room fallback tests had no composed registry for the new native-cwd lookup. The census now includes both tables; the room fixture explicitly models an unbound new session. No production fallback was weakened. Fresh verification passed67tests across migrations, audit-era upgrades, room placement and cwd resolution. Scoped lint and formatting passed. The last CI shard is still running; a complete server-suite pass is not claimed.

### Merge-queue browser corrections

The first queue attempt at `b72855d` failed the full browser gate and was ejected; it did not merge. Its PR-head checks and unit shard union had passed. Queue failures exposed two production regressions: the global fleet stream could deliver its preamble before the lazy route mounted and installed entity listeners, losing error/approval rows after reload; and a profile reference with no panel-open modifier did not establish the automatic dock’s subject. Entity listeners now install before any stream provider connects, and the profile subject resolves independently of the panel-open request and conversation cwd.

Old browser fixtures also asserted directory paths in public URLs or supplied virgin IDs as existing-session addresses. They now inspect private location resolution and explicitly prepare draft addresses, while native/existing/missing-ID tests retain strict lookup. The extension reload skeleton test now holds its actual bundle to exercise loading deterministically. The stronger fleet-preamble test waits for the canonical address, then holds only the first detail response using the repository’s persistent `interceptNext` helper. An earlier one-shot interceptor violated the documented Playwright guidance and produced intermittent stalls; that harness mistake was corrected without changing route splitting. Original reload tests passed after the source fix; the broader corrected browser run and renewed pushed-head review are still pending at this checkpoint. No paid inference is armed.

The broader browser run also exposed system-agent launch references failing under a redirected data directory. Location registration/read now use the existing session/agent boundary policy, narrowly allowing `agents/` while refusing data siblings and escaping symlinks; all 7 location tests, server types and scoped lint pass. Ask DorkBot’s test now waits for the new draft address and intended composer before sending, while still aborting its model-bearing request.

Two first-turn canvas tests exposed a genuine canonical-loader timing regression. Rekey now re-aims pending writes and binds the same canvas before canonical stream attachment; repeated binding to the same session preserves its already received authoritative snapshot. The global retirement event uses the same identity handoff before announcing the canonical target. Six focused suites passed 144 tests, including early hydration and held-write delivery before a delayed route commit, synchronous202 ordering, and inactive-session isolation. Client types and scoped lint pass; Fresh canvas/native/connections verification passed all 36 browser cases. Separate mobile/profile/direct-message/Codex-creation verification passed all 18 cases.

Final corrected browser verification passed all 21 cases (seven affected cases repeated three times, one worker and no retries). Independent diagnostic proof passed 20 forced cold reloads with real error/blocked sidebar assertions and the original lazy shell. Web and complete desktop builds passed after removal of the speculative shell-loading change. Final affected verification and replacement pushed-head reviews remain pending.

Fresh final full client verification passed 1,453 files and 18,577 tests. The broader affected gate’s build/typecheck/lint stage passed all 65 tasks; the remaining server tests and final pushed-head review are still in progress.

The broader affected test run completed with 28,274 server tests passing, 83 skipped, and two failures in the unchanged credits binary test’s temporary-folder teardown. The same credential-free Turbo command reproduced both `ENOTEMPTY` errors: the helper aborted its SDK child without awaiting closure. The test now observes `close` at spawn and awaits it before deleting files. Both direct and matching Turbo verification passed all three cases after the fix; original security assertions are unchanged. This local full run is not reported as passing. Final pushed-head CI remains required.

### Codex native review convergence

Independent Stage 2 review of `79e1544` reproduced three blockers: settings-only draft metadata incorrectly proved Codex ownership, imported native settings hid native directory/account identity, and missing native history fell back to a partial DorkOS event log. Ownership now requires a verified native source or actual thread binding; native identity survives settings overlays and durable rename; known/imported history unavailability propagates as an error. Explicit task/relay launch scopes remain listable. Four new regressions pass, including chosen-runtime first send and rename after restart. The ownership regression failed against the previous implementation. Six focused suites passed 405 tests with 13 skipped; server typecheck, scoped lint, server build and desktop server packaging passed. Renewed independent review and exact-head CI remain required before merge.

### DEV surface lifecycle correction

The second queue attempt passed the full four-shard test gate and five browser shards, but failed four DEV Playground cases: three Live now groups and one seeded attention row disappeared. The early entity listener installed for normal app boot also consumed the playground’s global connection and cleared its fixture statuses. Main now shares its exact DEV surface decision between Root and listener installation; normal app listeners still install synchronously before any provider connects. No showcase assertion or route splitting was changed. The original symptoms reproduced locally, then all nine affected/neighboring showcase browser cases passed. Two normal-app fleet reload cases and all five routing cases passed; neighboring units passed 45 tests. Client typecheck, scoped lint, formatting, web build and full desktop renderer/server build passed. Owned test servers were stopped. Replacement-head reviews and queue checks remain delivery gates.

### Community browser teardown correction

The unrelated Community PostgreSQL delivery job twice failed after the email-link browser assertions completed: the sole `DROP DATABASE ... FORCE` fixture terminated a still-closing PostgreSQL client. Better Auth reuses the supplied pool; it creates no additional pool. Installed `pg-pool` resolves `pool.end()` after removing clients from its count, before their socket-close callbacks finish. A browser-only pool owner now observes each client’s `end` from connection time and awaits those promises after ending the pool, before the fixture force-drops its database. Earlier idle client closure remains safe. Only the email-link fixture uses the helper; normal-drop fixtures and production code remain unchanged.

The actual local PostgreSQL regression failed without the close barrier (client had not ended), then passed both client-close and previously-closed-client cases after restoration. Evidence: `/tmp/routes-community-close-red.log` and `/tmp/routes-community-close-green-final.log`. The official Community `test:browser` command built the app and passed all 64 browser tests across 19 files, plus its browser inventory and tenancy receipt gates, against an isolated local PostgreSQL admin database (`/tmp/routes-community-close-browser.log`). Community typecheck, scoped lint (zero errors; two fixture environment-access warnings) and formatting passed. The temporary admin database was dropped after confirming no sessions remained; browser HTTP servers stopped, and the pre-existing local PostgreSQL service was left unchanged. No external service or paid inference was used. Exact-head delivery checks remain required.

### Required merge-conflict integration

The queue removed reviewed, fully green head `908a64232d` because preceding PR 2683 merged DOE onto main; no combined-tree run occurred. The curated routing commit was rebased from `993235b4d675948a93d08bf51e68a858257f6751` onto immutable main `d60ff0c6fbb0e8dda676c5abfd0021e23e5f5f52`, producing `12f39127d96fd37c9eaebe638f1cfb06ee7b0d03`. Actual conflicts were limited to concurrent first-entry additions in `decisions/manifest.json` and `specs/manifest.json`. Both DOE and routing records are retained; ADR 0156 remains superseded. All 65 remaining DOE changed files match main byte for byte, including its package, tests, configuration and root test registration. The automatic sidebar test merge retains both DOE’s configuration-response barrier and the routing partial router mock. Frozen lockfile installation passed.

Focused integration verification passed 127 neighboring tests across the sidebar, generated routes, route lint, shared company schema and eval orchestration; all 174 DOE tests passed. Fresh DOE typecheck/lint and client typecheck passed; scoped sidebar lint had zero errors (one existing warning), merged-file formatting passed, and all 52 script manifest fixtures passed. Evidence is preserved in `/tmp/routes-rebase-semantic-merge.log`, `/tmp/routes-rebase-neighbor-tests.log`, `/tmp/routes-rebase-doe-gates-final.log`, `/tmp/routes-rebase-doe-types-lint-fresh.log`, `/tmp/routes-rebase-client-types.log`, `/tmp/routes-rebase-sidebar-lint.log`, `/tmp/routes-rebase-format.log` and `/tmp/routes-rebase-manifest-tests.log`. No paid inference flags, primary-checkout edits or pushes were used. Exact-head reviews and CI must be renewed before the queue is re-entered.
