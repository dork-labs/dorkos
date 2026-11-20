---
slug: stored-model-launch-reconciliation
id: 261119-041904
created: 2026-11-19
status: ideation
---

# Ideation: Check a saved model at its first executable launch

- **Issue** DOR-1692
- **Author** Codex, directed by the project coordinator
- **Date** 2026-11-19
- **Status** Ideation. Implementation and verification are not complete.

## 1) Intent & Assumptions

**Task brief.** Reconcile DOR-1692 against delivered DOR-4411, then specify only its remaining question: what happens when a model saved before ownership is known reaches its first actual inference on the runtime and account that finally own it?

The original ticket calls the permission-mode issue a latent shape, not an exploit, and asks whether to pin the subset property or adopt explicit bound/hint authority. DOR-4411 now supplies explicit authority and a strictest-mode binding backstop. The ticket separately says no equivalent stored-model binding check exists. The original body was inspected from a retained issue capture. A separate fresh native issue/comments readback supplied by the coordinating reviewer confirms that the only prior Flow comment asks the subset-test versus explicit-authority question (Oct 6 local time, Oct 7 UTC); it does not decide model behavior. The coordinator has accepted the product contract below for ideation. DOR-4411 and DOR-1693 are verified Done; DOR-4488 remains separate work in progress. Those statuses do not establish completion of this stored-model requirement.

**Product contract for this ideation:**

- Preserve the saved choice when confirmation is unavailable or unfit. Absence of evidence is not evidence that a model is unavailable.
- Grandfather a truly initialized conversation. Reopening, resuming, or a mere account catalog change does not retroactively replace its saved choice.
- Before the first owned inference, a **fresh, applicable, complete catalog for the actual selected runtime, account, and payer** may refuse a saved explicit model it positively excludes. Return actionable model-selection feedback before inference or billed work begins.
- Existing specifically approved routes such as DOR-3168 own their verified same-account substitution plus durable notice. They are not followed by a generic second refusal or a cross-runtime default rule.
- No silent model wipe, invented default, changed payer, fallback to personal sign-in, automatic purchase, or secret resolution/model request solely to validate a picker choice.
- Metadata-only binders stay free of native/network discovery. Their first real execution must still enter the applicable launch check even if `session_metadata.runtime` is already non-null.

**Out of scope:** changing runtime mode policy; reimplementing DOR-4411; runtime identity migration; global model discovery refresh; repairing every catalog cache; adding a second authority map; changing credits eligibility; rewriting existing transcripts; network/native probes in this ideation; a new proof programme or speculative exploit reproduction.

## 2) Pre-reading Log

All code references below are pinned to main `4ea6c68a8f303dc569e0f362c3c459da73a1bf4c`.

- DOR-1692 original issue capture: the original requirement and permission question. Separate fresh native comments/relations readback: no later model-policy decision; related DOR-1693/DOR-4488. These are distinct provenance records, not a claim that the retained capture is a current query.
- `AGENTS.md` and `specs/manifest.json`: repository conventions and registered spec inventory. This ideation has its own timestamp identifier.
- Installed Flow `skills/ideating-features/SKILL.md` and `templates/docs/ideation.md`: this document follows that scaffold; next stage is SPECIFY after root review.
- Source inspection of the nine production binding callers and the test families linked below. Existing test code is evidence of intended coverage, not evidence of a newly executed passing run.
- `routes/session-model-gate.ts:188`, `routes/sessions.ts:606`, `core/runtime-registry.ts:261,828`: implemented mode authority and binding CAS.
- `runtime-seam/session-metadata-columns.ts:53`, `runtime-registry.ts:748,879`: current model/default writes preserve existing choices without catalog reconciliation.
- Four runtime discovery and execution paths, fleet continuation/resume, and existing real SQLite/route test families: constraints described below.

### Source anchors and verification status

The following links point to repository source, inspected at the pinned main revision above:

- [Mode and model authority](../../apps/server/src/routes/session-model-gate.ts), [HTTP settings and first-send callers](../../apps/server/src/routes/sessions.ts).
- [Binding CAS and settings](../../apps/server/src/services/core/runtime-registry.ts), [metadata update expressions](../../apps/server/src/services/core/runtime-seam/session-metadata-columns.ts), [executable launch](../../apps/server/src/services/session/launch/launch-session.ts).
- [Mode HTTP regressions](../../apps/server/src/routes/__tests__/sessions-multi-runtime.test.ts), [registry SQLite regressions](../../apps/server/src/services/core/__tests__/runtime-registry.test.ts), [runtime mode backstop](../../apps/server/src/services/runtimes/__tests__/unsupported-mode.test.ts).
- [Claude catalog](../../apps/server/src/services/runtimes/claude-code/messaging/runtime-cache.ts), [Codex catalog](../../apps/server/src/services/runtimes/codex/model-catalog.ts), [OpenCode discovery](../../apps/server/src/services/runtimes/opencode/model-discovery.ts), [Doe catalog](../../apps/server/src/services/runtimes/doe/models.ts).
- [Same-session continuation](../../apps/server/src/services/session/fleet/continue-service.ts), [new-session carry-over](../../apps/server/src/services/session/fleet/carry-over.ts), [automatic resume](../../apps/server/src/services/session/fleet/resume-service.ts).

No tests, native discovery, provider requests, or model calls were run to prepare this ideation. References to existing tests describe their source and assertions. Implementation, current-head execution evidence, and any full verification remain owed.

## 3) Codebase Map

### Existing authority and data flow

`PATCH preference → unbound session_metadata row → runtime/account selection → executable launch → native/engine inference`.

HTTP first send is `routes/sessions.ts:870 → dispatchSessionMessage → launch/launch-session.ts:619–705`. It chooses the runtime, applies account eligibility, binds through `persistSessionRuntime:657`, then resolves the actual winning runtime again at 705. Internal dispatch uses the same launch helper.

`persistSessionRuntime:261` awaits agent defaults **before** one guarded UPSERT. It fills model/effort only when null. Its SQL claim `setWhere runtime IS NULL:321` never rebinds an existing owner. `claimedPermissionMode:828` judges the actual stored mode inside the statement; an undeclared non-null mode becomes that runtime’s strictest mode, not a looser configured seed. These guarantees remain intact.

Other binding callers are rooms `room-turn-runner.ts:832`; relay `adapter-factory.ts:400` and `binding-subsystem.ts:421`; schedules `record-run-session.ts:25`; startup `computers.ts:90` and `steps/capabilities.ts:429,445`; connection events `events/session-target.ts:79`. They stamp metadata/authority for different lifecycles. They must not all acquire a catalog side effect just because they share the registry method. These are source callsites; none was executed for this ideation.

### Ownership and insertion points to specify

| Owner                                      | Candidate responsibility                                                                                                                                              | Must remain unchanged                                                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Shared session launch/orchestration        | Obtain the actual session/runtime/account/payer choice; classify pre-inference vs initialized; refuse before dispatch effects when applicable evidence already exists | Origin, binding winner, caps, account eligibility, normal declined/unknown behavior                          |
| Registry / existing durable metadata owner | Conditional synchronous settings/binding write against the observed row; no await in a SQLite transaction                                                             | First-write ownership, newer explicit choices, rekey/recovery identity                                       |
| Claude adapter launch                      | If account applicability is knowable only after real account resolution, enforce there before handing a prompt to the SDK                                             | No extra warm inference; existing unknown catalog degrades; existing initialized conversation remains usable |
| Codex transport launch                     | Use the actual acquired process/account identity; DOR-3168’s approved substitution route owns known unavailable models and durable notice                             | Credits/custom provider bypass, cancel/time bounds, no first-row guessing, selected-account isolation        |
| OpenCode execution preparation             | Use actual directory/provider/payer context before `session.promptAsync`; a precreated native session alone is not proof of inference                                 | Provider/custom models, sidecar lifecycle, no native/network work during metadata-only bind                  |
| Doe execution / inference selection        | Use the frozen session format/payer when initialized, else selected configured/credits metadata before the engine calls inference                                     | No credentials callback for metadata listing; frozen history protocol and payer                              |

These are proposed ownership responsibilities, not new hooks already present. Existing launch and transport invariants need a concrete small API design in SPECIFY. The present `ModelOption[]` alone does **not** attest freshness, completeness, selected account, or whether it came from a stale fallback. Do not treat adding `unverified: false` as proof.

### Evidence classes, expressly different

| Class                                                                                  | What it establishes                                                                             | Gate outcome                                                                                                                              |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh complete list, same selected runtime/account/payer and applicable session format | Positive membership or positive exclusion for this launch only                                  | Keep an offered value/alias; refuse a confidently excluded saved explicit model, unless an approved runtime-specific substitution owns it |
| Empty, thrown, timed out, paginated/incomplete, any unverified/shortened list          | No usable exclusion evidence                                                                    | Keep choice; use existing runtime failure behavior if execution later cannot run                                                          |
| Stale cache or wrong/unknown account/payer/session-format identity                     | Applicability/freshness unproven, even if rows look confirmed                                   | Keep choice; no destructive migration or generic refusal                                                                                  |
| Doe explicit/frozen configured model                                                   | Known configured namespace/format/payer, not proof that an external account currently serves it | Preserve configuration; only judge against a genuinely applicable authority, not today’s unrelated global model                           |
| Native-created session/thread or registry binding without owned inference              | Initialization for model-grandfathering remains unproven                                        | Do not bypass first-execution check merely because an ID exists                                                                           |
| Confirmed initialized conversation                                                     | Prior owned inference boundary established through adapter-owned evidence                       | Grandfather saved choice on ordinary reopen/resume; a new explicit model change still uses the existing write gate                        |

### Discovery boundaries and cost constraint

- Claude `messaging/runtime-cache.ts:373` uses memory, disk, or lazy `query().supportedModels()` (`315–348`). Disk TTL is 24h; the query uses the active account’s user settings, not necessarily a session’s final chosen account. It is native discovery, not a pure constant lookup. Never initiate it inside a metadata binder; no inference prompt may be sent merely for the gate.
- Codex `model-catalog.ts:324` caches binary/environment-name/home-auth-file identity for 60s and may return the same-identity last good result for five minutes after failure (`362`). This is not fresh exclusion proof. Its normal cold list starts app-server/model-list, not an inference. Where exact account identity appears only on an acquired execution process, the transport check is required; DOR-3168 is the specific reviewed substitution route, not delivered on this pin.
- OpenCode `model-discovery.ts:12` can lazily boot the sidecar via `getClient`, ask directory-scoped providers, and conditionally request local Ollama tags or the public OpenRouter catalog. These are native/network effects, not paid model requests, but metadata binders must not trigger them. An optimistic shortened menu is unverified; unreachable filters can leave stale sidecar data.
- Doe `doe-runtime.ts:311` reads actual frozen session inference, configured model metadata, or credits metadata. `models.ts:17` never resolves a key or starts inference. A configured model is not independently confirmed account availability. `auto-model.ts:270` uses held credits protocols/catalog; no minting or inference is authorized by the model gate.
- Credits `credits-models.ts:203,353` has its own applicable service/protocol catalog, freshness/context checks and refusal semantics. Readiness-only API at 363 explicitly avoids fetch/token minting. Existing strict service rules stay strict; this candidate does not reinterpret them as a personal catalog fallback.

**Zero inference/cost from this gate** is a requirement: no sampling, SDK prompt, credential validation billed as a model call, or change in payer. Native metadata requests may be reused only inside the existing legitimate executable launch lifecycle and its normal bounds. Whether each SDK guarantees a metadata-only exchange is an implementation prerequisite; if unproven, classify evidence unknown rather than run a probe to guess.

## 4) Root Cause Analysis

No exploit or user failure was reproduced. Source shows a missing reconciliation decision rather than a proven current account failure.

- Original mode risk: inferred authority could accept a mode another runtime did not declare, then a seed supplied a looser mode. DOR-4411 now explicitly chooses bound/hint authority and replaces undeclared modes with the runtime’s strictest mode.
- Remaining model shape: a person may store an arbitrary model while no runtime has standing to judge it. The later binding preserves that value by `coalesce`, without asking an applicable model authority. Unlike static mode descriptors, catalogs are fallible, context-dependent and potentially effectful.
- Existing tests pin explicit-model preservation/default seeding; they do not show a stored unsupported model being reconciled at the first actual execution boundary.
- Historical/cold rows complicate this: `runtime != NULL`, `ensureSession`, and a native thread ID are not sufficient evidence that an owned inference ever began. Refused setup can leave such rows. A shared “all bound rows are initialized” shortcut would leave metadata-only binders uncovered.

**Confidence:** source-confirmed absence of a generic bind model check; source-confirmed mode replacement. Exact runtime-specific initialized markers and their treatment of old incomplete rows remain unresolved below. No new test pass claimed.

## 5) Research & Recommended Direction

### Options

1. **Query every catalog inside `persistSessionRuntime`. Reject.** It changes metadata callers into native/network callers, awaits across an ownership decision, and still lacks final account/payer evidence. Never await within a SQLite transaction.
2. **Use only the existing PATCH gate. Insufficient.** It validates new writes when it can, not the actual owner/account chosen later. It intentionally degrades on unknown catalogs and grandfathers existing sessions.
3. **Executable-boundary reconciliation, with adapter checks where identity resolves late. Recommended.** Keep registry writes inert; every path that can start owned inference reaches a guard at its actual execution edge. Use existing registry/adapter state, not a parallel authority map. A call through shared dispatch must not certify a later changed account. Transport-level checks consume the final account/payer context and recheck abort/liveness before effect.

### Concurrency and cancellation

Catalog discovery and any account resolution happen outside a SQLite transaction and under existing bounded cancellation. Observe the uninitialized session/model/settings and selection identity. Immediately before an effect or write, re-read authoritative ownership and relevant settings; no stale answer may replace a concurrent winner.

If a write is required for an already approved substitution contract, use a **synchronous conditional** update/claim against runtime ownership and exact observed model (`IS` handles null), plus any durable revision necessary to prevent ABA. The actual row must still match; if another send bound it or a person changed its model, leave that winner unchanged and return through a bounded refusal/reprepare decision. Never bind first then asynchronously delete or roll back a row somebody else may now own. Preserve required recovery identities and canonical rekeys.

A refusal need not clear the stored model. Keep it available for the picker and explain why the first turn did not start. If an existing metadata row has already bound its runtime, do not delete or rebind it on refusal; the person can change the model on the same owner. Return no inference/dispatch claim and keep existing cleanup/reservations exact. If refusal is possible before a new binding, leave it unbound. Do not introduce a post-refusal orphan audit/projector lifecycle.

### Feedback

Use the existing typed `model_unavailable`/model-selection error surface, exact stored model, and the actual applicable list where useful. Candidate plain copy: “{model} isn’t available here. Choose another model.” Final wording/typed code and picker action belong to SPECIFY and copy review. Preserve raw details and unknown-model behavior. A runtime-specific approved substitution instead emits its existing durable explanation exactly once and preserves actual saved choice/payer semantics.

### Initialized and old-row policy — unresolved implementation details

The product rule is clear; the identifying evidence is not yet uniform:

- `session_metadata.runtime` proves a recorded owner, not inference.
- Codex native thread creation can precede a refused turn; a transcript/result/model-request or adapter-owned successful-start marker must distinguish this from actual owned inference. Exact marker, crash timing and old imported transcripts require source design.
- OpenCode `ensureSession` may precreate the native ID, so prompt acceptance/observed model work needs a separate authoritative distinction without inventing a model call.
- Doe freezes format/payer before execution; frozen inference alone may exist before a failed setup. Determine which existing durable engine/request record marks initialization without resolving credentials.
- Claude native transcript discovery and failed initialization need the same distinction; an existing persisted chat should not be treated as new merely because its live session cache is cold.

No schema migration or new “initialized” field is authorized by this candidate. SPECIFY must choose the smallest reliable existing marker or propose an explicit durable lifecycle fact with its owner, never infer initialization from a displayed assistant error. For old rows whose initialized status cannot be established, preserve their model and existing behavior; do not surprise-upgrade them into a refusal. This conservative compatibility choice must be explicit in the final spec and cannot silently exempt newly minted metadata-only rows from first real launch coverage.

### Separate DOR-4488 consumers

This pin’s `rejectUnknownModel` calls `runtime.getSupportedModels()` at `session-model-gate.ts:86` without forwarding existing `options.sessionId`. DOR-4488 owns forwarding the context for a normal model picker write; its reviewed separate branch is not stacked here. That preserves a warm/reopened Doe conversation’s frozen catalog, not a generic binding reconciliation.

In-place `continue-service.ts:260` updates the same session; it needs that session’s account/format if the shared checker takes context. It is currently Claude-only at 343. Account carry-over check at 428 creates a new chat (`carry-over.ts:356`), so use the target account/runtime/payer and do not pass the source chat’s frozen context. Resume at `resume-service.ts:454` uses the same initialized conversation and remains grandfathered. Fresh new carry-over must reach first-execution validation; an imported error-only old row is not automatically a fresh carry-over.

### Scoped acceptance plan for SPECIFY (not executed)

Use existing actual SQLite registry/routes and real adapter harnesses. Script only external catalog/process/execution edges; do not script owned CAS/auth results.

1. Real prelaunch saved explicit model reaches selected runtime; complete fresh applicable catalog excludes it: typed actionable refusal, choice preserved, no owned inference, no paid call, no new orphan claim/audit/projector; an offered value or resolved alias is the independent positive.
2. Catalog empty/throws/times out/unverified/partial/stale/wrong account or payer: no refusal/wipe/fabricated substitution. A fresh correct-account positive differentiates unknown from unsupported.
3. Every metadata-only binder family remains inert, then its first actual launch is checked. Cover the normal HTTP path and one existing internal path plus each adapter edge with late account identity; no label-only four-runtime loop.
4. Real deferred external discovery plus SQLite: concurrent model PATCH, competing runtime claim, abort and canonical rekey. Old verdict never overwrites a winner; no await inside transaction. Keep ordinary allowed launch positive and default/agent-seed distinction.
5. Truly initialized warm/reopened/imported conversations and automatic resume remain usable. New same-runtime/account and cross-runtime/account carry-over uses the actual target context. Ambiguous old rows follow the conservative compatibility rule above.
6. DOR-3168’s owned same-account substitution is not double-refused; exact durable explanation, credits and custom providers remain. No generic first/default-row substitution or payer change. DOR-4488 warm/reopen/new-session picker regressions retain their separate purpose.
7. Only after an implemented baseline: one discriminating scoped removal of the operative membership/CAS check with independent allowed launch positive, restored green and known bytes. No ritual global control or native-model probe programme.

## 6) Decisions

These are the accepted product direction for this ideation, subject to the unresolved implementation questions below. They do not record a completed implementation, new tracker mutation, or passing verification.

| Decision                       | Candidate choice                                                         | Rationale                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Original permission half       | Cite DOR-4411 explicit authority and strictest-mode claim                | Delivered source and existing real route/SQLite coverage supersede the subset-only question |
| Unknown confirmation           | Preserve saved choice and established behavior                           | An absent/stale/unfit menu cannot establish unavailability                                  |
| Fresh applicable exclusion     | Refuse before first owned inference, keep model selected                 | Actionable recovery without silent mutation or wrong billing                                |
| Specific approved substitution | Let its runtime own it, including DOR-3168                               | Same-account evidence and durable notice are more precise than a generic rule               |
| Metadata binding               | No native/network catalog effects                                        | Coverage belongs at first executable launch even when metadata is already bound             |
| Initialized conversations      | Grandfather; explicit new writes still gated                             | Avoid changing an established conversation because a menu changed                           |
| Ambiguous old rows             | Preserve existing behavior; specify evidence/compatibility explicitly    | Unknown initialization cannot justify surprise refusal                                      |
| Concurrency                    | Outside-transaction discovery, synchronous conditional write or no write | Preserve runtime/model winners, cancellation and canonical identity                         |

### Open design questions before SPECIFY can be executable

1. Which existing durable marker establishes owned initialization for each runtime, including setup refusal/crash/imported history? A thread ID alone is insufficient. Root must review any minimal new durable fact if existing records cannot distinguish it.
2. How do adapters expose applicable fresh/complete catalog evidence without turning stale `ModelOption[]` into authority? Prefer existing execution context; no second cache/map. Metadata APIs currently lack a common freshness/account proof contract.
3. Where exactly can each adapter refuse before inference without leaking a reserved claim, dispatch row, projector or persisted replacement? Trace existing cleanup, especially when the guard must run after final account resolution.
4. For a model or owner changed while confirmation awaits, prefer a bounded stale-input refusal vs a single reprepare under the new context. Never an automatic retry loop or overwrite.
5. Reconcile pending DOR-4488/3168 landing with final main at SPECIFY; do not assume their branches are already delivered here.

**Recommended next step:** review this ideation and checkpoint the original permission half separately. Carry unresolved stored-model design into SPECIFY only after initialization/evidence/placement questions have precise owning seams. No closure recommendation for the entire DOR-1692 issue.
