# DOR-2660 implementation tasks

Canonical source: [03-tasks.json](03-tasks.json). Approved bounded scope: [02-specification.md](02-specification.md). Execution released by the parent after the verified isolation merge and Flow claim.

One originating implementation worker; no parallel writers. Dependency order: 1.1 → 1.2 → 1.3 → 1.4. No promoted subissues or tracker writes. The execution release and focused evidence are recorded in [04-implementation.md](04-implementation.md).

## Task 1.1: Write red namespace regressions and implement shared webhook/Doc guards

Phase: Shared policy and public reservations. Size: medium. Dependencies: none. Status: completed (including corrected bare Doc root wildcard red/green and mutation proof).

First demonstrate forbidden webhook namespace/schema cases and public Doc sender/destination/mailbox abuse against current source. Implement one positive literal webhook namespace policy with the existing token grammar/ceiling and one exact-boundary Doc reservation. Extend HTTP server-only sender, shared destination reachability and bus mailbox guards through existing callers. Preserve MCP injected identity, consent semantics and trusted sender list: never add Doc to consent exemptions or SERVER_DESTINATION_SENDERS. Prove lookalike positive controls and wildcard refusal. No UUID constraint on Doc IDs. Scope public errors/copy to existing paths.

## Task 1.2: Prove boundary routing and reserve active/pending ownership safely

Phase: Live registry ownership. Size: medium. Dependencies: 1.1. Status: completed (including identical active-instance no-op with real webhook/HMAC red/green and mutation proof).

Write red real-registry regressions for x versus x2, trailing-dot semantics, normalized duplicate claims, webhook ancestry, and deferred contested starts. Implement exact-or-dot matching with longest prefix selection. Refuse ambiguous duplicates and overlapping webhook ownership before start; retain intentional runtime-specific specialization in both orders. Reserve claims before await, release with operation identity, preserve old instance on failed hot replacement, and fence concurrent same-ID replacement completion. Assert exact winner, no stale reservation deletion and no leaked acquired instance. Keep existing startup timeout behavior.

## Task 1.3: Refuse persisted and prospective invalid webhook ownership without mutation

Phase: Configuration and real webhook defense. Size: medium. Dependencies: 1.1, 1.2. Status: completed (including real nested/sibling inbound and outbound HMAC, startup edit and credential/header compatibility proof).

Write red persisted-union-bypass and real WebhookAdapter defense tests. Validate only persisted webhook entries by their own schema; preserve unparsed raw entries, unknown neighbors and valid neighbors during reads/saves. Apply shared policy to real start/inbound/outbound before effects. Write red manager create/edit conflicts and concurrent ownership attempts, including disabled saved webhook entries and active/pending non-webhook registry owners claiming relay.webhook. or relay.; refuse before file/in-memory mutation, old-instance stop or new-instance start, with edit-self exclusion. Acquire the same narrow registry ownership reservation before mutation and hold/transfer it across asynchronous persistence and startup/replacement. Use deferred persistence and competing registration to prove no check-to-use gap; operation-bound cleanup must not remove the old active owner or a newer claim. Reuse the smallest registry reservation seam and existing queue semantics to make saved-config check+mutation atomic; no generic framework. Assert unchanged exact file bytes, stored config and old instance identity on ownership conflict. Valid nested/sibling webhook controls must still start, publish and deliver using real HMAC.

## Task 1.4: Verify bounded namespace fix and record evidence for independent review

Phase: Verification and review. Size: medium. Dependencies: 1.3. Status: completed; fresh local affected verification passed and review evidence is prepared. Exact-pushed-head quality review, PR and verified delivery remain parent-owned follow-ups.

Run focused relevant shared/relay/server tests with meaningful nonzero counts, package-filtered lint/typecheck and affected verification. Record exact red failures and restored green results. Independently remove the boundary/namespace/reservation protections where necessary and prove the intended regressions fail, then restore exact source. Keep existing 250-test/12-build baseline separate from new proof; no paid inference. Inspect actual diff for unauthorized changes, unknown-neighbor retention, runtime compatibility and Doc trust broadening. Add only narrowly scoped required changelog/manifest guidance. Independent review and PR/tracker/delivery are parent-controlled follow-ups, not authorized by preparation. Do not implement Doc acceptance or the other supporting tickets.
