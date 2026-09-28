# Cloud identity adoption — implementation receipt

**Work item:** DOR-2348. **Source baseline:** `5794f638160a68811382347356fd29b31ee2e911`.
**Scope:** the app's identity-bound inference and Cloud-link lifecycle. Independent pushed-branch review converged with no blocking findings; required CI and merge remain pending.

## Implemented behavior

The inference path resolves `/v1/session` immediately before minting and sends only its authenticated service-issued `instanceId`. One captured client holds the credential and normalized origin for both requests. Missing identity, a person session, an absent route or malformed response cannot start a mint. The paid decision remains a module-scope gate before all requests.

Prepared inference state holds a currency check alongside the token. Credential changes, origin changes, local link generations, config-manager replacement and expiry make it unusable for later launches. A single owned config listener observes intermediate A → unlink → A changes; replacement detaches the former listener. Attempt ordering prevents an older mint response from winning a newer selection. Observed refusal clears prior state; a transient refresh failure can retain a still-current, unexpired token. Failure logging records only a bounded status, not response text.

Cloud-link requests capture lifecycle generation, credential and origin. Delayed heartbeat success/refusal, managed authority refusal, device-code and poll responses cannot overwrite a replacement link or restart a stopped timer. Unlink clears local state synchronously, then starts reconciliation and best-effort revoke with the captured retiring credential. Remote revoke completion cannot clear a newer link.

## Verification

The initial eight deferred lifecycle regressions failed against the baseline. After implementation, `cloud-link-lifecycle.test.ts` and existing `cloud-link.test.ts` passed **25 tests in two files**, including same-token replacement and current transient retry. The identity/credits/route selection suites passed 46 tests. Server typecheck, targeted lint and formatting passed. The combined Cloud suite passed **144 tests in ten files**, including Cloud-link client/telemetry, plan, Community moves and route coverage.

Existing recovery evidence was rerun without live services: four site forwarding/proxy/cron suites passed **112 tests**; four managed execution/inbox/Community-outage suites passed **25 tests**; five session dispatcher/history/restart/SSE suites passed **123 tests**. These results are mapped in [the recovery matrix](../../research/20260928-cross-boundary-recovery-evidence.md). Server lint passed. Root lint passed with ten existing warnings and no errors. An additional full script-fixture run stopped at temporary fixture creation with `ENOSPC`; that run is incomplete, not passing. Required CI must finish the environment-blocked verification. ADR drift check and changed-file whitespace check passed.

## Independent review

A separate reviewer fetched and verified pushed head `a632950ce8bc539f2770b8c7dc22e746f9459c8f` against the pinned baseline, inspected all 18 changed files and traced the changed exports, config notification, public session/client contract and runtime launch consumer. Review found **zero blocking findings and one documentation nit**: the unlink route comment still described the old order. That comment was corrected. The reviewer also reran the identity and lifecycle suites: **29 tests passed in two files**.

Disk exhaustion prevented the separate checkout's index from finishing; review used pinned Git objects rather than its partial working files. No forced cleanup was used. There was no live-service, paid-path, deployed-compatibility or full combined-main test claim.

## Compatibility and limits

This consumer requires the configured service to expose `/v1/session` with an authenticated nonempty `instanceId`, plus the inference-token contract. An older service without that identity response leaves credits unavailable; there is no hash fallback. Published schemas and passing local fixtures do not establish deployed availability. No config migration, service-origin switch, paid flag, production enrolment or new public API was added.

The legacy revoke route's authentication mismatch remains documented in [the retirement inventory](../../research/20260928-cloud-retirement-readiness.md). Local withdrawal does not prove remote revocation or cancel already-running turns. A remote revocation not yet observed locally is enforced by the service, not inferred from local state.

DOR-1798's live signed-event acceptance, DOR-2442's full-release/no-rollback gate, DOR-2086's app consumer and affected contract questions, and DOR-2349's remaining recovery cells stay open. This slice does not complete those programmes or the broader caller migration inventory. The parent architecture owner retains the roadmap's dated baseline and will append adoption evidence after merge.
