---
title: 'Worksessions vs Claude Code Projects vs Buzz: what to take into the worksessions PRD'
date: 2026-09-18
type: comparison
status: active
tags: [worksessions, rooms, claude-code, projects, buzz, worktrees, threads]
---

# Worksessions vs Claude Code Projects vs Buzz

Compared 2026-09-18 by the DorkOS repo agent against `dorkos-worksessions-prd.md` v2 (commit `630e7a8`). Sources: Anthropic's Claude Code docs and blog for Projects (announced 2026-09-17, beta on Pro/Max, web + desktop + mobile); Buzz `main` fetched 2026-09-18 and read as code, not as vision docs. Full reports: `20260918_claude-code-projects-desktop-web.md`, `20260918_buzz-projects-what-is-built.md`.

## The three models side by side

|                | **DorkOS worksessions (PRD v2)**                                                 | **Claude Code Projects (shipped beta)**                                                                                                                       | **Buzz (shipped code)**                                                                                                   |
| -------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Unit of work   | worksession = room thread + dedicated session + worktree of the agent's own repo | thread = cloud session on its own branch and own clone in a cloud sandbox                                                                                     | none. Session is per channel; agents share one checkout root (`~/.buzz/REPOS`)                                            |
| Who opens it   | owning agent or operator; agents propose                                         | the coordinator (Claude in the project conversation) decides: inline answer, new thread, or route to an existing thread in that area                          | a person @mentions an agent in a channel                                                                                  |
| Where it runs  | your machine, git worktree                                                       | Anthropic's cloud sandbox; local threads "coming soon" (secondary source)                                                                                     | your machine, one shared cwd                                                                                              |
| Concurrency    | per-agent cap (default 3), enforced, visible queue; pool ceiling 24 (DOR-2098)   | no enforced cap; a requested limit is a preference; hard 200 new threads/day                                                                                  | 24 parallel turns per harness; pool exhausted is silent                                                                   |
| States         | open / closed / PR open but stale                                                | Working · Waiting on you · Ready for review · Landing · Idle · Resolved (auto after a week)                                                                   | Here / Waking / Unavailable (agent), not per run                                                                          |
| Outward moment | PR-open is L1; merge by card                                                     | thread opens PR when asked or on its own for concrete fixes; then watches it with auto-fix; "Merge it" is a user instruction; instructions can forbid merging | push gated at the relay by channel role + protected-branch rules; merge done by the desktop app as owner                  |
| Conflicts      | held + L1 card with the diff; never auto-resolved                                | ordinary git merge conflict; "Resolve conflicts" button sends the thread an instruction                                                                       | classified on merge; recovery refs + a terminal                                                                           |
| Approvals      | cards; verdict delivered to the session                                          | prompt lives inside the thread; "go ahead" to the coordinator does not unblock it                                                                             | `bypassPermissions` default; owner-only inbound is the real gate                                                          |
| Shared context | agent memory file; per-worksession scratch (advisory)                            | project memory (`MEMORY.md` index), 16k project instructions, repos, env                                                                                      | the nest (`AGENTS.md`, GUIDES, RESEARCH…)                                                                                 |
| People         | rooms are multi-member by design                                                 | one user per project; multi-person is a separate Slack product                                                                                                | channels are multi-member                                                                                                 |
| Liveness       | rail 15; ceilings configurable (DOR-2098)                                        | sandbox pauses between turns; if it cannot resume, fresh clone and uncommitted work is lost                                                                   | idle 900 s, max turn 2 h (up to 7 d), liveness ping, retries, crash breaker; failures posted to the channel with a reason |

## What to take from Claude Code Projects

Anthropic shipped the same shape we specified (thread = unit of work, own branch, PR as the exit, a person answers inside the thread). Six things they did that the PRD does not, in the order I would adopt them.

1. **A real state machine for a worksession.** Our PRD has open, closed and "PR open but stale". Their six states are the better vocabulary and they map cleanly: `working`, `waiting` (card or prompt pending), `ready for review` (PR open), `landing` (PR approved or queued), `idle` (finished, nothing pending), `resolved` (merged or closed; auto after N days idle). Staleness is a computed predicate over the activity clock, not a seventh state. This also gives rail 15's "every run ends in a state" a concrete enum and gives the Overview surface something to group by. **Change: req 1 gets a `state` column with this enum; req 7's sweep runs over it.**
2. **The thread keeps working after the PR opens.** Theirs watches the PR: pushes fixes when CI fails, addresses review comments, resolves conflicts, replies when checks pass. Ours stops at "PR-open is the terminal act" and waits for an external merge. **Change: new req 8b. After PR-open the worksession is `ready for review` and stays live for CI failures and review comments, bounded (N auto-fix rounds), each push a receipt. Under the ladder: amending the already-open PR is L2 with a receipt; merge stays the L1 card.**
3. **Operator affordances on the thread.** Their thread card has Resolve conflicts, Fix CI, Address comments, Merge it, Review PR, Create PR; each is an instruction sent to the thread as if from the user. Cheap for us: canned mentions into the worksession thread. **Change: W2 UI item. "Merge it" is the L1 card's Approve, not a free button (Doc 2: card controls carry a class).**
4. **Route to an existing thread instead of opening a new one.** Their coordinator sends same-area work to the thread already working there. We already check touched-path overlap at open; use it. **Change: req 1, at open: if an open worksession's touched paths overlap, the proposal offers "join that one" before "open another".**
5. **Answering happens inside the thread.** Their docs say telling the coordinator "go ahead" does not unblock a waiting thread. Ours is the same by construction (the card is the approval), but say it. **Change: one sentence in rule 4: words in a thread are never an approval; only the card is.**
6. **Pause at the container level.** Their Pause stops every thread, blocks new ones and stops routines. Our kill switch (P0-6) is global. **Change: a per-room pause (no worksession in this room runs or opens until resumed). Small, and it is the room-sized kill switch.**

Two things they do that we should **not** copy. Their concurrency cap is a preference the model follows; ours is enforced with a visible queue, which is what the ladder needs. And their isolation is a cloud clone that can fail to resume and lose uncommitted work; ours is a worktree on disk that outlives the process. **Change: state that as a tested property under the W1 gate: a reaped or crashed worksession resumes in the same worktree with uncommitted changes intact.** Their hard 200-threads-per-day is a budget rail we lack until P0-8; a daily open cap per agent is a cheap stand-in.

Vocabulary: Anthropic says **thread** for the unit and explicitly not "task" or "worktree". Our "worksession" is the object and the room thread is its home; keep both, and let the UI tab say Threads with the states above.

## What to take from Buzz

Less than expected, and the negative result is the useful one. **Buzz has no worktree model.** No entity, no table, no `git worktree` call. Every managed agent runs in one shared checkout root; the only isolation is one sentence of prompt text ("make file changes in a worktree"). Branches-as-channels is in `VISION_PROJECTS.md` and nowhere in the code. So the model Dorian described is Buzz's roadmap, not its product, and it confirms our decision to bind session and worktree mechanically (req 2) rather than by instruction.

Four small things worth taking anyway:

1. **Merge pins the reviewed commit.** Buzz's merge fetches the PR head and refuses with `branch_changed` if it is not the commit that was reviewed. **Change: our `vcs.merge` card carries the head SHA it approves; any push voids it at once, and one new card is raised when the worksession returns to `ready_for_review`.** This is the "reviewed what you merged" invariant, and it is cheap.
2. **Lifecycle couples to permission.** Archiving the channel a repo is bound to makes the repo read-only at the relay. **Change: closing a worksession revokes that worktree's `vcs.*` grant along with the receipt token (req 6).**
3. **Failures are posted where the work was asked for, with a reason.** Buzz posts "couldn't process the last request after multiple retries (the turn timed out / exceeded the maximum duration / the agent process exited); re-send if still needed". That is the copy shape for our `failed` state. And Buzz's one silent case, pool exhausted, is exactly the refused-launch test rail 15 names. Their ceilings (max turn configurable up to 7 days) match DOR-2098's bounds.
4. **Authority follows the credential owner, enforced at the transport.** Push authority at the relay derives from the channel role, and a managed agent inherits its owner's authority. That is the shipped version of "credential scope is the real boundary" (DOR-2096) and of the conventions' cross-Switchboard handoff rule.

## Proposed edits to the worksessions PRD, in one list

- req 1: `state` enum (working, waiting, ready_for_review, landing, idle, resolved). Staleness is **computed**, not stored: a predicate over `(state, last_activity_at)` the sweep evaluates, like at-risk on Goals; `resolved` after N idle days is likewise a computed transition. Open-time overlap check proposes joining an existing worksession.
- req 2: worktree outlives the process; resume in place with uncommitted changes intact (tested, under the W1 gate).
- rule 4: words in a thread are never an approval; only the card is.
- req 6: close revokes the receipt token and the worktree's `vcs.*` grant.
- req 7: sweep runs over the state enum and the activity clock; stale = `ready_for_review` with no activity for N days.
- **new req 8b**: after PR-open the worksession stays live: CI fix, review comments, conflicts, bounded rounds, each push a receipt at L2; merge stays L1; the merge card pins the head SHA. **Void on every push; re-raise once**, on the transition back into `ready_for_review`, so one merge costs one card. Auto-fix rounds exhausted → `waiting` with a card, never `failed`.
- W2: canned thread actions (Fix CI, Address comments, Resolve conflicts, Create PR); "Merge it" is the card; per-room pause.
- Platform PRD P0-6 (kill switch): add per-room pause. Cards v2: merge cards carry the commit they approve.
- Non-changes, stated: enforced cap not preference; local worktrees not cloud clones; multi-member rooms not single-user projects.
