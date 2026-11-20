---
slug: shared-native-runtime-tools
number: 261116-062114
created: 2026-11-16
status: specified
---

# Give every runtime the shared DorkOS tool outcomes

**Status:** Under Review  
**Author:** Codex, delegated SPECIFY worker  
**Date:** 2026-11-16  
**Issue:** [DOR-4481](https://linear.app/dorkspace/issue/DOR-4481)  
**Pinned source:** `e491a86fa10d1f8b5ce11566a77aad932cb72d9e`  
**Accepted ideation SHA-256:** `5e9cbef5ada640cc81991294dc7a1f1793e4016d749d468b80ed65adff8b9ac9`

## Overview

Move the remaining agent-facing hand-tool domains onto the existing Capability Registry so agents on Claude Code, Codex, OpenCode and Doe receive the same required DorkOS outcomes. Reuse domain handlers, original registry parsing, the existing permission/approval machinery and process-owned runtime principal lifecycle. Supply the minimum missing live turn facts and event channel through that lifecycle. Keep private connection tools and public Owner clients on their existing boundaries.

This is a complete programme contract, delivered in bounded domain slices. Session creation is the first outcome, not completion of the issue. This specification authorizes no implementation until the coordinator advances the workflow and claims execution.

## Background / Problem Statement

Actual linked MCP Clients on the pinned source list 152 ordinary-plus-hand tools on Claude and 113 on each native factory, with all optional service domains admitted and To-dos off. All 39 hand names are missing from each native server. With `DORKOS_TODOS_ENABLED=true`, the registry grows from 128 to 131 capabilities and the lists become 155/116/116/116; the exact three additions are `todo_add`, `todo_update`, `todos_list`. Registry totals include non-ordinary capabilities and are not list totals. The private connection projection enumerates 12 IDs and is excluded from those ordinary counts.

All four real clients successfully called production `list_capabilities`. `session_start {}` reached Claude's schema validation but returned Tool not found on each native. Five explicit credential-free injection/factory tests passed 69 cases. Those observations prove factory reachability only: the runtime-labelled native factory loop does not prove actual injection, authenticated transport lifecycle, a child launch or its UI. Required implementation proofs below cross those missing seams.

The current 39 hand schemas were independently walked: 219 visited nodes, only title/reason/claim trim overwrites on session_start; no observed default, prefault, coercion, pipe, transform, outer preprocess, catch or lazy node. Actual one/two-pass trim parsing and current approval hashing agreed. These dated counts are not a permanent allowlist and are separate from DOR-2067's registry-schema census. Preserve the original executable parse; do not invent a parsed-input bypass.

## Goals

- Every required hand-tool outcome works for each supported caller runtime through the shared registry and owning service.
- Spin-off creation preserves one child/dispatch, own agent, actual target runtime/account, semantic grant, visible level, initial attribution and report-back.
- Caller power comes from the exact current server-owned turn, with current chosen Full/marks, mutable effective mode and existing person authority intact.
- Cards, holds, cancellation and late verdicts reach the real invoking conversation on all runtimes without duplicate execution or a new approval system.
- All current domain outcomes, input/hash semantics and supported service-unavailable behavior are explicitly accounted for.
- Remove each migrated hand registration, duplicate SDK-owned handler ownership and obsolete tier/carve-out references in its slice; update all affected surfaces and proofs.

## Non-Goals

No public MCP/Owner-auth shortcut, third permanent hand projection, new permission state store, authority flag, transcript store, SDK upgrade, billing/authentication flow, native-vendor usage probes, blanket MCP resource parity, new helper mechanism or change to existing loop guards. Do not revive cancelled teammate/origin lowering. No real model, account credential, paid call, live cron execution or outside message is needed by this programme's tests. No one of the 39 outcomes is waived by these exclusions.

## Technical Dependencies

- DOR-2067 reviewed full-schema foundation is implemented on this source; actual delivery remains a typed prerequisite. Consume its strict object projection, metadata and removed-helper contract without reimplementing it.
- Current pins: Claude Agent SDK 0.3.304, MCP SDK 1.32.0 and Zod 4.6.7. Raw defaults already work; full objects preserve strictness/refinements. Runtime SDK imports remain confined to their runtime directories.
- Existing CapabilityRegistry, neutral MCP invocation wrapper, ApprovalService, CapabilityHoldSession, principal service/lease supervisor/thread keys, shared turn-power facts and native injection/config assembly.
- Runtime-owned aggregation (`session/catalog/aggregate-session-list.ts`), session settings/origin/started-by services, task file-first services, Mesh, Relay, extension services and usage store. Missing optional domains must retain explicit admission/unavailable behavior with enabled counterparts.

## Detailed Design

### Architecture and ownership

Declare capabilities in owning service domains: session/launch, core state/accounts, tasks, Mesh/agent creation, Relay/routing/diagnostics and extensions. SDK-specific registration stays under the adapters. Extract domain input, pure policy and orchestration out of Claude-owned MCP files, adapting current injected service dependencies rather than importing the Claude SDK into generic services.

Each capability has a domain-prefixed id, stable existing MCP tool name and its current in-session/external audiences. Plain domain data and typed failure information become MCP envelopes only in transport adapters. Both boot and docs composition gain the same domains; duplicate ids/names and missing admitted deps remain boot errors. No automatic HTTP/CLI/Owner exposure is inferred merely from registration. Migrate public hand registration for the same existing verb into its existing external capability audience; never copy unrelated public tools into the native audience.

The shared invocation path is: verified boundary → current caller resolver → full strict advertised object → original registry parse → invariant/preflight/live permission/hash/approval → owning handler → transport result/card. No caller can request a trusted marker. Keep the three existing tier-gate choke points; do not wrap a registry capability in the old hand gate. Recheck the current binding, cancellation and current permission immediately before a sensitive effect after asynchronous checks or approval waits, through a server-owned `assertCurrent` callback plus the existing domain checks. Authorization is never inferred from the fact a tool was listed.

### Minimum live-turn seam (frozen contract)

Extend **the existing** `ConnectorTurnOwnership` object owned by `ConnectorRuntimePrincipalService.renewalOwners`, not a second map keyed by chat id. Add optional `readToolTurn` for the domain migration transition; all four production adapters supply it before any migrated stateful tool is exposed. The new neutral type lives beside the server-local runtime-principal port, with no SDK imports:

```typescript
interface RuntimeToolTurnFacts {
  effectiveMode: string | undefined;
  chosenMode: string | undefined;
  neverAsks: boolean;
  session: CapabilityHoldSession;
  signal: AbortSignal;
}
// ConnectorTurnOwnership keeps its existing isCurrent predicate.
readToolTurn?: () => RuntimeToolTurnFacts | undefined;
```

`effectiveMode` is the exact mode the current active turn really executes at, including Claude Auto fallback. `chosenMode` is the current person/agent-following choice for that active turn, before mark/ceiling clamping, not a pending next-turn setting. `neverAsks` preserves the existing person-only Never ask distinction that mode semantics alone do not encode. These are live read-through closures, not persisted copies. Undefined mode is unknown and follows existing strict fallback/refusal policy; missing readToolTurn on a native stateful call is a visible `CALLER_CONTEXT_UNAVAILABLE`, never Owner or fabricated stored Full.

Add server-local `resolveToolTurn(principal)` on the principal port. It selects the existing binding entry, reuses current boot/revocation/authority checks, validates canonical runtime/session/home/desk against that principal, checks ownership before and after reading, and returns the facts plus `assertCurrent()`. Resolution must use a currently verified principal from the listener, not a caller-constructed wire object. `assertCurrent` checks exact entry/object identity, isCurrent, abort/revocation and the principal binding; after an awaited authority check it rechecks ownership. It does not mint an alternative grant. Existing resolve/renew paths continue unchanged for connection tools.

The internal method signature is `resolveToolTurn(principal: ServerPrincipalProof): Promise<RuntimeToolCaller>`. RuntimeToolCaller carries readonly canonical runtime, sessionId, branded agentHome and workingDirectory, plus `read(): RuntimeToolTurnFacts` and `assertCurrent(): Promise<void>`. `read` rechecks the exact owner and signal synchronously and invokes readToolTurn fresh; callers must not retain its mode values across an await. `assertCurrent` performs the existing asynchronous durable/live-authority revalidation followed by exact-owner checks; handlers then read fresh and apply their existing current domain policy at the commit/dispatch boundary. Missing, ended, replaced or inconsistent context throws a typed caller-context refusal translated to visible MCP isError before effect. This is server-only delivery of existing authority, not a grant type accepted from JSON.

Do not duplicate shared facts in this structure: marks, canonical aliases, turn serial and existing chosen/unattended records remain in `turn-power`. For a decision sensitive to a live person change, authoritative current adapter mode facts take precedence over a last-turn cache; compute Full through the shared semantic helper from chosenMode and that runtime's declared modes, never a new Full table. Keep existing shared turn-record update points coherent with actual applied mode changes. A patch queued for next turn must not update the active facts early. Read unattended through existing exact-turn/shared policy, with native event adapters preserving attended/unattended transitions.

Adapter mapping: Claude resolves runningPermissionMode and chosenFullAutonomy/turnLevelMode/current choice, including autoModeConfirmedFor and background ceilings; Codex reads prepared active-turn settings, not pending registry patches; OpenCode reads live effectiveApprovalMode with its active ceiling and actual applied choice; Doe reads active turn.mode and the choice used for that turn. `neverAsks` comes from each adapter's existing mode policy; moving a pure helper to neutral ownership is allowed, duplicating policy is not. This mapping must be tested against actual prepared execution options and live control updates.

Use existing `CapabilityHoldSession` exactly (eventQueue and optional eventQueueNotify). Claude retains its current array/notify queue. Native facades use a transient array that eventQueueNotify synchronously drains into the existing active-turn queue: DoeEventQueue.push one event at a time, Codex EventQueue.push with the drained event array. OpenCode currently queues OpenCodeWireEvent, not StreamEvent: extend that same single-consumer TurnEventQueue with an internal tagged host-event variant. Its existing mapped-turn loop yields host StreamEvents directly through the normal projector path; vendor events still pass their existing mapping/approval/media pipeline. Never fake vendor permission events or send an already gated host card through native permission approval again. No second queue consumer, transcript or drain worker is introduced. Queue closure drops later writes and current-owner guards prevent post-terminal card/effect delivery. Cards pushed there must become durable invoking-session events. Combine the MCP call signal and current-turn signal; cancellation, replacement or revocation ends the hold and forbids a later write. ApprovalService itself remains a boot service, not part of per-turn facts.

Open after the active object is installed and caller setup is eligible; publish facts only when execution policy is resolved. Setup failure removes the entry. Keep ownership across existing permitted warm background work, with its real background ceiling and event channel; do not invent a new lifetime. Rekey updates through existing aliases/binding lifecycle; if it cannot preserve exact identity, revoke and reopen rather than relabel a bearer. Renewal retains the same entry/closures and never snapshots permission. Terminal, interrupt, replacement, failed setup and boot reset revoke/remove the closure together with the existing binding. Codex thread keys still authorize nothing between turns and resolve only the current binding.

### Home, cwd, rooms and caller context

Identity and policy read the canonical registered AgentHome from principal.agentPath. The real desk is principal.canonicalCwd; a missing desk for a stateful tool is a refusal, never defaultCwd. Keep existing CapabilityInvocationContext.cwd meaning for already-migrated native capabilities (currently home). Add neutral runtime-tool caller context with explicit `agentHome`, `workingDirectory`, canonical session/runtime and current-turn resolver, accessible only to these owning handlers. Those are caller facts, distinct from declared agent_id/cwd resource selectors accepted by get_agent/get_session_count. Preserve their existing permitted cross-agent read outcomes; a resource target never changes the caller. Do not globally replace cwd for all capabilities.

Resolve task/extension provenance per call: canonical chat, existing aliases, registered home and actual desk; no stale initial SDK id. Session-start input.cwd remains a target, checked by boundary, launchPlaceRefusal and protected-folder invariant. A linked worktree with valid ownership succeeds; another agent's home/private copy or a room folder fails. Room seat and direct-chat origin come from canonical server state, never tool arguments. Existing public sessionless callers keep their chatless level/account policy and have no fabricated live native turn.

### Input, action identity and approval upgrade

For migrated hand tools form a full strict object retaining current field schemas and three idempotent trims. Preserve exact declared values and handler fallbacks: tasks_create's omitted target is still defaulted in the handler **after** approval hashing. Do not lift it or other body fallbacks into schema defaults. ApprovalToken remains outside business input, split before original registry parsing and hashing. New non-idempotent transforms/prefaults/default factories require a concrete domain redesign and parse/hash/effect proof before admission; never a generic parsed-input API or renamed portable shim.

Current hand raw SDK objects strip unknown top-level keys; migrated ordinary strict objects intentionally reject them before approval/effect. Test ordinary extra keys and authority-selector keys. Preserve ordinary metadata generation and path-specific annotations rather than forcing private policy onto it. Hand and ordinary token eligibility uses canRaiseApproval (destructive, act-with-area or forwarding). Private 12-ID registration retains its existing strict schemas, destructive-tier token extension, annotations/search hints and separate audience; no added eager exposure.

Freeze canonical ids as owning-domain actions and map legacy tool-name action settings through RENAMED_PERMISSION_ACTIONS plus existing manifest/default normalization and permission upgrade sweep. New key wins when both are stored, matching current rename behavior. `request_permission` accepts the stable MCP alias via registry lookup even when hidden, but always invokes through the registry under the same live caller and audience. Session-start pre-gate registers the new canonical id and every reachable legacy alias until its callers are removed; the protected-folder refusal precedes permission cards and cannot be approved away.

**Obsolete approvals are retired, never reinterpreted.** Before serving migrated tools at boot/upgrade, ApprovalService conditionally retires every unspent pending or granted approval bound to an exact renamed legacy action id. Reuse the existing retirement/settlement transaction pattern: stamp consumedAt and expiresAt, leave the historical person's decision/state intact, then settle with existing expired outcome so cards, holds, escalation and durable approval-resolved events converge. Repeated runs are no-ops. Denied or already-consumed history remains history. No old token is rebound to a new action, copied to a new row or spent against new input.

The migration-aware retry returns `APPROVAL_ACTION_RENAMED` with a brief ask-again explanation, no effect and no automatic new approval on that token-bearing request. A fresh tokenless call raises a new card when current permission requires it. Retired legacy request_permission aliases resolve the canonical action, but their old tokens remain invalid. Boot failure completing retirement must refuse startup of the migrated surface; do not serve the new handler with old unretired approvals. Also reject a late old-id token on retry and durably retire its matching row through the same idempotent method. This covers delayed requests and granted-but-unspent rows without approving or denying on a person's behalf.

Use existing CapabilityApprovalHold, card projector, delivery claims, timeout and late-verdict routing. Read actual current person permission again after grant; a person lowering/blocking the action while a card waits must prevent execution. Cancellation/expiry cannot release an effect after a replacement turn starts. Assert one execution and one verdict-delivery owner, not literally one low-level resolved broadcast: existing grant/consume settlement broadcasts are deliberately idempotent and may repeat. Preserve current unattended immediate-refusal/no-wait policy and durable outcome; never wait for a person who is absent.

### Required domain outcomes

| Domain           | Stable names (all required)                                                                                         | Owning effect and constraints                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Basic state      | ping, get_server_info, get_session_count, get_agent                                                                 | Instance and permitted agent-resource awareness; runtime-owned count contract below. The verified caller stays distinct from the declared read target. |
| Accounts         | accounts_usage, accounts_probe                                                                                      | Memory-backed every-runtime usage; supported Claude-account target probe callable from every caller runtime.                                           |
| Session launch   | session_start                                                                                                       | Existing neutral launch service, semantic grant, reservation/claim/cleanup, sender stamp and report-back.                                              |
| Tasks            | tasks_list, tasks_create, tasks_update, tasks_delete, tasks_get_run_history                                         | File-first skill/store atomicity, approval/pause/status, lazy registrar, scope and history.                                                            |
| Mesh             | mesh_discover, mesh_register, mesh_list, mesh_deny, mesh_unregister, mesh_status, mesh_inspect, mesh_query_topology | Same discovery/management policy and immutable system-agent protections.                                                                               |
| Agent creation   | create_agent                                                                                                        | Existing creator authority, workspace/runtime defaults and audit; no new spend/access rights.                                                          |
| Notes            | relay_list_endpoints, relay_notify_user                                                                             | Existing permitted endpoints, trusted sender and canonical caller-chat accounting.                                                                     |
| Routing          | binding_list, binding_create, binding_delete, binding_list_sessions                                                 | Existing scope, exact destructive subjects and routing services.                                                                                       |
| Chat connections | relay_list_adapters, relay_enable_adapter, relay_disable_adapter, relay_reload_adapters                             | Existing agent-visible controls, not new Owner credential/source settings.                                                                             |
| Diagnostics      | relay_get_trace, relay_get_metrics                                                                                  | Existing scoped local diagnostics with no private content expansion.                                                                                   |
| Extensions       | get_extension_api, list_extensions, get_extension_errors, create_extension, reload_extensions, test_extension       | Same generated-code approval, author provenance, Activity, toy-test execution edge and reload lifecycle.                                               |

Extract each handler to its owning neutral domain with typed dependencies. Delete that domain's old in-session and external hand registration in the same slice; no permanent compatibility table or dead re-export. Preserve names, valid result shapes, tier/area/display fields, destructive subjects and shared read-only guard behavior. Retire legacy security lists only when the corresponding declaration derives their current behavior. Preserve service exceptions: adapterManager omission removes four controls; traceStore removes two diagnostics; bindingStore removes four routing tools; meshCore removes eight mesh tools; extensionManager omits five verbs while get_extension_api remains. taskStore/relayCore/bindingRouter absence currently may leave a named tool with an unavailable response; model that explicitly, never turn it into a runtime-specific silent omission. Both boot/docs admission and enabled/disabled tests must agree.

### Exact session count contract

**Latest-main compatibility requirement:** the planning base stays e491a86, but source read from exact merged commit `5cb0e5368ace8304d3fbe061d6681af6aa85ae3f` (#3813, DOR-2065; coordinator main d9993507) adds backgroundWork to get_session_count. Preserve this newer contract when implementation integrates latest main; do not transplant the older base handler and erase it. The same commit adds running_chats state background/optional true-only backgroundWork, RunningTaskDetails and staleUnlessLive, with startup liveHelperIds probing. These are integration prerequisites to preserve, not a new store or liveness implementation for this issue.

Keep input agent_id versus cwd mutual exclusion and the same existing permitted resource-target resolution on all four caller runtimes. These arguments select the agent resource to read, not who is acting: authenticated agent A may read permitted agent B by agent_id or equivalent permitted cwd/linked-worktree target under the existing visibility, boundary and privacy policy. Preserve the requested B subject and reported target; never silently substitute A or impose a native-only self-target rule. The verified principal still fixes A’s caller identity, home, desk and authority, and the target cannot select or increase that authority. get_agent likewise resolves the declared permitted target to its registered home before reading its manifest. No new private-person history or protected-resource exposure is allowed. Delegate storage reads to aggregateSessionList across the registered runtimes for that permitted project/home scope, retaining its 2000ms per-runtime budget, warning channel and retired-alias filtering. Do not read another backend's files or count settings rows as chats.

Preserve `count`, `backgroundWork`, `cwd`, optional `agent_id`, and add required:

```typescript
{
  complete: boolean;
  runtimes: Array<{ runtime: string; count: number; complete: boolean }>;
  warnings: Array<{ runtime: string; message: string }>;
}
```

backgroundWork remains the exact **observed number of chats** returned by the latest shared countBackgroundWorkIn(resolvedCwd), not a task count and not holdsBackgroundWork (which also includes timers/reports). Preserve its exact-folder scope, including nested-agent exclusion. Keep its lazy service import to avoid tool-load/runtime-registry cycles. A numeric0 means no background work currently observed, never proof that every runtime has none; do not convert the running_chats true-or-absent field into false, or clamp a positive observation to a degraded aggregate count. Background work can outlive the foreground turn or UI reload. RunningTaskDetails/staleUnlessLive and the actual liveHelperIds probe remain authoritative for those observations; no new count-driven silence expiry or fabricated liveness.

count is the sum of returned canonical runtime-owned sessions, not an estimate. Each registered runtime appears exactly once, including failures with count0/completefalse. Any underlying warning for a runtime, including partial account loss, makes that runtime incomplete; overall complete is true only when every runtime is complete. An empty registered-runtime set is incomplete with a visible count-unavailable error, not a vacuous complete0. Aggregate warnings are projected to fixed safe text `Some chats could not be counted.` keyed by runtime, at most one per runtime; do not disclose account-root paths, raw exception messages or credentials through the count tool. Normal zero chats with all successful runtimes is complete0; total failure is incomplete0. No new database column or transcript cache.

### Account, model, payer and Full contracts

accounts_usage keeps the current memory store; unknown readings remain unknown. accounts_probe keeps its existing **Claude account target** (`default` or registered Claude id), regardless of whether the calling agent runs on Claude, Codex, OpenCode or Doe. Inject a Claude-owned probe service port from that adapter into the neutral account domain; do not import SDK code into the domain, read credentials in tests or create new vendor probes. Unknown account, unsupported account kind, unavailable reading, failure and one-minute throttle keep existing result/error semantics. Explicit non-Claude targets are refused, never probed using a default Claude sign-in. Existing probe has no model turn; this specification makes no additional charge guarantee beyond that current supported path.

All migrated handlers keep current marks/Full exceptions through shared helpers. A chosen-Full chat may carry marks without the cancelled teammate/origin lowering; a marked outward/irreversible connected-app action still follows DOR-3683. Secret disclosure, self-raising/standing-grant changes and person-set limits remain refused at every level. Below Full preserve current held/marked behavior. NeverAsks and unknown levels keep strict policy. Do not copy stale comments into a new authority rule.

session_start reuses runtime resolution, semantic comparison, agent/default account policy, model/credits eligibility, standing acknowledgements, launch cap, extension chain limits, work claims and cleanup. Same literal mode ids across runtimes are not equal authority. Preserve actual frozen account/model context and selected payer; no fallback silently changes the billed account or credits choice. Task model/account/mode proposals and extension authorship read the same canonical live provenance used by their current policy.

### APIs, result/UI and data model

No new public endpoint or client transport method is required. The internal principal port and capability context gain the server-only seam above. Core count output preserves the latest-main additive backgroundWork field and adds completeness fields. Stable tool names and existing external audiences remain. Per-action identifiers normalize through current schema/upgrade mechanisms; approvals gain an idempotent retirement method, not a new schema/state enum or grant system. No new durable permission or caller-context table.

SessionStartResult stays canonical sessionId, title, markdown link, actual runtime/account, permission {mode,label,callerMode,sameAsCaller}, status started. Write the granted mode into settings and session_started_by, not the requested mode before validation. The first line and client StartedByLine use that same grant. Maintain origin, startup-id rekey, initial-message actor, reservation release, unstarted-settings deletion, work-claim release/rekey and failure/report-back watches. Never return started for an unaccepted dispatch or show an optimistic level before eligibility. Failures retain visible code/reason/isError and no orphan effect.

## User Experience

The agent finds the same named tool in its normal injected DorkOS server, calls it, and sees its existing result or actionable refusal. A successful spin-off opens as the same agent, names its actual runtime/account and granted level, links to a real chat, and shows Started from/Started at with the original caller. The child reports back through the existing spin-off mechanism. A blocked/above-level/protected-place request explains why and starts nothing. A permission card appears in the actual invoking chat; grant/deny/expiry/cancel resumes or concludes according to existing policy. A retired upgrade-era approval asks for a fresh request and never falsely reports permission was carried over.

Counts explicitly say whether they are complete. Usage retains unknown rather than zero. Optional unavailable tools preserve their current visible unavailable response or declared omission, consistently across caller runtimes. No new settings, consent ritual or runtime-name marketing claim is introduced.

## Testing Strategy

Every test has a purpose comment, named subject/effect and nonzero positive control. Derive the current tool inventory from production declarations, not this dated39 literal; assert every baseline required outcome remains accounted for as domains move. All test/provider edges are synthetic and credential-free.

### Actual injection/listener/lifecycle harness

Use actual SQLite principal/binding services and registered agent homes, linked owned worktrees and canonical session settings. Start the real loopback connector runtime listener with actual agent server factory and boot-composed registry. Capture the config produced by each real production adapter: Claude actual factory instance, Codex actual thread/app-server MCP config and environment indirection/current thread-key binding, OpenCode ensureManaged remote config/headers, Doe assembleDoeMcp real McpConnection. Script only model/SDK execution edges, not server registration, authentication, handlers or results. Connect real MCP Clients through those exact configs to the listener; exercise real principal open/resolve/renew/revoke and stale/current ownership. A factory loop labelled with runtime names is insufficient proof for these cases.

For Claude use the real SDK MCP instance and linked client plus its real current-turn resolver; prove its session/principal plumbing with the production factory. For Doe include its actual discovery/call execution closures, not mocked names. Native transport headers and bearer are test-minted only, never ambient credentials. Assert four runtime subjects exactly, nonempty unique tool lists, current required-domain subjects, list-then-call and actual effect. Configuration-off/identity-missing negatives retain registered enabled positives.

### Required integration cases

- Four source runtimes each start a real persisted child through actual MCP call into the shared launch service with a scripted target runtime edge. Query exactly one child, one accepted dispatch, correct agent/target runtime/parent origin/granted settings/result and actual started-by UI line. Exercise cross-runtime target semantics, same/lower/above/omitted modes, Auto fallback, chosen Full carrying marks, never-ask and current person lowering. Refusals produce zero rows/dispatch/claims; parent settings stay unchanged. Test report-back routing without live inference.
- Stored Full but active lower and pending next-turn Full cannot elevate. Lower a running turn through actual supported control then call again. Revoke/replace/interrupt while service preflight or approval waits; release the wait and assert zero late effect. Rekey and warm background ownership retain only their existing permitted lifetime. Forged caller identity/runtime/session/owner assertions, mismatched authenticated caller-cwd headers and old thread/turn credentials fail before effects. Declared tool resource/launch selectors are tested under their existing domain policy, not treated as identity forgery: session_start still refuses another agent’s launch desk, room folders and protected launch places; permitted cross-agent reads are positive cases below. Own linked-worktree launch succeeds.
- Real ApprovalService/store: legacy/current Blocked/Ask/Allowed settings, current-key precedence, hidden guessed action, request_permission alias, token stripping and exact input hash, replay, protected pre-gate under Always allow, permission lowered after grant, attended hold versus unattended refusal, exactly one effect and one verdict-delivery owner. Boot retirement covers pending and granted-unspent old actions, keeps history, expires card/durable events idempotently, refuses old token with fresh-ask instructions, then new tokenless ask/grant works.
- Authenticated cross-agent read preservation: through each of the four production injection/client paths with real listener/principal lifecycle (Claude’s actual in-process equivalent), caller A reads permitted agent B’s count and manifest using B agent_id, equivalent permitted cwd, and a permitted linked-worktree target resolving to B. Use nonzero distinct A/B counts and distinct manifest identity, assert the exact B subject/result and reported target rather than an A fallback, and retain an A own-target positive. Exercise actual shared target resolver/home lookup and owning runtime readers, not mocked handler results. Missing selector, both selectors, unknown agent, forbidden resource/private-person history and forged caller identity/header negatives remain explicit; no target may affect A’s power or principal.
- Nonzero runtime-owned session fixtures: four runtimes contribute distinct canonical counts (e.g.1/2/3/4 → complete10); retire an alias; inject whole-runtime rejection/timeout and partial-account warning; verify exact surviving sum, all runtime rows, completefalse and safe deduplicated warnings. Complete empty success differs from empty runtime set and all failures. Count calls arrive through all four actual injected client paths.
- Latest-main regression: preserve additive backgroundWork through all four caller clients using actual projected running task state. A foreground-complete chat with a live helper/shell/Monitor remains observed after reload; timers/reports alone do not count; exact folder excludes a nested agent; unknown reporting remains absent on running_chats and does not become false. Keep current RunningTaskDetails and liveHelperIds silence-sweep positive/terminal controls. A degraded historical count must not erase independently observed background work.
- Every required operation receives effect/denial coverage: task skill+store+registrar and approval/pause; synthetic cached usage and Claude probe process edge with no credentials; local notification trusted sender/session; Mesh system-agent negative and permitted management; binding/control/trace services with disabled counterparts; extension API plus toy create/reload/test, authorship/Activity and approved execution edge. Never run live cron, foreign code, real outside messages or a model.
- Parse/exposure: enumerate actual migrated schemas, prove original valid inputs and trims through SDK plus registry, unchanged handler fallbacks/hash, strict extra-key refusal before handler/card, approvalToken behavior, eager/search metadata, path-specific annotations and private12 absence from ordinary lists. Preserve current private exact list/calls on its own boundary with an enabled principal positive.
- Warm behavior: schema/name fingerprints refresh Claude process, loaded Codex thread/tool-list status, OpenCode managed signature and Doe fresh assembly. After migration/new turn, actual next-turn call works; old callback/lease cannot execute. No requirement to prove a vendor model chooses a tool.

### E2E and mutation proof

Render the existing StartedByLine against the actual stored launch record/result using client component tests; run affected browser specs when implementation touches that UI. Existing real event/canonical-start contracts remain. No new UI page is required. For each security/result seam run green/red/green with identical final selection/counts: remove domain registration, substitute stored Full, omit action-rename mapping or retirement, omit current-owner recheck. Require the intended assertion failure, not setup/import failure or zero subjects. Restore before fresh targeted tests, server/shared type/lint and required OpenAPI export/diff. Coordinator owns exact combined full verification and independent REVIEW.md plus Security review, including sibling schema/context changes. No bypass or baseline exemption.

## Performance Considerations

Registry composes once; per-call facts are read-through existing ownership entries with constant-time lookup and no additional durable caller writes. Use one neutral event facade per active turn and existing queues. Remove closures with ownership; do not retain sessions in a new unbounded map. Catch-up/listing reads no model. Count fan-out retains existing parallel2000ms budgets and warning behavior; no sequential per-runtime timeout multiplier. Preserve curated eager sets, not all39 always loaded. Record actual list payload/surface digest and unchanged-build stability; no timing/SLO claim is made by planning probes.

## Security Considerations

Principal binding and exact process ownership authenticate the caller; wire input never selects caller identity, level, billing principal or caller home. Declared resource-target agent_id/cwd inputs keep their existing permitted cross-agent read semantics without changing who is acting. Current human-set action/Files & commands authority, protected folders, package trust, system agents and domain subjects remain shared checks. Preserve current marked-Full outward exception and retained secret/self-raise/person-limit refusals. Read actual caller desk separately from caller home; enforce each owning domain’s existing visibility/boundary/privacy policy for resource targets. Preserve permitted agent count/manifest reads while refusing forbidden resources, private-room files and personal transcript expansion. Hold cancellation/revocation checks survive async waits and rekey. Unknown/stale facts refuse; no Owner fallback, public-token reuse, alternate parsed-input path or direct handler grant. Approval upgrade changes history only through idempotent expiry and never reinterprets a grant. Logs, count warnings and proof artifacts contain no real bearer, permit, credential or account-root disclosure.

## Documentation

Update contributing/adding-a-runtime.md and agent-operator-surface.md from actual current registry/injection contracts, correcting Claude-only claims and stale counts. Update runtime capability evidence, self-description omitted-family caveat, affected tool security/tier docs and operating-skill names without premature exhaustive claims. Regenerate OpenAPI from source and commit only actual changes. Changelog uses spin-off/schedule/mini-app outcomes, not internal MCP jargon. Preserve DOR-3030's narrow shipped result/UI history. Document accounts_probe's Claude target and count completeness; do not promise new-vendor probes or universal MCP resource parity.

## Implementation Phases

1. **Foundation:** consume delivered DOR-2067, freeze neutral turn-facts/event facade and principal ownership extension; tests for real prepared modes, cancellation and lifecycle. No new tool exposure before every caller mapping is authoritative.
2. **Core spin-off:** neutral session-start extraction, registry declaration, action normalization/approval retirement/pre-gate, actual four-injection list/call/child/UI/report-back proof. Delete old registration in this slice; non-closing reference to DOR-4481.
3. **Required domains:** core state/accounts and exact count output; tasks/notes; team/routing/diagnostics; extensions, each with actual service effects and off/on counterparts. Serialize shared composition/gate files and preserve all39 outcomes. These are required completion phases, not optional enhancements.
4. **Closeout:** recompute inventory, remove dead roots/imports/tables, warm config/fingerprint proof, docs/OpenAPI/changelog, integrated full gate, independent REVIEW.md and Security review. Only after all required outcomes have merged or an explicit owned exception is approved may coordinator close DOR-4481. No such waiver is currently accepted.

## Open Questions

- ~~(RESOLVED) Where do missing live facts live?~~ **Answer:** read-through closure on the existing process-owned ConnectorTurnOwnership entry, resolved through the verified principal and exact current owner; no new store. **Rationale:** current renewalOwners already binds opaque permit and active-object identity and clears on revoke/boot. Shared turn-power handles marks/serial/unattended; only applied/chosen mode distinction, Never ask and event/cancel facade are missing.
- ~~(RESOLVED) How are home and cwd interpreted?~~ **Answer:** principal home authenticates identity; canonicalCwd is the owned desk. Existing generic context.cwd retains its present home meaning; new neutral runtime-tool caller fields are explicit. **Rationale:** changing all current capabilities' cwd would silently change existing scope; new domains need actual provenance. Existing core agent_id/cwd selectors choose permitted read resources, not caller identity; no native-only self-target restriction is introduced.
- ~~(RESOLVED) What does an incomplete count mean?~~ **Answer:** exact surviving sum plus complete, one row per registered runtime and safe warnings as frozen above; retain latest-main backgroundWork observations and unknown-not-false semantics. Empty provider set is unavailable. **Rationale:** reuse runtime-owned aggregation/alias behavior while making omissions visible and keeping existing count fields.
- ~~(RESOLVED) Can old approval tokens follow action renames?~~ **Answer:** no; durably expire unspent pending/granted legacy rows and reject retry with APPROVAL_ACTION_RENAMED before any new effect; a fresh tokenless request can ask again. **Rationale:** tokens bind exact action/input, and preserving grants by reinterpretation is an unsafe migration. Existing retirement/settlement gives idempotent durable closure.
- ~~(RESOLVED) Does accounts_probe acquire new vendor support?~~ **Answer:** no; the existing Claude-account target is callable by all four caller runtimes through an injected Claude probe edge. **Rationale:** this delivers the existing outcome without fabricating unsupported probes, credential reads or alternate payer behavior.
- ~~(RESOLVED) How does double parsing affect hand tools?~~ **Answer:** retain original executable parse and current fields/trims/handler fallbacks; reject unknown keys explicitly; require domain equivalence proof for any future non-idempotent input. **Rationale:** actual39 census found only three idempotent trims; moving body defaults earlier changes hash meaning. No general bypass is justified.
- ~~(RESOLVED) Are runtime exceptions accepted?~~ **Answer:** none of the39 required outcomes is waived. Preserve only existing public/private/resource and supported-target contract distinctions. **Rationale:** disabled-service or unsupported-vendor conditions do not excuse native caller omissions. Any genuine future exception requires coordinator decision, named owning domain, user consequence/evidence/reopening condition and Security review when authority changes.
- ~~(RESOLVED) What ADR status represents the requested draft?~~ **Answer:** proposed, explicitly unaccepted. **Rationale:** generic Flow scaffold says draft, but repo TEMPLATE.md/ADR lifecycle has no draft status; coordinator agreed canonical proposed.

No unresolved user-intent decision blocks decomposition. Separate review must validate this technical contract before execution.

## Related ADRs

- Proposed `261116-065134`: missing live tool context rides the existing process-owned runtime turn; explicitly unaccepted and linked to this spec.
- Accepted `260723-050219`: one boot registry and transport-owned envelopes, read with its errata.
- Accepted `260923-223905`: existing tier-gate choke points and approval machinery.
- Accepted `261004-235818` and current amendments/source: semantic inherited start level; current chosen-Full/marks behavior wins over superseded lowering clauses.
- Accepted `260926-172251`: registered home and owned desk; `260908-153657`: process-owned runtime renewal.

## References

- Frozen [01-ideation.md](01-ideation.md), DOR-4481 and typed prerequisite DOR-2067; DOR-3030 result/UI and DOR-3169 registry reachability remain distinct shipped scope.
- specs/capability-mcp-full-schemas; REVIEW.md; AGENTS.md and full north-star/proactive/etiquette set cited in ideation.
- Exact main-contract adaptation: commit5cb0e5368ace8304d3fbe061d6681af6aa85ae3f/#3813 DOR-2065, read with git show without merging this planning tree; backgroundWork count/running/task-source contracts above supersede older base assumptions.
- Fresh private evidence .dork/flow/tmp/4481-ideate: actual-issue.json, coordinator-acceptance.md, surface-probe.ts and both final census JSON files, hand-input-probe.ts/census.json, current-targeted-tests.log, source/artifact file-hashes.json. These are finite planning probes, not completed implementation acceptance.
