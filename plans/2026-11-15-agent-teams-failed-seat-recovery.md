# Bounded recovery for a prior failed room seat

DOR-4328 implements one fresh Claude room session for different new work after an affirmatively identified prior server failure. It preserves the old transcript, the actual account and bill, current guards, and one public seat. Generic historical or prestart failures remain outside the supported classifier and require Code's incident QA before any DOR-3556 closure.

## Current implementation base and ownership

The preparation branch is `codex/at-dor-4328`, stacked on checked DOR-4472 commit `47674f1ed6efe86e71526dd4bcb10b262ba2a70b`. Its planning seed was `068ce3374bef614b4905d0cc06f09a4cad753852`; that seed is historical, not the implementation base. Before integration all 61 authored paths were preserved with SHA256 manifest, tar and binary patches in the ignored worktree checkpoint. The parent is not copied draft source. Root must reconcile the parent merge/base before a recovery PR opens.

Root coordinates the tracker, claims and PR. Code owns Security routing, reviewer labels, arming, releases and Done. Source, tests and migration are authored in the claimed worktree. No live agent files, model calls, app ports, external messages or verified-native prewrites are part of this work. Execution remains resource controlled: one worker, small tests at fresh load <=40, compilers/lint/hooks at <=16, unknown load refuses.

## Supported behavior

An own spin-off keeps its real caller identity and may submit allowed words to its parent's room through the existing posting gate. This slice characterizes that actual path; it does not introduce a new permission exception or broaden chat origins.

An ordinary handoff may replace a prior failed seat only when all of the following are known:

- The most recent complete room dispatch contains a structured Claude SDK `server_error`, a correlated failed terminal and no later turn.
- Producer correlation identifies that dispatch and exact persisted start/end watermark. A generic `error_during_execution`, an arbitrary marker or error text is insufficient.
- The existing native transcript is intact and stable during the check. Recovery does not delete or rewrite it and never resubmits its old task.
- Actual SDK init facts and a validated launch route establish the previous runtime, root, inference choice and subscription/per-token bill. Current named-account resolution must still identify that exact root; display fallback is not authority.
- No current pause, protected refusal, pending interaction, background/helper work, crash-loop, account/sign-in/usage problem or guard ambiguity permits an escape through a new id.
- The held handoff still owns the same room/member/seat and original deadline. The old binding and failure watermark still match at publication.

The shared seat mover prepares settings and marks, then atomically publishes the immutable requirement, destination metadata reference, source-failure consumption and expected-seat CAS. One handoff gets one fresh attempt; a refusal or fresh failure settles honestly without another recovery layer. Normal busy waiting does not renew the original deadline or reset the attempt.

## Durable destination constraint

The approved schema has **one** `room_seat_launch_requirements` table plus server-only `session_metadata.requiredLaunchId`. Normal Drizzle generation against the checked parent's journal created `20261116022724_smart_revanche`; no migration slot was reserved. Generated uniqueness covers destination, source dispatch and source/end watermark. Downgrade refuses while retained constraints or references exist.

The reference belongs to the destination conversation, not its current room seat. Required runtime/root/inference/billing survive settlement, canonical aliases, unseat, direct sends and resumes. Every applicable Claude launch checks final merged routing and host authentication before SDK effects. Unsupported alternate backends are refused; environment clearing or forced credentials are not substitutes for proof. Required credits do not fall back to a personal sign-in.

A pending constraint needs the current process-owned dispatch token. Restart loses that token and leaves a blocked tombstone, not a replay. Alias conflicts refuse; an addressable old alias retains its constraint. Optional runtime persistence failure may retain the legacy streaming policy, but a required identity failure remains mandatory and propagates through native rebind.

## Preserving the first fresh turn

The current recovery captures the old turn's positively recorded effective bounds and marks before async placement or a new runtime turn can replace them. Unknown recorded authority refuses. The first fresh request joins those facts with immutable incoming and current carry; a later `prepareCarry` callback cannot erase them. `outsideWords` alone does not manufacture a permission cap. Existing explicit/person-set bounds remain and trusted configured defaults are not changed.

The shared mover preserves model, effort, mode and fast mode for this same-runtime recovery. Fast mode preservation is recovery-specific so ordinary account/runtime moves retain their established behavior. Parent DOR-4472 target validation, canonical aliases, immutable/current carry, `strangerMarkForShown` and sole post-placement budget reservation remain intact. The parent's 16-hour single-turn and continuous-busy guard is preserved. Its limit, ceiling, eviction and shutdown results never qualify as server-error recovery.

## Implementation areas

- Claude SDK witness mapping, actual init billing observations and per-turn reset live inside the Claude adapter.
- The strict reader uses real event-store boundaries without treating normal sparse record-mode sequence gaps as missing evidence.
- `failed-seat-candidate` combines the persisted witness, live producer/account facts, intact transcript and current guards.
- `seat-replacement` is the existing mover's shared replacement primitive; recovery uses the requirement store's atomic CAS publication rather than a second mover or account failover.
- `failed-seat-recovery` owns one handoff's replacement/carry and pending-attempt cleanup.
- The common Claude launch boundary enforces final configuration on first and later launches. Native rekey retains mandatory constraint propagation; future checked DOR-3816 shared-transaction composition must preserve this owner, not copy its draft or run a second callback authority.
- Decline formatting and bounded server correlation retain protected failure codes without exposing raw drafts, credentials or errors in room copy.

## Executed evidence and its limits

The following targeted checkpoints executed under the bounded controller. They are not a claim that the entire current dirty branch is verified; subsequent source changes require their appropriate reruns.

| Oracle                         | Executed checkpoint | What it proves                                                                                     |
| ------------------------------ | ------------------- | -------------------------------------------------------------------------------------------------- |
| SDK terminal witness           | 19/19 passed        | Structured producer rules, billing-route controls and actual retirement-result negatives           |
| Strict SQLite reader           | 13/13 passed        | Actual SDK mapper -> normalizer -> record projector/store and strict historical refusals           |
| Required-launch store          | 11/11 passed        | Atomic publication/rollback, pending ownership, aliases and retained constraints                   |
| Final Claude configuration     | 3/3 passed          | Exact root/bill/inference and refusal after settlement                                             |
| Registered migration/downgrade | 2/2 passed          | Actual schema constraints and no downgrade that unlocks retained requirements                      |
| Real Claude constructor/pump   | 1/1 passed          | Actual runtime, SDK mapping, persisted witness and observed billing; only external SDK query faked |
| Scripted replacement fixture   | Earlier 5/5 passed  | Real room service, mover/CAS, SQLite/JSONL, one post and preservation; runner remains scripted     |

The full production oracle uses real `RoomService`, production `RoomTurnRunner`, real `ClaudeCodeRuntime`/`SessionStore`/`PersistentDispatch`, real temporary SQLite/JSONL and only a fake external SDK query. The last executed version reached one replacement/post and passed SDK-option, old-history, settings and marks assertions, then failed its strict settled-state assertion. The fake had posted but emitted no main-thread completion, so production correctly ended the turn failed and refused the constraint. The amended SDK stream now emits real streaming/result shapes, keeps the strict settlement expectation and adds the actual pause control. That amendment is pending execution.

New current-account qualification and own-child gate characterization fixes also require reruns. Import failures and a missing native SQLite binding were setup failures, never behavioral red proof. The package compiler was resource refused rather than run above its limit. No full VERIFY, mutation proof or final review is claimed.

## Remaining gates before PR

1. Execute the amended production replacement oracle and protected pause control. Inspect exact SDK session/root/resume/fork options; do not let the fake accept arbitrary options or weaken settlement.
2. Run the unknown-account control red/green, own-child actual session-start/gate cases and affected targeted regressions, including the parent private inbox/scope/mark suite.
3. Run discriminating mutation proof at failure classification, immutable launch enforcement, CAS and first-fresh carry seams; restore and rerun each positive.
4. Run appropriate package compiler, lint, formatting and line-ratchet checks when load permits. The server compiler uses the required 8GB heap. Review generated SQL and current integrated journal again after parent/base reconciliation.
5. Obtain independent code/spec and Security reviews on the exact checked change. Keep the PR held with deep review; Flow VERIFY runs during Code review/merge under the agreed resource owner.
6. Code performs the real reported-incident and room/mobile copy QA. Generic historical/prestart DOR-3556 acceptance remains open until the incident shape matches supported evidence.

No operator permission-to-ship question is needed. Existing standing authorization and the technical review gates govern the handoff.
