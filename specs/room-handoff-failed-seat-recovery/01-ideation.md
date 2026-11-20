---
slug: room-handoff-failed-seat-recovery
number: 261115-200450
created: 2026-11-15
status: ideation
---

# Room hand-offs recover a failed seat and explain a refusal

> Initial discovery log retained for context. Active design is revised02 and06 after independent review: intact-transcript prior Claude server_error, reuse existing mover, generic historical acceptance open. Earlier native-stranded/four-runtime proposal is superseded.

**Slug:** room-handoff-failed-seat-recovery
**Author:** Codex, workhorse gpt-6.1-sol
**Date:** 2026-11-15

## 1) Intent & Assumptions

- Task: DOR-4328, targeting DOR-3556 requirements, with unresolved generic failure acceptance explicit. A verified agent's own spin-off can ask its parent room seat to post without an extra permission card. A failed seat recovers once on a fresh session; a declined hand-off always gives a useful reason.
- Pinned base: `a23056f0a528393a9f3eea312c516ed8660f77b6`; worktree seed `068ce3374bef614b4905d0cc06f09a4cad753852`. Source analysis is against that base. DOR-4472 B+C is a prerequisite still being built elsewhere; re-read its final SHA before implementation.
- This is design only, pending root review. No source changes, tests, dependencies or runtime operations in this pass. Root owns tracker/PR coordination; DorkOS Code owns Security routing, reviewer labels, arming, releases and Done.
- “Without a card” means an unnecessary platform/tool approval for ordinary conversation. It never bypasses a caller's actual outside bounds, a blocking interaction, pause, account pin, usage, crash-loop protection or room budget.
- Keep one active seat per `(room, agent)`. Own spin-off submits to the seat; it never becomes a second room voice.
- Out of scope: direct room posting from a non-seat chat, new target origins, bridge Telegram/Slack writes or switches, heartbeat/schedule behavior, changing accounts, unlimited retries, room completion notifications (DOR-4473), measurement (DOR-4471), live agent edits.

## 2) Pre-reading Log

- AGENTS.md, meta north star, PROACTIVE-AGENTS and etiquette: trusted colleagues, quiet useful rooms, existing loop guards stay, no new routine output caps.
- `.temp/coord/codex-agent-teams/README.md` and Security design: agreed sequence; chat_send remains private aside-only; outside marks, budget, initiating-message and prompt-defusing invariants persist. Parent's explicit current instruction overrides copied obsolete PR cap, but PRs remain hold + review:deep.
- Flow ideating-features/specifying-work/decomposing-work scaffolds: artifacts on disk; tracker writes remain parent-owned. Tasks prepared inline in this bounded design delegate, with no further agents.
- `.claude/rules/server-structure.md`, room-conduct.md, testing.md and room-participation spec: existing domain placement, one working transcript, claim serialization and visible refusal.
- Snapshot's complete DOR-4328 and DOR-3556 descriptions: not just overlapping titles; 3556 adds pre-start recovery, failure logging with session id and bounded second failure.
- `research/20261017_core-skills-recommendation.md`: silent failures require useful status and recovery; no new external research needed.

## 3) Codebase Map

- `rooms/handoff/room-handoff.ts`: serial per-seat hand-offs, original caller carry, handoff id/status, seat-only post rule and result reporting. `declineReason` has no failed branch; catch logs but loses the cause. File already >500 physical lines: split new policy/helpers rather than grow it.
- `rooms/room-trigger/aside.ts`: membership/liveness check, per-agent busy ceiling, budget reservation, real claim, room placement, runner call and finally release. It drops `RoomTurnReply.failure`; catch collapses pause/runtime refusal into failed. These distinctions must survive before any recovery is safe.
- `rooms/room-turn-port.ts` + `turn-guards/turn-waits.ts`: existing typed failure detail/refusal. Missing explicit safe-to-retry evidence; `failure.refusal` includes protected pre-start refusal categories.
- `room-turn-runner.ts`: knows dispatch identity and whether matching `turn_start` was stamped. That event is synthesized before the runtime is asked: it is not proof a model ran. Preserve both accepted/started observation and authoritative typed refusal. Runner exceeds line ratchet, so extract any new collector/failure helper.
- `rooms/session-bindings/room-session-ledger.ts`: one current binding, retired aliases for _renames_, separate `recordSeatMove` for actual replacement. Recovery must use seat move bookkeeping, never a rename alias that makes old session current again.
- `rooms/room-trigger/reseat.ts`, `reseat/seat-mover.ts`: precedent for claim-held replacement, level/settings preservation, Activity. Existing account/usage re-seating must not become a shortcut for generic failure.
- `runtimes/claude-code/mcp-tools/session-tools.ts:450-466`: session_start sends agentPath and marks. `session/launch/launch-session.ts` owns durable forAgent resolution; `launch-resolver.ts:248,811` uses the same verified identity anchor for tool server and autoallow.
- `runtimes/claude-code/tool-gate/auto-allow.ts:394-413`: post_to_room already identity-scoped. `rooms.post` has area:null. The report's card cannot safely be fixed by a global new allowlist. First reproduce with actual child launch, worktree cwd and permission mode.
- Tests: room-handoff, room-power-downstream, seat-report, room-turn-runner, room-session-ledger, session-tools, real capability/tool-gate harnesses. DOR-4472 owns seat DM paths; don't fork their policy.

## 4) Root Cause Analysis

1. An agent posts from a non-seat chat. The gate creates a hand-off and returns an id.
2. Existing failed seat gets an aside, which fails. AsideResult discards failure details and yields null text.
3. declineReason misses failed and returns “it gave no reason.” No fresh-seat path exists for this hand-off.
4. A thrown exception can leave `result === null`, incorrectly described as no room history. A pause error can be mislabeled as failure.

Confirmed from source: failure reason loss and missing recovery. Own-spin-off permission cause is **not confirmed**: current launch and identity-autoallow look correct for a properly bound child. The implementation must first prove whether the bug is missing identity propagation, runtime-specific gating, or a protected refusal mistaken for a redundant card. Never invent red evidence for an already-correct case.

## 5) Research

1. Let child post directly: shortest path, but breaks seat freshness, single voice and room bounds. Rejected.
2. Catch every failure and mint a fresh session: hides guards and may duplicate side effects. Rejected.
3. Keep seat submission; preserve typed failure/refusal, recover only affirmative safe failed-seat cases once under the same claim, then explain every terminal failure. Recommended.

Recovery uses current room context, original draft/thread and original marks joined with room marks; preserves same agent, runtime, account choice and no-looser level. No budget refund or extra mode. Unknown eligibility fails closed to useful explanation.

## 6) Initial Decisions

| Decision               | Choice                                                                   | Rationale                                                                                      |
| ---------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Second public voice    | No                                                                       | Only current seat calls post_to_room; child keeps handoff status.                              |
| Retry count            | One fresh-session recovery per hand-off                                  | Preserve DOR-3556; second failure stops. Busy waiting is separate and keeps existing deadline. |
| Failure classification | Typed facts, not error-text regex                                        | No retry on pause, interaction, account/usage or budget refusal.                               |
| Replacement authority  | Claim-held current-seat compare and durable move record                  | Prevent competing triggers and old session resurrection.                                       |
| No-card scope          | Verified same-agent child, ordinary conversation, same membership checks | Avoid general permission bypass and preserve outside policy.                                   |
| Ambiguous cases        | Root/Security review before code                                         | See specification open questions; recommendations are explicit.                                |

## Source-audit refinement

05-recovery-evidence.md closes the typed-evidence discovery question. No runtime-neutral historical failed-session reset grant exists. Only strict native-stranded probes may authorize new room replacement; existing Claude hasTranscript and OpenCode getSession are lossy, Codex already owns real native recovery, and Doe has no qualifying automatic-reset contract. Adapter-backed tests, not a fake recoverable flag, gate closure. No source work or tests occurred.

## Independent audit revision (active direction)

The initial native-stranded-only proposal did not satisfy the reported failed seat with intact transcript. Do not use deleted-native fixtures or fake eligibility to claim DOR-3556 closure. Root approved a narrower actual Claude SDK server_error witness in the latest complete prior failed room dispatch, intact transcript and proven actual account/current guards, for a new different hand-off. Generic historical failures remain open pending Code incident-shaped live QA. Reuse/strengthen RoomSeatMover.reseat with same runtime/account/inference and expected-old-binding CAS. Four-runtime continuation API/OpenCode expansion are not active scope. Read revised02 and06; earlier05 is historical audit only.
