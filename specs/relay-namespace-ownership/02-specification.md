---
slug: relay-namespace-ownership
number: 261001-212400
created: 2026-10-01
status: implemented
---

# Relay namespace ownership and boundary routing

**Work item:** DOR-2660
**Status:** Source implemented within the approved bounded scope; fresh local verification passed; exact-pushed-head delivery review pending
**Source base:** `d19d3ee73534dc9b69474bedffe9840db74ed931`
**Workspace:** `/Users/doriancollier/.codex/worktrees/relay-namespace-ownership/dorkos`
**Branch:** `codex/relay-namespace-ownership`
**Worker:** Originating GPT-6.1 Sol / Medium, explicitly selected by the operator.

## Problem and intended result

A webhook currently owns its configured inbound subject as an outbound routing prefix. The shared schema and runtime defense reject only system/control destinations. A webhook can therefore claim an agent, human, inbox or document address. Persisted configuration loading uses a permissive union with a record fallback, bypassing type-specific webhook validation. Raw string prefix routing also lets `relay.webhook.x` capture `relay.webhook.x2` and leaves equal prefixes dependent on registration order.

A webhook must own only its own literal address within `relay.webhook.*`. Routes must match whole dot-separated tokens. Conflicting ownership must be refused before config mutation or adapter startup, including pending starts and replacements, while valid runtime specialization keeps working. Reserve the new Doc principal before later internal Doc routing becomes reachable.

## Authorization and execution boundary

The operator approved this exact supporting guard/routing fix. This is a straightforward bounded bug fix and needs no ADR. The preparation pass authorized artifacts only. The parent subsequently verified DOR-2663 merged, performed the Flow claim and explicitly released implementation in this isolated worktree. Source tasks 1.1–1.3 are implemented with red/green and mutation proof; final verification and delivery remain parent-owned. Doc source/schema work remains owned by the Doc lane. No blanket Doc Channel prerequisite is introduced.

## Scope and exclusions

Include shared namespace policy, real webhook defense, persisted webhook validation, registry boundary matching/ownership reservation, manager pre-persist conflict checks, and minimal public Doc sender/destination/mailbox guards. Reuse current libraries and error conventions. No new dependency, config field, migration, route, paid inference, broad permission redesign, process allowlist, parser-order change, durable HTTP outcome redesign, or Doc acceptance implementation. DOR-2661, DOR-2664 and DOR-2666 remain separate.

## Contract

### 1. Positive webhook namespace

Accept only `relay.webhook.<literal-token>[.<literal-token>...]`. The two namespace tokens are exact lowercase strings. Require a nonempty suffix, literal alphanumeric/hyphen/underscore tokens, and no more than the bus's existing 16-token ceiling. Reject wildcards, whitespace, empty tokens, trailing dots, bare roots, lookalike namespace names, and other namespaces. Do not normalize an invalid configured subject into a valid one. Keep valid nested names and exact original casing of suffix tokens.

Define one shared predicate/schema and a named refusal in `packages/shared/src/relay-adapter-schemas.ts` (or an adjacent existing shared relay schema module). The runtime uses the same policy for `_start`, `handleInbound` and `deliver`, including constructor calls that bypass Zod. A refused config starts no timer, publishes no message and issues no outbound fetch. Preserve current signature/replay/budget behavior for valid webhook subjects. Correct edited comments and manifest guidance to name this narrower policy.

### 2. Persisted configuration and manager checks

`loadAdapterConfig` must validate saved webhook entries by their own schema instead of trusting `AdapterConfigSchema`'s record fallback. Do not revalidate unrelated legacy types with new semantics in this ticket. Preserve invalid raw entries in `unparsed`, report their named failure, retain valid neighbors, and save rejected entries unchanged during unrelated edits. Reading/diagnosing invalid settings must not silently delete or repair them.

Before `addAdapter` appends/persists, and before `updateConfig` assigns/persists/stops the old instance, validate the prospective webhook namespace against all existing webhook configs, including disabled entries. Also acquire the same narrow registry ownership reservation used by live registration against every active and pending owner, regardless of type. A plugin claiming `relay.webhook.` or `relay.` must cause refusal before any config or file mutation. Exclude only the edited entry’s own prior claims; never another owner’s active or pending claims. Reject duplicate or ancestor/descendant webhook ownership using dot boundaries, not string lookalikes. A refused conflict leaves file contents, in-memory config and running old instance unchanged. Hold or transfer the operation-bound reservation across asynchronous persistence and startup/replacement, so a competing register cannot acquire conflicting ownership after the preflight check. Release only this operation’s claim on refusal/failure, without removing the previous active owner or a newer reservation. Saved-config check and mutation must also be atomic against concurrent add/edit calls. Reuse the smallest registry ownership-check/reservation seam plus existing manager queue semantics; do not introduce a generic ownership framework or serialize unrelated network work unnecessarily. Retain raw unknown/unparsed neighbors.

### 3. Routing and live ownership

A prefix without a trailing dot matches its exact subject and dot descendants. A prefix ending with a dot matches descendants only. Neither matches a lexical lookalike. Preserve longest matching prefix independent of registration order; compare actual match specificity consistently.

Reject a distinct owner claiming an equivalent normalized prefix, including `x` versus `x.` whose descendant ownership overlaps. Reject ancestor/descendant claims touching the webhook namespace. Other intentional strict prefix specialization remains allowed, particularly `relay.agent.` together with `relay.agent.codex.`, `relay.agent.claude-code.` or `relay.agent.opencode.`. A broad prefix that would overlap a webhook claim cannot bypass the webhook ownership conflict merely because its own spelling sits above that namespace.

Reserve claims synchronously before the first `await adapter.start`. Check active and pending claims. Recheck/publish the winner atomically. Release only this registration's reservation on failure; an older operation must never delete a newer reservation. Same-ID replacement excludes its previous claims but must not bypass another owner's active or pending claims. Serialize or fence simultaneous same-ID replacements so stale completion cannot overwrite or stop the newer winner. A failed replacement keeps the old active instance and routing; cleanup affects only resources acquired by the failed/new operation. Registering the identical active instance is a no-op after ownership checks: do not start it again or run replacement/failed-candidate cleanup against that same active object. Retain existing timeout/error containment. Test deferred starts rather than arbitrary sleeps.

### 4. Minimal Doc reservation

The Doc lane owns `relay.doc.<opaqueDocumentId>`; IDs may be non-UUID hashes. This ticket reserves the namespace and does not build the acceptance path. Public callers cannot assert a Doc sender, register its mailbox, send to its namespace, or use it as a reply address. Namespace predicates must respect exact dot boundaries, including the bare root where the public guard reserves it. `relay.docx.*` is distinct. Existing wildcard-reachability protections must also refuse patterns that could reach Doc addresses.

Extend the HTTP server-only sender predicate without adding Doc to consent exemptions. MCP send handlers already stamp the server-resolved identity: prove supplied `from` cannot become a Doc principal. Extend shared public destination checks and bus enforcement, and the bus's server-managed mailbox namespace list. Do not add Doc to `SERVER_DESTINATION_SENDERS`; a Doc principal must not gain permission to reach system/control destinations. Later internal typed receipt/session binding remains separate. Keep legitimate agent/human/webhook traffic compatible.

## Affected seams

- `packages/shared/src/relay-adapter-schemas.ts`, `relay-envelope-schemas.ts`, and their public relay schema exports/tests.
- `packages/relay/src/adapters/webhook/webhook-adapter.ts` and its real-adapter tests.
- `packages/relay/src/adapter-registry.ts` and registry tests.
- `packages/relay/src/lib/reserved-subjects.ts`, `relay-publish.ts` only if existing shared guard adoption is insufficient, and bus destination tests.
- `apps/server/src/services/relay/adapter-config.ts`, `adapter-manager.ts`, `initiate-consent.ts`, and corresponding tests.
- `apps/server/src/routes/relay.ts` and runtime MCP relay helpers only where current shared guards do not already cover the new rule; route/MCP tests still required.
- Adjacent runtime-neutral dispatch tests and narrow user-facing changelog/manifest guidance at delivery.

## Acceptance and proof

Start each abuse regression red on the unmodified source and record its exact intended failure. After fixing, prove restored green with nonzero collected tests. Mock only unrelated publisher/storage/transport dependencies; use the real webhook class, HMAC and relevant registry/config loader. No live model calls.

1. Forbidden agent/human/inbox/system/control/Doc/webhook-lookalike configs fail schema and real runtime startup/inbound/outbound, with no publish/fetch/timer. Valid literal/nested webhook controls still work.
2. Persisted forbidden webhook beside a valid neighbor is refused with a named error, retained raw in `unparsed`, and preserved on unrelated save. Unknown raw entries remain unchanged.
3. `x` routes exact/descendants, never `x2`; trailing-dot prefixes route descendants only. Assert exact chosen adapter and one delivery.
4. Duplicate/normalized-duplicate and webhook ancestor ownership are rejected before `start`; `x`/`x2` remain independent. Both runtime registration orders preserve longest-match selection.
5. Deferred simultaneous contested registrations admit exactly one owner; same-ID hot-replacement ordering/failure preserves the correct old/new winner, with no stale claim deletion or leaked successful instance. Re-registering the identical active real webhook leaves it connected and able to accept valid signed traffic without another start or stop.
6. Conflicting add/edit, including disabled saved webhook configs and cross-type active/pending registry claims, leaves disk, config and old running adapter unchanged. A webhook add/edit conflicting with a plugin claiming `relay.webhook.` or `relay.` is refused before persistence. Deferred persistence/start proves the held reservation excludes a competing register throughout the asynchronous gap; concurrent manager changes cannot both persist contested ownership. Assert exact file bytes, stored config, old instance identity, and that conflict triggers no old-instance stop or new-instance start.
7. HTTP Doc sender/destination/reply/mailbox attempts fail before publish/register; MCP spoofs use injected identity and Doc sends/query/dispatch mint no inbox. Bus tests refuse untrusted Doc destinations and wildcard reachability. Doc senders remain non-exempt and unable to reach system/control destinations.
8. Focused relevant shared/relay/server tests, filtered lint/typecheck and affected verification pass. Independent review reads the actual diff and intent; any resulting source change reruns relevant evidence. No implementation success claim from baseline-only results.

## Evidence state and open implementation choices

The initial preparation had no new runtime/regression evidence. Current red/green and mutation proof is recorded in `04-implementation.md`; independent final review and parent integrated gates remain pending. The parent reports an existing baseline of 250 tests and 12 server-dependency builds; these establish environment readiness only and are not DOR-2660 proof. Exact baseline commands/files/output were not supplied to this worker and must be linked from the parent's record before quoting a stronger baseline claim.

Implementation may choose the smallest existing-queue-compatible reservation mechanism. The contract, not a new generic ownership framework, is required. Shared refusal naming may preserve an existing exported symbol for compatibility while changing its meaning and every touched comment. Parent/source review must settle any current legitimate duplicate ownership exposed by the new registry checks instead of silently weakening them.
