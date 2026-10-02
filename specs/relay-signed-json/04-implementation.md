# Relay signed JSON implementation

**Status:** Source implemented; real red/green and mutation proof complete. Final local verification recorded below; independent implementation review and parent delivery remain pending.
**Issue:** DOR-2661
**Workspace:** `/Users/doriancollier/.codex/worktrees/relay-signed-json/dorkos`
**Branch:** `codex/relay-signed-json`
**Preparation base checked:** `27aa09a0b597c6e5429cb2ca39bdccab064e22b3`
**Worker:** `/root/serve_isolation_implementation`; explicit human choice GPT-6.1 Sol / Medium retained.

The parent authorized artifact preparation only and is installing dependencies concurrently. This worker is the sole tracked-artifact writer here. No tracker mutation/claim, commit or push is authorized in this phase. At that historical preparation point, product/test implementation awaited a parent follow-up. The coordinator subsequently refined this to namespace implementation/review/PR-head convergence while its healthy queue wait is retained; the execution release below applies.

## Preparation source observations (not runtime evidence)

- `app.ts`: terminal admission, CORS, host guard and Better Auth mounts precede the global 1mb JSON parser; session gate follows it.
- `index.ts`: real Relay router is mounted after createApp; finalizeApp is called after routers.
- `relay-adapters.ts`: receiver's raw parser currently defaults to 100kb; req.body is cast to Buffer before actual inbound processing.
- Unchanged full-app application/json: malformed JSON is rejected by the global JSON parser before sessionGate/receiver; finalizeApp returns 500 INTERNAL_ERROR, adapter not called, nonce not consumed.
- Direct WebhookAdapter or non-JSON raw receiver: nonce/timestamp/replay/HMAC before JSON.parse; verified nonce stored before parse; malformed verified JSON reports 401 Publish failed. The repaired signed JSON path is intended to restore these receiver semantics.
- Existing Relay receiver test substitutes handleInbound, so it does not prove exact bytes survived the global parser.
- Real finalized error handler explicitly maps only entity.too.large to 413; other body-parser failures retain existing 500 semantics.

## Prepared artifacts

02-specification.md defines the bounded middleware order, real red fixture and counted acceptance matrix. 03-tasks.json and 03-tasks.md keep all executable tasks pending. The single owned specs manifest entry is specified, not implemented.

## Pending evidence and decisions

No red regression, green result, package checks or implementation adversarial review has run. Independent preparation review corrected the baseline-versus-repaired malformed-JSON wording; this is source-trace feedback, not runtime proof. Runtime proof must establish actual status/error contracts and exact adapter/publication counts. Use a valid webhook-owned subject after namespace changes land. Distinguish unchanged full-app malformed JSON behavior (500 before receiver, no nonce consumption) from intended repaired signed-path behavior (valid HMAC: adapter 401 Publish failed and verified nonce consumption; invalid HMAC: 401 Invalid signature without nonce consumption). Preserve ordinary JSON 500 semantics and the existing adapter contract, while explicitly recording the signed-path behavior change. Observe empty/non-Buffer request handling before deciding whether a narrow defensive check is necessary. Do not expand to signature encoding/compression redesign.

## Resume

Done: bounded source trace and preparation artifacts.
Next: await parent instruction to implement; then rebase/inspect namespace changes and make the full-app exact-byte regression fail for the intended reason before applying the parser fix.
Open: all runtime proof; independent review; parent tracker claim and delivery.
Next command after authorization: `git status --short`, followed by the targeted full-app regression once written. Dependency collection failures are not red evidence.

## Environment baseline

Parent completed frozen install and12server-dependency build tasks on base27aa09a0b597c6e5429cb2ca39bdccab064e22b3, exit0. Existing connector-event-ingress.test.ts baseline collected7passing tests, exit0; logs at /tmp/dorkos-2661-baseline-build.log and /tmp/dorkos-2661-baseline-ingress.log. These are environment/reference evidence only, not the new Relay parser/HMAC proof. Namespace2660 is the sole active supporting source scope; signedJSON remains unclaimed and source-pending until namespace delivery.

## Independent preparatory review convergence

2026-10-01: `/root/isolation_head_adversarial`, GPT-6.1 Sol / Medium, independently reviewed the specification against actual application/parser/receiver composition. The originating author corrected a factual baseline distinction: unchanged malformed application/json returns finalized500 before receiver/no nonce; intended repaired signed path restores receiver HMAC-before-parse401 semantics. Final design review reports no blocking findings. Compression retains current raw inflation semantics; empty/non-Buffer handling remains an explicit runtime observation. This approves preparation only, never source behavior or a pushed head. Four canonical tasks remain pending.

Coordinator permits the next independent supporting source issue after namespace implementation/review/PR-head convergence while a healthy queue wait is retained. This refines the earlier merge-only preparation boundary; root must explicitly release source and record the actual main base/Flow claim first.

## Pinned runtime readiness

Parent verified the prepared checkout’s native SQLite package resolves inside this worktree and its binary has one filesystem link, then rebuilt only that owned package under repository/CI Node24.14.1. Rebuild exit0 and a real in-memory SQLite query returned `{ ok: 1 }` under24.14.1; log `/tmp/dor2661-node24-native-readiness.log`. This is environment readiness only: no signed JSON regression, source claim or implementation proof. Namespace2660 remains the sole active supporting source issue. Root must pin actual main, integrate prepared artifacts safely and explicitly claim/release source after namespace implementation/review/PR-head convergence.

## Execution release

Parent verified namespace implementation/local gates and exact pushed-head independent approval before PR2459. Namespace merge/FlowDONE remains pending and its routing gate stays closed. Under explicit coordinator capacity refinement, DOR-2661 Flow claim succeeded at2026-10-02T00:29:11Z, runtimecodex/session01a0f907-1a92-7852-9e96-e145e05ced79, originating workerGPT-6.1Sol/Medium. Execution integration base is verifiedmain `e3210be2cb14c823696a213f4df0ab21fa8acdd8`. Parent parked all5owned preparatory artifacts withSHA256 validation, cleanly rebased from27aa09a0b, restored all4spec bytes and surgically inserted onlyits8-line manifest node. Incoming Doc/isolation schema/source/manifests remain byte-preserved. Node24 frozen install and12server-dependency builds exit0, realSQLite query succeeds. Logs `/tmp/dor2661-e321-node24-install.log` and `/tmp/dor2661-e321-node24-build.log`; parking receipt `/tmp/dor2661-integration-park/snapshot.json`. No new signedJSON runtime proof yet. Root finishes this tracked metadata before handing the sole writer checkout to the originating worker; parent will not mutate its source during worker execution.

## Execution evidence on e3210be2

The first executable regression composed actual createApp, createRelayRouter and finalizeApp, a real AdapterRegistry-started WebhookAdapter, and Node HMAC over literal whitespace/Unicode UTF-8 JSON. Only the downstream publisher and manager lookup facade are synthetic. The call-through inbound spy never replaces verification. Config/auth database, ephemeral HTTP listener and adapter timer are isolated and cleaned up.

- Authoritative RED `/tmp/dor2661-exact-red.log`: 4 tests collected, 2 failed and 2 passed, exit 1 before product edits. Valid signed application/json returned 401 because the adapter received a parsed object; missing Content-Type returned 500 because an absent body was cast to Buffer. The baseline malformed JSON control returned 500 INTERNAL_ERROR with zero inbound/publication calls; the same nonce then succeeded on the non-JSON raw receiver, proving it was not consumed. An earlier discarded fixture attempt incorrectly used superagent `.send(Buffer)` with JSON Content-Type, which serializes a Buffer wrapper; it is not red evidence. The permanent fixture sends literal UTF-8 strings and signs those exact original bytes.
- GREEN `/tmp/dor2661-controls-green.log`: all 19 full-app/standalone cases pass. Exact bytes publish once; wrong-secret/modified-payload/modified-whitespace refuse without nonce consumption; replay publishes once; malformed verified JSON consumes its verified nonce and returns receiver 401 Publish failed; malformed invalid HMAC returns 401 Invalid signature and a subsequent valid request with that nonce succeeds.
- Both full-app and standalone receiver accept a signed 200kb payload and refuse >1mb with 413 REQUEST_TOO_LARGE, zero inbound/publication attempts, and a successful valid counterpart using the same nonce.
- Ordinary JSON stays parsed, malformed JSON remains 500 INTERNAL_ERROR, oversized JSON remains 413, neighboring paths and non-POST behavior stay parsed. Real isolated Better Auth login-on refuses no credentials with 401 AUTH_REQUIRED and accepts a synthetic local signed-in session. Host refusal stays 403 HOST_NOT_ALLOWED, CORS refusal follows existing 500 INTERNAL_ERROR, and closed admission returns 503 SERVER_STOPPING; each has exact zero inbound/publication counts and an accepted counterpart.
- The observed missing/absent Content-Type path now returns 400 before inbound; typed empty body remains a Buffer and follows real receiver verification/parsing.

Only product changes: parser-only exact POST capture after admission/CORS/Host/BetterAuth and before global JSON; explicit 1mb receiver raw ceiling; evidenced non-Buffer guard. Authorization/handler order, signature semantics and ordinary parser-error handling are unchanged. The existing mocked route fixture now mirrors raw-before-JSON ordering. The main admission mount census includes the new parser mount (66 paths).

## Mutation sensitivity and exact restoration

Each mutation ran the real 19-case regression and was byte-restored in a finally block. Removing app byte capture: 14 failed/5 passed (`/tmp/dor2661-mutation-app-parser.log`). Removing explicit receiver limit: standalone >100kb case failed, 1 failed/18 passed (`/tmp/dor2661-mutation-receiver-limit.log`). Removing Buffer guard: both untyped/absent body controls failed, 2 failed/17 passed (`/tmp/dor2661-mutation-buffer-guard.log`). No mutation remains.

## Local verification and handoff

All commands use Node24.14.1 via task-specific PATH; no paid inference.

- `pnpm vitest run apps/server/src/__tests__/relay-signed-json.test.ts apps/server/src/routes/__tests__/relay.test.ts packages/relay/src/adapters/webhook/__tests__/webhook-adapter.test.ts apps/server/src/__tests__/connector-event-ingress.test.ts`: 4 files, 209 tests pass, exit0 (`/tmp/dor2661-final-green-final.log`). The sibling route-only fixture initially had 2 failures caused by its old global JSON-first order; corrected fixture rerun passes.
- `pnpm --filter @dorkos/server typecheck`: exit0 (`/tmp/dor2661-typecheck-final.log`). Initial fixture-only typing errors corrected (call-through spy type and required unused outbound config).
- `pnpm --filter @dorkos/server lint`: exit0, 0 errors/113 pre-existing warnings (`/tmp/dor2661-lint-final.log`).
- `pnpm vitest run apps/server/src/__tests__/app-terminal-admission.test.ts apps/server/src/middleware/__tests__/host-guard.test.ts apps/server/src/services/core/auth/__tests__/session-gate.test.ts`: 3 files, 65 tests pass, exit0 (`/tmp/dor2661-gate-siblings-final.log`). Initial admission mount census65 was outdated by the new exact POST parser mount; explicit new-path assertion and census66 correct this.
- `git diff --check`: exit0.

Independent implementation review, affected parent gates, pushed-head review, PR/merge and FlowDONE remain parent-owned and pending. Source is stable after the local sibling rerun; no writer-owned listeners, timers or test processes are retained. Historical preparation and release notes above describe their original phase and do not supersede this execution record.

## Parent review and fresh verification checkpoint

Independent stable-source REVIEW.md preflight by /root/isolation_head_adversarial, GPT-6.1 Sol / Medium, approves0Important/0ShouldFix/0Nits with a fresh independent4files209tests exit0. Source/RED/mutation evidence independently inspected; no reviewer edits. Root fresh7files274tests exit0 (/tmp/dor2661-parent-focused.log), API export and site API generation exit0 with no generateddiff (/tmp/dor2661-parent-api.log, /tmp/dor2661-parent-siteapi.log). All5source/test paths match the stable handoff SHA256 snapshot (/tmp/dor2661-stable-source-snapshot.json). PinnedNode24 affected pnpmverify is running (/tmp/dor2661-parent-verify.log), not claimed complete. Exact committed/pushed-head review and scoped PR/normalqueue/verifiedmerge+FlowDONE remain pending.

## Completed parent affected verification

PinnedNode24 parent pnpmverify session18242 completed exit0:40quality/build tasks (31cached) and19test/build tasks (14cached). Test/build phase13m32.146s. Complete log /tmp/dor2661-parent-verify.log retained in ignored evidence/stable-e3210be2/parent-verify.log. All5source/test hashes still match the independent stable-source handoff; no source changed during gates. Parent7files274tests and both generators also pass with unchanged generatedoutput. Exact committed/pushed-head review, PR and normalqueue/verifiedmerge+FlowDONE remain pending.

## Actual namespace merge integration

PR2461 original head `f9c3d57805f537ecf2af36cdc91159c2e5ba0164` passed independent exact-head and automated review with zero findings, then became conflicting after namespace PR2459 actually merged as `6b7309b9fc13d8580c890f707b839d5527277f0b`. The normal rebase onto that merge retained the original production and real-app regression bytes. The shared Relay test file contains both the incoming namespace cases and the original raw-parser fixture. Four programme/spec metadata conflicts were resolved by preserving incoming namespace data and adding the original raw JSON manifest record; removing that own record reproduces incoming manifest bytes exactly. Two isolation evidence files already matched main and naturally drop out of this commit.

Fresh parent verification on the combined source passes eight focused files/263 tests and three namespace control files/72 tests. Independent GPT-6.1 Sol / Medium integration preflight passes 19 real-app cases and reports zero important/should-fix findings; one stale current-checkpoint prose nit was corrected and independently rechecked with zero remaining nits. API export initially failed on stale shared build output; the Node24 shared rebuild and API/site generator reruns succeed without tracked output changes. Fresh pinned Node24 affected verification completed exit0: 40 quality/build tasks (30 cached, 33.818s) and 19 test/build tasks (9 cached, 9m47.081s). The combined server suite passed 23,977 tests with 55 skips across 1,360 passing files and three skipped files; CLI 1,833 with two skips, desktop 815 and credential-free evals 572 with one skip passed. All five integrated source/test hashes remained stable. Earlier 274-test and 40/19-task full-gate proof remains attributed to the original head. New-head push, independent exact-pushed-head review, normal queue, verified merge and Flow DONE remain pending.
