# Relay namespace ownership implementation record

**Work item:** DOR-2660
**Status:** Source implementation and fresh local verification complete; tasks 1.1–1.4 completed. Exact-pushed-head quality review, PR, verified merge and Flow DONE pending
**Date:** 2026-10-01
**Workspace:** `/Users/doriancollier/.codex/worktrees/relay-namespace-ownership/dorkos`
**Branch:** `codex/relay-namespace-ownership`
**Source base:** `d19d3ee73534dc9b69474bedffe9840db74ed931`
**Workers:** Originating worker `/root/signed_json_regression_plan`, GPT-6.1 Sol / Medium by explicit human instruction. Sole tracked writer for namespace source and its evidence artifacts until handback.

## Session 1: Historical preparatory specification and decomposition

Created the bounded specification, canonical dependency-ordered tasks, readable task projection and one manifest entry. No source files, claim, tracker, commit or push changed. No new runtime tests executed. No ADR required for this straightforward bounded bug fix.

At this historical preparation point, implementation waited for parent confirmation that DOR-2663 actually merged, the parent Flow claim, and explicit source-work resumption. Doc owns acceptance source/schema and later internal typed receipt/session binding.

## Baseline evidence, separate from new proof

Parent-reported existing baseline: 250 tests and 12 server-dependency builds. These are environment readiness/context only. This worker did not execute those commands or receive their exact output, file list or timestamps. Link the parent's baseline record before a stronger claim. None is credited as new DOR-2660 regression, compatibility or mutation proof.

## New proof

Worker red/green, mutation, and filtered quality evidence appears below. The latest restored focused run including identical-active-instance correction passed 13 files / 797 tests under pinned Node 24.14.1, including credential/header compatibility fixtures. Parent fresh affected verification and independent re-review remain pending; no final approval or issue completion is claimed.

## Next command

Parent repeats fresh `pnpm verify` on the corrected source, then obtains independent spec/code review. Source/test ownership has been handed back; this worker only maintains the namespace evidence artifacts until that documentation handoff.

## Historical preparatory review correction

Independent reviewer identified a pre-persist cross-type ownership gap in the initial design. Section 2, acceptance 6 and both task 1.3 projections now require the manager to acquire the registry’s operation-bound active/pending ownership reservation before mutation, including broad plugin claims, and retain it through asynchronous persistence/start. Conflict preserves exact file bytes, stored config and the old running instance. At that preparation point, deferred race regressions remained pending and no source work had started. Their later proof is recorded below.

## Source execution release

2026-10-01: Coordinator released source execution after DOR-2663 PR2457 merged, Flow DONE/readback was confirmed, and the namespace artifacts were rebased onto verified `d19d3ee73534dc9b69474bedffe9840db74ed931`. The parent completed the manual Flow claim and EXECUTE checkpoint. Frozen install and 12 server-dependency builds passed on this base. The namespace worker then implemented the four tasks in dependency order, without DB/private Doc admission changes. Worker: `/root/signed_json_regression_plan`, GPT-6.1 Sol / Medium. At source release, new namespace abuse/regression proof remained pending; subsequent evidence is recorded below.

## Session 2: Authorized execution after isolation merge

Parent verified DOR-2663 merge `d19d3ee73534dc9b69474bedffe9840db74ed931`, completed the manual Flow claim/EXECUTE checkpoint and released source execution to this sole writer. Frozen installation and 12 server-dependency builds were parent-executed readiness checks, separate from proof below. Parent-owned overview/preflight/isolation artifacts remain untouched. No commits, pushes or tracker writes by this worker.

### Task 1.1: shared namespace/public guard proof

Command: `pnpm vitest run packages/shared/src/__tests__/relay-adapter-schemas.test.ts packages/relay/src/__tests__/relay-publish-server-destinations.test.ts apps/server/src/routes/__tests__/relay.test.ts apps/server/src/services/core/__tests__/mcp-relay-tools.test.ts apps/server/src/services/relay/__tests__/initiate-consent.test.ts`. First red: 5 failed files, 33 failed / 412 passed tests (445 total); abuse failures concern permissive webhook ownership and public Doc guards. Green after shared policy/guards: 5 passed files, 446 passed tests, process exit 0. Logs: `/tmp/dor2660-task11-red.log`, `/tmp/dor2660-task11-green.log`. The shell displaying the initial red log ended with tail, so its exit was 0 despite Vitest’s recorded failures; the green command explicitly propagates the test exit.

### Task 1.2: live registry ownership proof

Red command: `pnpm vitest run packages/relay/src/__tests__/adapter-registry-ownership.test.ts`: 9 failed / 4 passed tests (13), exit 1. Intended failures expose lexical sibling routing, duplicate/webhook ancestor ownership, pending-start and same-ID replacement races. Green command: `pnpm vitest run packages/relay/src/__tests__/adapter-registry-ownership.test.ts packages/relay/src/__tests__/adapter-registry.test.ts apps/server/src/services/relay/__tests__/runtime-neutral-dispatch.test.ts`: 3 passed files, 41 passed tests, exit 0. Logs: `/tmp/dor2660-task12-red.log`, `/tmp/dor2660-task12-green.log`. Registry reserves before awaiting start and rejects a concurrent same-ID registration; failed replacement preserves the old owner.

Task 1.3 tests are being written/run before its production changes. Filtered lint/typecheck and broader affected checks remain pending; these focused results do not claim final delivery.

### Task 1.3: persisted configuration and manager mutation boundary

Red command: `pnpm vitest run apps/server/src/services/relay/__tests__/adapter-config.test.ts apps/server/src/services/relay/__tests__/adapter-manager-ownership.test.ts packages/relay/src/adapters/webhook/__tests__/webhook-adapter.test.ts`: 3 failed files, 23 failed / 91 passed tests (114), exit 1. Failures demonstrate real non-webhook runtime ownership, persisted config-union bypass, and manager persistence before live/pending cross-type conflict refusal. Green on those files after implementation: 3 passed files, 114 passed tests, exit 0. Logs: `/tmp/dor2660-task13-red.log`, `/tmp/dor2660-task13-green.log`. Additional deferred replacement-save and abandoned-registration tests passed in the combined final run.

Adjacent command added the existing adapter-manager and registry suites to these files: initial adjacent result 5 failed / 284 passed (289), because four tests expected the previous narrower error text and one expected an incomplete saved webhook to load as valid. Corrected those assertions, updated the unrelated manager registry stub for the reservation seam, and retained real manager/registry/fs tests for ownership. Adjacent green: 6 passed files, 291 passed tests, exit 0, `/tmp/dor2660-adjacent-green.log`.

### Task 1.4: worker verification and handback

Fresh unmutated baseline and restored final command:

```bash
pnpm vitest run packages/shared/src/__tests__/relay-adapter-schemas.test.ts packages/relay/src/__tests__/relay-publish-server-destinations.test.ts apps/server/src/routes/__tests__/relay.test.ts apps/server/src/services/core/__tests__/mcp-relay-tools.test.ts apps/server/src/services/relay/__tests__/initiate-consent.test.ts packages/relay/src/__tests__/adapter-registry-ownership.test.ts packages/relay/src/__tests__/adapter-registry.test.ts apps/server/src/services/relay/__tests__/runtime-neutral-dispatch.test.ts apps/server/src/services/relay/__tests__/adapter-config.test.ts apps/server/src/services/relay/__tests__/adapter-manager-ownership.test.ts packages/relay/src/adapters/webhook/__tests__/webhook-adapter.test.ts apps/server/src/services/relay/__tests__/adapter-manager.test.ts
```

Both runs collected 12 files / 744 tests and passed with exit 0. Logs: `/tmp/dor2660-final-focused.log` and `/tmp/dor2660-restored-green.log`. Tests use no live models, network webhook delivery or operator credentials. Unrelated trace/credential/logger/chokidar seams are stubbed; the dedicated ownership suite drives real manager, registry, webhook, file loader and filesystem persistence.

Mutation controls used `pnpm vitest run <file> -t <filter>`, one mutation at a time, restoring exact saved source in a `finally` block:

| Mutation                                   | File / filter                                                                                          | Intended failure evidence               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| Bypass positive schema policy              | `packages/shared/src/__tests__/relay-adapter-schemas.test.ts`, `webhook namespace ownership`           | exit 1; 17 failed, 3 passed, 65 skipped |
| Restore raw startsWith routing             | `packages/relay/src/__tests__/adapter-registry-ownership.test.ts`, `lexical siblings`                  | exit 1; 2 failed, 12 skipped            |
| Omit pending claims from ownership check   | same file, `reserves pending ownership`                                                                | exit 1; 1 failed, 13 skipped            |
| Omit manager add's pre-persist reservation | `apps/server/src/services/relay/__tests__/adapter-manager-ownership.test.ts`, `cross-type broad claim` | exit 1; 2 failed, 5 skipped             |
| Bypass real webhook runtime policy         | `packages/relay/src/adapters/webhook/__tests__/webhook-adapter.test.ts`, `a persisted config`          | exit 1; 21 failed, 64 skipped           |

Logs are `/tmp/dor2660-mutant-{webhook-policy,boundary,pending-reservation,pre-persist,runtime-policy}.log`. The restored 744-test run confirms mutations did not remain in source.

Final package checks: `pnpm --filter @dorkos/shared --filter @dorkos/relay --filter @dorkos/server typecheck` exited 0 for all three packages (`/tmp/dor2660-typecheck-final.log`). The matching filtered `lint` command exited 0 with no errors; existing package warnings remain, including 113 server warnings (`/tmp/dor2660-lint-final.log`). Formatting and `git diff --check` were also checked. Engine warnings report local Node 22.22.2 versus two packages' 22.22.3 requirement; these commands still completed successfully.

Source changes stay within the namespace seams and tests. Added `changelog/unreleased/261001-221845-relay-namespace-ownership.md`. Public Doc guards add neither a consent exemption nor a trusted destination sender. No parser, DB, private Doc admission/receipt, operator login, commit, push, PR or tracker changes. Parent-owned overview/preflight/isolation artifacts remain untouched by this worker.

Handback: parent owns affected/full verification, API generation if needed, integration checks, independent spec/code review and external delivery. Task 1.4 remains in progress until those parent-owned checks settle; current evidence establishes worker scoped verification only. That initial handback preceded the accepted Stage 1 findings documented below.

### Accepted Stage 1 corrections and fresh proof

The independent reviewer demonstrated two required corrections: an enabled webhook edit during initial credential resolution could successfully persist but never connect; short wildcard destinations `relay.*`, `*.doc`, and `*.*` could reach the reserved bare `relay.doc` root. Tasks 1.1 and 1.3 were reopened while correcting them.

Added an actual Manager/Registry/WebhookAdapter regression that pauses the first credential-provider resolve during initialize, saves an enabled address edit, releases the first build, and asserts the saved new address, connected real instance, new routing and absent old routing. The queued update now applies enabled settings even when no old registry owner exists; the existing unregister no-op and failed-stop safeguards remain intact. Disabled entries still return without starting. Pre-persist reservations and same-ID fences are unchanged.

Added shared reachability cases and HTTP send/reply, MCP send/query/dispatch, and real RelayCore publish-to-registered-bare-Doc-mailbox regressions for all three short patterns. The shared predicate accepts a matched bare root only for the Doc prefix; existing exact system/control root semantics and trusted sender/consent lists remain unchanged. Added real HMAC positive controls for `relay.webhook.GitHub.alerts_1`, `relay.webhook.x`, and `relay.webhook.x2`: each starts and publishes the correctly signed inbound payload.

Red command:

```bash
pnpm vitest run apps/server/src/services/relay/__tests__/adapter-manager-ownership.test.ts packages/relay/src/__tests__/relay-publish-server-destinations.test.ts apps/server/src/routes/__tests__/relay.test.ts apps/server/src/services/core/__tests__/mcp-relay-tools.test.ts
```

Result before production correction: 4 failed files, 20 failed / 327 passed (347), exit 1; `/tmp/dor2660-review-red.log`. The manager regression failed on the missing real WebhookAdapter. The same command plus `packages/relay/src/adapters/webhook/__tests__/webhook-adapter.test.ts` passed 5 files / 435 tests, exit 0; `/tmp/dor2660-review-green.log`.

Mutation sensitivity, exact source restored in `finally`:

- Restore the absent-owner early return: manager ownership file filtered by `initial credential resolution`, exit 1, 1 failed / 7 skipped (8); `/tmp/dor2660-review-mutant-startup.log`.
- Restore the descendant-only wildcard predicate: Relay destination file filtered by `bare Doc mailbox`, exit 1, 3 failed / 68 skipped (71); `/tmp/dor2660-review-mutant-doc-root.log`.

After restoration, the full 12-file command above passed **767 tests**, exit 0; `/tmp/dor2660-review-restored.log`. This supersedes the prior worker 744-test proof for current source. No source/test writes remain after the explicit source handoff to the parent.

Parent reports its earlier independent exact 744-test run, shared build, API generation and site generation passed before these corrections. Its superseded `pnpm verify` was deliberately interrupted (exit 143) before source resumption and is **not completion proof**. Fresh parent verification and independent re-review are required on corrected source.

Corrected filtered quality commands:

```bash
pnpm --filter @dorkos/shared --filter @dorkos/relay --filter @dorkos/server typecheck
pnpm --filter @dorkos/shared --filter @dorkos/relay --filter @dorkos/server lint
```

Both exited 0 after the review corrections. Logs: `/tmp/dor2660-review-typecheck.log`, `/tmp/dor2660-review-lint.log`. Lint reported no errors and the existing 113 server warnings. Formatting and `git diff --check` passed. Tasks 1.1 and 1.3 returned to completed only after this fresh scoped proof; task 1.4 remains in progress for parent fresh verification and independent re-review. Parent has resumed those checks on stable source. No source/test mutations will be made after handoff.

### Final Stage 1 teardown race and outbound compatibility proof

The independent reviewers demonstrated a same-ID teardown race: unregister captured the old instance and awaited stop; a hot replacement installed a new instance during that await; stale unregister then deleted the new owner. Tasks 1.2 and 1.3 were reopened for this correction and the missing outbound half of the positive controls.

The actual registry regression defers old stop, waits for the fresh owner to be installed, releases teardown and asserts fresh identity/routing survive, the old route is absent, old stop runs once and fresh stop never runs. A second test proves failed unregister leaves its old instance registered and allows a successful stop retry. Production change fences deletion by captured instance identity and shares only that same instance's in-flight teardown between existing unregister and replacement cleanup. The WeakMap entry is removed after success or failure, keeping failures retryable. Other reservation and startup semantics are unchanged.

The nested `relay.webhook.GitHub.alerts_1` and sibling `relay.webhook.x`/`relay.webhook.x2` positive controls now also call real outbound deliver. They assert successful result, POST URL, exact serialized payload body, and independently compute HMAC-SHA256 over the emitted timestamp plus body with the correct secret. Only network fetch is stubbed; inbound/outbound signing and webhook lifecycle remain real.

Parent full verification found two adjacent credential/header test failures that used obsolete `inbound.subject: 's'` positive fixtures. Replaced six such subject fixtures in `adapter-secrets.test.ts` with valid `relay.webhook.wh-1`, preserving each header/credential/mutation assertion and adding that file to scoped verification. No credential implementation changed. Parent classified the separate search/jsonl frontier failure as Node 22 versus repo-pinned Node 24 readline semantics; this worker did not edit search or repair native dependencies.

Red command before lifecycle correction:

```bash
pnpm vitest run packages/relay/src/__tests__/adapter-registry-ownership.test.ts packages/relay/src/adapters/webhook/__tests__/webhook-adapter.test.ts
```

Result: 1 failed / 1 passed file, 1 failed / 103 passed tests (104), exit 1; `/tmp/dor2660-final-review-red.log`. The failure showed the fresh registry owner was undefined after old unregister completed. Adding existing registry and credential/header suites after correction passed 4 files / 156 tests, exit 0; `/tmp/dor2660-final-review-green.log`.

Mutation checks, each exact source restored in `finally`:

- Remove unregister's identity guard: registry ownership file filtered by `old unregister`, exit 1, 1 failed / 15 skipped (16); `/tmp/dor2660-final-mutant-unregister-delete.log`.
- Remove in-flight stop reuse: same filter, exit 1, 1 failed / 15 skipped (16), specifically duplicate old-stop count; `/tmp/dor2660-final-mutant-stop-sharing.log`.
- Sign outbound with the wrong secret: real webhook file filtered by `valid address`, exit 1, 3 failed / 85 skipped (88); `/tmp/dor2660-final-mutant-outbound-hmac.log`.

After restoring source, the full scoped command is the earlier 12-file list plus `apps/server/src/services/relay/__tests__/adapter-secrets.test.ts`. It passed **13 files / 796 tests**, exit 0; `/tmp/dor2660-final-restored.log`. This is the current worker scoped proof and supersedes the 744/767 runs for current source. Parent's intervening full verification exited 1 before this final correction and environment alignment; it is not final completion proof. Parent will align the runtime/native dependencies and repeat required integration gates.

Final corrected filtered shared/relay/server `typecheck` and `lint` commands both exited 0; `/tmp/dor2660-final-typecheck.log`, `/tmp/dor2660-final-lint.log`. Lint retains the existing 113 server warnings and has no errors. All worker test/check processes have settled. Formatting and `git diff --check` passed. Tasks 1.2 and 1.3 return to completed with this proof; task 1.4 still awaits parent environment alignment, fresh required gates and independent re-review. All source/tests and namespace task/evidence artifacts are handed back; no further worker writes are planned.

## Parent integration and pinned runtime verification

2026-10-01: final bounded Stage1 correction review by `/root/namespace_corrections_check`, GPT-6.1 Sol / Medium, found no remaining blocker. Its independent actual-source deferred probe retained the replacement with exactly one old stop; nested/sibling controls now include independently recomputed outbound HMAC. Earlier complete Stage1 review by `/root/isolation_head_adversarial` covered the shared/public/config/routing contract; this is spec compliance, not pushed-head quality approval.

Parent broad pre-final Node22 run exited1:59 quality/build tasks passed; client17597/site1537 tests passed; server23935 passed,3 failed,55 skipped. Two obsolete header fixtures were corrected by the worker; the third unchanged search assertion reflects Node22 versus pinned Node24 readline Unicode behavior. Original failure logs retained. `.nvmrc` and CI pin24; installed24.14.1 native source confirms the expected separators. Direct switching initially exposed local SQLite ABI127/137 mismatch. Parent verified native package realpaths remain inside this worktree and every native file has one link, then rebuilt only its owned better-sqlite3 under24.14.1. A real in-memory query now succeeds. No search source/test or gate changed.

Parent parked all owned tracked/untracked bytes outside the checkout with SHA256 validation, verified zero file overlap with Doc foundation, and mechanically rebased the clean branch onto verified main `e3210be2cb14c823696a213f4df0ab21fa8acdd8`. All owned bytes restored exactly; incoming Doc files preserved and manifest diff remains only its own eight-line node. Source implementation began on d19d3ee; e3210be2 is current integration base. Twelve server-dependency build tasks passed under24.14.1.

Fresh parent final focused command is the13-file worker command plus unchanged `apps/server/src/services/search/__tests__/jsonl-frontier.test.ts`, with PATH selecting pinned Node24.14.1. Result:14 files,819 tests passed, exit0 (`/tmp/dor2660-parent-node24-focused.log`). Fresh OpenAPI export and site API generation exited0 with no generated diff. Final Node24 `pnpm verify` is running; task1.4 remains pending its result. Commit/push, separate exact-pushed-head quality review, PR, merge and Flow DONE remain pending.

### Quality preflight P2: identical active-instance registration

Independent quality preflight found that passing the same real WebhookAdapter to register twice started and then stopped that active winner. The real regression asserts registry identity, connected state, one start/no stop, and successful correctly HMAC-signed inbound traffic publishing the expected payload. It failed against the prior source with disconnected state: `pnpm vitest run packages/relay/src/adapters/webhook/__tests__/webhook-adapter.test.ts -t 'active instance is registered twice'`, exit 1, 1 failed / 88 skipped (89); `/tmp/dor2660-identical-red.log`.

The narrow correction makes identical-active-object registration a no-op inside the reserved registration path, after ownership checks and before startup. Failed-candidate cleanup also explicitly excludes `existing === adapter`. Different-instance replacements, pending reservations and in-flight teardown behavior remain unchanged. Shared schema comment wording was mechanically changed from the retired category term to “the app” at the parent's request; no behavior changed.

Adjacent actual registry and real webhook suites passed 3 files / 130 tests, exit 0; `/tmp/dor2660-identical-green.log`. Removing only the no-op makes the same real regression fail again, exit 1, 1 failed / 88 skipped (89); `/tmp/dor2660-identical-mutant.log`. Exact source was restored in `finally`. Fresh restored full scoped command passed **13 files / 797 tests**, exit 0; `/tmp/dor2660-identical-restored.log`.

Every command in this P2 session selects pinned Node 24.14.1 using `/Users/doriancollier/.nvm/versions/node/v24.14.1/bin` at the front of PATH. Parent intentionally stopped its superseded full Node24 verify tree to release source ownership; session75757 exited143, log `/tmp/dor2660-parent-node24-verify.log`. This incomplete run is not completion proof. Parent will repeat integrated verification on handed-back source.

Filtered shared/relay/server typecheck and lint both settled exit0 on Node24; `/tmp/dor2660-identical-typecheck.log`, `/tmp/dor2660-identical-lint.log`. Lint has no errors, existing warnings retained. Task1.2 is completed with current proof; task1.4 remains pending parent final gates/reviews. All source/test/check processes have settled and exact mutation restoration completed. No further worker source writes are planned.

At the parent's final proof-strengthening request, the repeated-instance regression also asserts retained descendant routing and exactly one publish. Fresh Node24 rerun on those final assertion bytes passed **13 files / 797 tests**, exit0; `/tmp/dor2660-identical-final797.log`. Shared comment-only cleanup was followed by 85 passing shared schema tests, exit0; `/tmp/dor2660-identical-comment-green.log`. Parent final verify session6332 began before these last assertion/comment-only edits and was still in script/quality phase when they were applied at its explicit request; source/test bytes were declared stable before its tests phase. Its outcome remains parent-owned and pending. No further source/test mutations occurred after this stable declaration. All worker processes are settled. Namespace source, spec/task/evidence artifact ownership is now handed back in full.

Final parent correction preflight independently confirms connected/retained/routed identity and one signed-inbound publication; the permanent test now asserts those exact results. Parent final focused run on stable source passed14files820tests, exit0, `/tmp/dor2660-parent-node24-final-focused.log`. Final OpenAPI export and site API generation exit0 with no generated changes. All31 changed files pass Prettier check; source snapshot20files remains byte-stable. The final affected run has passed59 quality/build tasks and is running package tests. Exact-pushed-head quality review and all delivery steps remain pending. Completed and superseded logs are preserved under ignored `.dork/flow/evidence/DOR-2660/precommit-e3210be2/`; its status file explicitly marks final gate pending and the interrupted run143/nonproof.

## Final parent local verification

PinnedNode24.14.1 `pnpm verify` session6332 settled exit0. All59 quality/build tasks passed (6cached); all35 test/build tasks passed (2cached). Current integrated source includes verified Doc foundatione3210be2. Counts include Relay2101passed/19skipped (81files), client17597passed (1378files), site1537passed (146files), server23958passed/55skipped (1359passedfiles/3skipped), CLI1833passed/2skipped, desktop815passed, credential-free eval572passed/1skipped. Test/build phase32m49.085s; log `/tmp/dor2660-parent-node24-final-verify.log`. Focused final14files820tests and both API generators pass with no generated output changes. All20 source/test paths match the final stable SHA256 snapshot; no behavior change occurred during final gates. Task1.4 is complete as local verification/evidence preparation. Exact-pushed-head quality review and delivery remain explicit parent-owned follow-ups, not approvals asserted by this local result.

## Automated review nit after PR opening

PR2459 automated review on8e2ce3e0 reported0blocking findings and1nit: failed-start cleanup checked `existing !== adapter`, which is necessarily true after the active-instance early return. Root briefly paused the signedJSON writer (no production edits there, all test processes settled) to preserve one active supporting writer, then removed only that redundant condition. Active-instance no-op, ownership admission, startup, candidate teardown and winner fencing remain unchanged. The full59/35-task gate above covers8e2ce3e0/pre-nit source; fresh targeted checks and a new exact-pushed-head independent delta review are required below before re-arming. No full-gate claim is made for changed bytes based only on the earlier run.

Fresh pinned Node 24 checks after the guard removal passed: three focused registry, ownership and webhook files (130 tests), Relay typecheck and Relay lint, each exit 0. Logs: `/tmp/dor2660-review-nit-focused.log`, `/tmp/dor2660-review-nit-typecheck.log`, `/tmp/dor2660-review-nit-lint.log`. The change is limited to removing the redundant wrapper; the independent review of the newly pushed head remains a separate delivery checkpoint.
