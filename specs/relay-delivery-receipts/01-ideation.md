---
slug: relay-delivery-receipts
number: 261001-201020
created: 2026-10-01
status: ideation
---

# Durable Relay HTTP delivery receipts

**Slug:** relay-delivery-receipts
**Author:** Codex (GPT-6.1 Sol, Medium; explicitly selected by the operator)
**Date:** 2026-10-01
**Work item:** DOR-2666, Relay project
**Design gate:** Frozen after independent re-review by `/root/receipt_spec_adversarial` (GPT-6.1 Sol, Medium); design-only, delivery pending verified merge/DONE. Canonical tasks are all pending.

## 1) Intent & Assumptions

- **Task brief:** Make a detached agent-delivery failure, including `at_capacity`, observable to an HTTP publisher that supplied no `replyTo`. Preserve existing message routing and HTTP response compatibility.
- **Assumptions:** One receipt describes the matching detached agent-delivery attempt, not all mailbox copies or a business task. The existing envelope ULID is its public locator. The local SQLite database is available before a receipt-observed publish can cause delivery effects.
- **Authorization:** The operator explicitly authorized direct assignment, parallel investigation, GPT-6.1 Sol/Medium, and shared ignored worktree metadata. This design uses the separately prepared `codex/relay-delivery-receipts` worktree despite the repository default that intent stages stay in the integration checkout. Parent owns tracking and review/freeze; this author is the sole writer here.
- **Out of scope:** Private-session admission, protected source unions, durable dispatch queues, idempotent publishing, automatic resend, operator authority changes, polling UI, inference calls, implementation claims, tracker writes, commits, pushes, and PR creation.

## 2) Pre-reading Log

- `AGENTS.md`, `REVIEW.md`: isolate writers, respect private-session ownership and paid-path flags, cross the HTTP seam, prove regression tests detect their defect.
- Installed Flow `commands/flow.md`, `skills/ideating-features/SKILL.md`, `skills/specifying-work/SKILL.md`, and canonical ideation/specification/ADR templates: parent performs stage and tracker operations; author produces draft artifacts only.
- `packages/relay/src/relay-publish.ts`: validates authority before minting the ULID; rate limits and policy gates can return a message ID without dispatch; the `*` accounting row is marked delivered before detached delivery.
- `packages/relay/src/adapter-delivery.ts`: detached delivery acknowledges immediately; terminal success/failure happens later; reply failure notifications require a reply subject; holds apply only to bridged human chats.
- `packages/relay/src/delivery-pipeline.ts`, `maildir-store.ts`, `dead-letter-queue.ts`, `sqlite-index.ts`, `relay-gc.ts`, `relay-core.ts`: mailbox copies, DLQ writes, derived index rebuild, retention/recovery, and DB composition each have distinct responsibilities.
- `apps/server/src/routes/relay.ts`, `services/core/auth/session-gate.ts`, `routes/room-caller.ts`: POST is HTTP 200; `from` is caller supplied; verified ownership comes from `res.locals.user`; login-off is local trust.
- `packages/shared/src/relay-envelope-schemas.ts`, `transport.ts`, `apps/server/src/services/core/openapi-registry.ts`: request/schema, transport, and API documentation seams.
- `packages/db/src/schema/relay.ts`, `src/index.ts`, `drizzle.config.ts`: receipt metadata needs an independent authoritative table and migration; injected and standalone Relay DB paths both exist.
- `apps/server/src/services/session/private-messages/acceptance.ts`: protected sources are consumed transactionally into the session queue, authority is revalidated immediately before runtime effects, and ambiguous effects are quarantined. This is an exclusion boundary, not a reuse target.
- ADRs `0013`, `260819-034718`, `260824-120429`: Maildir truth with derived SQLite indexing, narrow capacity-hold license, and central turn ceilings/refunds constrain the design.
- Existing `research/20260224_relay_convergence.md` and `research/20260308_fix_relay_ghost_messages.md`: historical receipt/console work describes older session streaming shapes; do not restore them or conflate this HTTP bus feature with session admission.

## 3) Codebase Map

- **Primary components:** HTTP Relay route → RelayCore → RelayPublishPipeline → AdapterDelivery → adapter promise settlement. Maildir/DLQ/index retain their existing roles.
- **Shared dependencies:** Zod schemas under the `@dorkos/shared/relay-schemas` facade; Drizzle/better-sqlite3 through `@dorkos/db`; existing authenticated request identity; fake adapter registry and real temporary DB in tests.
- **Data flow:** Trusted route ownership context → authoritative minimized receipt row before delivery effects → detached handoff → compare-and-set terminal receipt → status GET. No receipt row contains payload or private-source content.
- **Feature flags/config:** No new setting, feature flag, or semver config migration. Fixed seven-day receipt lifetime from acceptance, independent of envelope TTL.
- **Potential blast radius:** Relay package, shared schema/transport, DB schema/generated migrations, server route/OpenAPI, HTTP transport facade and its mocks, Relay docs. No runtime SDK change, private admission change, UI surface, or CI gate edit.

## 4) Root Cause Analysis

1. POST `/api/relay/messages` to a registered `relay.agent.*` target while its concurrency slots are full; omit `replyTo`.
2. Detached delivery returns immediate success to the publish pipeline; HTTP returns 200 and a positive delivery count.
3. Adapter later returns `{ success: false, code: 'at_capacity' }`; it is dead-lettered, but the HTTP caller has no stable target-delivery status contract.

**Observed versus expected:** Existing acceptance can be read as successful execution. Expected: retain prompt acceptance and compatibility while giving the caller a durable, explicit way to observe this attempt's later refusal.

**Evidence:** `relay-publish.ts:523` inserts the `*` accounting row as delivered before adapter dispatch; `relay-publish.ts:660` dispatches; `relay-publish.ts:690` counts immediate adapter success; `routes/relay.ts:289` returns JSON at 200. `AdapterDelivery.deliverDetached` acknowledges immediately and settles later. `SqliteIndex.rebuild` deletes the entire derived index and only scans surviving Maildir files; successful adapter receipts cannot be reconstructed.

**Decision:** High-confidence observation/durability gap, not private admission or capacity scheduling defect. Add target-only metadata observations with independent storage; preserve scheduling behavior.

## 5) Research

1. Add receipt fields to `relay_index`: small apparent change, but routine index rebuilding deletes receipt truth and successful files are absent. Rejected.
2. Store envelope-shaped receipt copies in Maildir: survives index rebuild, but duplicates payload, risks watcher/recovery replay, and mixes metadata observation with delivery. Rejected.
3. Reuse `PrivateSessionMessageAcceptanceService`: already durable, but would widen protected source admission and incorrectly import exactly-once private dispatch promises. Rejected.
4. Add an authoritative, minimized SQLite receipt table separate from `relay_index`: preserves the existing Maildir payload decision, survives routine index rebuild and restart, and allows ownership and retention without payload duplication. Recommended with an explicit narrow amendment to ADR-0013.

Database-file corruption still loses authoritative receipt metadata; index rebuilding does not reconstruct it. A receipt is an observation, never a retry token. A crashed or unobservable attempt becomes `outcome_unknown` and is not replayed.

Independent design review identified three implementation blockers: a new epoch does not prove a prior observer dead, nested transactions cannot make pre-effect acceptance independently durable, and post-publish route errors can discard a committed locator. The revised specification resolves these with an exclusively claimed SQLite singleton observer using existing process-liveness checks, explicit caller-transaction rejection, and route-local locator capture immediately after receipt commit. Existing server instance-lock and scheduler-lock patterns were read; the former has test bypass/same-PID reclaim semantics and the latter allows heartbeat-based dual leadership, so neither is directly reused.

## 6) Decisions

| #   | Decision                       | Choice                                                                                 | Rationale                                                                   |
| --- | ------------------------------ | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | Model and parallel preparation | GPT-6.1 Sol/Medium; directly assigned separate worktree                                | Explicit operator choice and isolation authorization                        |
| 2   | Compatibility                  | Existing POST remains 200; additive `receipt` and `statusUrl`                          | Existing clients keep working                                               |
| 3   | Scope                          | HTTP `relay.agent.*` attempts only, including gates/no matching adapter                | Matches the detached seam; avoids misleading aggregate fan-out status       |
| 4   | States                         | accepted, delivered, failed, outcome_unknown                                           | Distinguishes pending observation, reported outcome, and lost observation   |
| 5   | Source of truth                | Dedicated authoritative SQLite metadata table                                          | Derived index and successful Maildir files cannot preserve history          |
| 6   | Ownership                      | Verified user ID; local-trust nullable owner; owner-only adoption after login turns on | Client-supplied subjects are not credentials                                |
| 7   | Retention                      | Seven days from acceptance, returned as expiresAt                                      | Bounded, deterministic, independent of delivery TTL and DLQ retention       |
| 8   | Recovery                       | Outstanding older-boot observations become unknown; no dispatch replay                 | Crash does not prove whether an effect occurred                             |
| 9   | Storage settlement error       | Isolate bookkeeping; attempt unknown observation; never synthesize adapter failure     | A completed turn must not become a false failed turn because logging failed |
| 10  | Workflow                       | Draft specification and ADR, independent review before freeze/decomposition            | Prepared artifacts do not authorize implementation or claim a queue slot    |

No major product ambiguity remains for drafting. The parent confirmed independent re-review convergence and authorized the completed design freeze and canonical decomposition. Implementation remains pending.

Revision decisions: one exclusive observer per actual SQLite database across cores/processes; live/unconfirmed/same-PID holders block, only proven-gone permits recovery; tracked publishing and receipt mutation refuse an active caller transaction; every structured post-insertion HTTP failure retains the original locator, including activity failures. These are correctness repairs within the authorized contract, not new product scope.
