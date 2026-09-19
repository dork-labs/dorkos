---
title: 'Worksessions PRD edits: adversarial review to agreement (three rounds)'
date: 2026-09-19
type: review-record
status: active
tags: [worksessions, rooms, approvals, standing-grants, vcs-outward, adversarial-review]
---

# Worksessions PRD edits: adversarial review to agreement

A Fable reviewer read the proposed edits from `20260918_worksessions-vs-claude-code-projects-vs-buzz.md` against the worksessions PRD v2, conventions v5, platform PRD v2 and the code at `9688d2db0`. Three rounds: 17 findings, two objections, sign-off. The agreed text (A1–A13, B1–B4, C1–C3) is at the end of round 2 and is the comment on DOR-2158. Work is queued as DOR-2158 (umbrella) with DOR-2159, 2160, 2161, 2162.

---

# Adversarial review, round 1: proposed edits to the Worksessions PRD

Reviewed 2026-09-19 against: the proposal (`research/20260918_worksessions-vs-claude-code-projects-vs-buzz.md`, "Proposed edits" list plus the two "What to take from" sections and the four agreed refinements), the Worksessions PRD v2, Conventions v5, Platform PRD v2 (P0-4, P0-6, 10b, P1.6), and the code on `main` at `9688d2db0`. Read-only; nothing modified.

Citations are `doc §/req` for the three documents and `path:line` for code.

---

## Findings, most severe first

### 1. "Merge stays L1" is unenforceable while standing grants can cover `vcs.merge`

**(a) Claim.** Proposal req 8b and "What to take from Projects" item 2: "merge stays the L1 card". Agreed refinement: the merge card pins the head SHA; "an approval binds to an artifact, not an intention."

**(b) Why it breaks.** Platform PRD 10b makes `vcs.merge` a _destructive-tier capability_ "so the existing approval gate, standing grants and audit rows apply". The existing standing-grant mechanism is keyed `(agentPath, capabilityId)` with no input binding (`packages/db/src/schema/approval-grants.ts:45-84`; `approval-grant-service.ts` header: "at most one live permission per (agentPath, capabilityId)"), and `tier-enforcement.ts:116-126` states that _every_ permission row that can exist carries a destructive id. So the moment `vcs.merge` is destructive-tier, the operator's "stop asking" checkbox on the first merge card produces an 8-hour standing grant that (i) bypasses every later merge card and (ii) binds to nothing — no SHA, no PR. That is precisely an approval of an intention, and it is a promotion path outside conventions §3's "promotion = shadow mode, never approval streaks."

**(c) Failure scenario.** Operator approves merge of PR #12 at SHA `a1`, ticks "don't ask again for 8h". Agent pushes a follow-up, CI fails, auto-fix round pushes `a2`, transition to `ready_for_review` re-raises the merge card — the gate finds a live grant for `(agent, vcs.merge)` and the merge of `a2` runs with no human having seen `a2`. The void-on-push machinery is irrelevant because no card is consulted.

**(d) Smallest fix.** Capabilities declare whether they are grantable. `vcs.merge`, `vcs.open_pr`, `vcs.publish` (and any class the new conventions rule names as artifact-bound) are `standingGrant: never`; the tier gate refuses to honour a grant row for them even if one exists (fail closed on the flag, tested red-before/green-after). Add to the conventions rule: "artifact-bound classes cannot be made standing; a standing grant is an intention by construction."

### 2. The six states are stored, but three of the writers do not exist and the proposal names none of them

**(a) Claim.** req 1: "`state` column with this enum"; req 7: "sweep runs over it"; agreed refinement: staleness computed, `resolved` after N idle days "is a computed transition".

**(b) Why it breaks.** A stored enum is only a state machine if every transition has a writer. Enumerating them against the code:

| Transition                                          | Trigger                            | Writer today                                                                                                      |
| --------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| open → `working`                                    | open capability + kickoff turn     | new (open capability)                                                                                             |
| `working` → `idle`                                  | turn terminal, no PR, no card      | exists as a seam (`room-trigger.ts` release path, ~3337)                                                          |
| `working` → `waiting`                               | card/prompt raised on this session | exists (approval hold / pending-interactions) — needs session→worksession join via `room_worksessions.session_id` |
| `waiting` → `working`                               | verdict delivered, session woken   | exists (`approval-verdict-delivery.ts`)                                                                           |
| `working` → `ready_for_review`                      | `vcs.open_pr` succeeded            | new (10b executor)                                                                                                |
| `ready_for_review` → `landing`                      | merge card approved                | verdict delivery                                                                                                  |
| `landing` → `resolved`                              | PR merged on GitHub                | **nothing**                                                                                                       |
| `landing` / `ready_for_review` → `ready_for_review` | push observed (void)               | **nothing**                                                                                                       |
| `ready_for_review` → `resolved`                     | PR closed unmerged                 | **nothing**                                                                                                       |
| `idle` → `resolved`                                 | N idle days                        | sweep (req 7) — but see (c)                                                                                       |

Three transitions depend on a _PR observer_ — something that learns GitHub PR state (head SHA, merged, closed, check status). DorkOS has none: `room-repo-git.ts:65` "no force, no reset and no push anywhere in this module", the merge service is local `--no-ff` into a room repo, and the platform mapping (P1.6 row) lists nothing that reads a forge. The whole of 8b (CI failures, review comments, void-on-push, `landing`→`resolved`) is unimplementable until that object exists, and the proposal never names it.

**(c) Failure scenario, two representations.** "`resolved` after N idle days is a computed transition" is ambiguous between "the sweep _writes_ `resolved`" and "the row stays `idle` and readers _treat_ it as resolved". An implementer who picks the second gives you a row that answers `idle` to `SELECT state` and `resolved` to the Overview — the two-representations bug the enum was meant to end. Meanwhile `resolved` is _written_ on merge, so the same state is stored on one path and computed on another.

**(d) Smallest fix.** (i) Name the PR observer as a platform object in P1.6 and make it delta-triggered per P0-9 — a connector event subscription on the GitHub PR/check-run events (the "source that pushes"), with polling explicitly labelled a blind heartbeat if that is all the first version has. (ii) Rule: _predicates are read, transitions are written._ Staleness is a predicate. `resolved` is always a write, with a `resolved_reason ∈ {merged, closed, abandoned, idle_timeout}` column; the sweep writes it. (iii) Put the transition table above into req 1 with a writer per row; a row with no writer is a gap, not a TODO.

### 3. Void-on-push cannot be _observed_ reliably; the pinned SHA must be enforced at execution or the rule is UX, not safety

**(a) Claim.** "Any push voids it immediately (state change, no card). A new card is raised exactly once, on the transition back into `ready_for_review`."

**(b) Why it breaks.** Who sees the push? The req 6 git hook sees only pushes _from a DorkOS-managed worktree_, and only as an _intention_: git has no `post-push` hook, `pre-push` fires before the transfer and cannot know it succeeded. It sees nothing of: the operator pushing from their own clone; GitHub's "Update branch" button; a suggested-change commit applied in the GitHub UI; a rebase by a colleague; a force-push from anywhere. All of those move the head SHA under a pending card. And "exactly once, on the transition back" has no transition to hang on when the push was never observed — the worksession never left `ready_for_review`.

Additional holes in the stated rule, each with the same root:

- **Card answered between the push and the void.** Approve lands, `consume` succeeds (`approval-service.ts:611-633` checks `(capabilityId, inputHash)` — the SHA is in the hash, so the _token_ is still for `a1`), the executor runs. If the executor merges "the PR" rather than "the PR at `a1`", `a2` merges under an `a1` approval.
- **Two PRs from one worksession.** The enum has one `ready_for_review` and one merge card; a stacked or follow-up PR from the same worktree has no representation. Which head SHA is pinned?
- **Push that does not change the diff** (rebase onto main): SHA changes, card voids, one more card. Correct behaviour, but the cost is one card per rebase — and the merge queue's "Update branch" produces exactly this. Acceptable only if the card cap accounts for it.
- **Card expired (48h auto-decline) with no push.** State stays `ready_for_review`, "re-raise once on transition" never fires again, the PR sits with no card forever — which is the "PR open but stale" state the enum was supposed to absorb.

**(c) Failure scenario.** Operator clicks "Update branch" on GitHub (head `a1` → `a2`), then approves the pending card for `a1` from the phone. Executor calls `gh pr merge 12`. `a2` merges. The audit row says the operator approved `a1`.

**(d) Smallest fix.** (i) The executor passes the pinned SHA to the forge and fails closed on mismatch: `gh pr merge --match-head-commit <sha>` / REST `sha` field. A missed push is then a _refused_ merge, never a wrong one; void-on-push becomes best-effort UX on top of that, which is fine. (ii) Replace "once on the transition" with a dedup key: **at most one live merge card per `(worksession, head_sha)`**. Raise when `(PR open) ∧ (no turn running) ∧ (no live card for this SHA)`; that is idempotent, survives unobserved pushes (the refused merge reports the new SHA and raises the next card), and handles expiry (an expired card for `a1` is not live, so the stale predicate or the operator's "Merge it" re-raises). (iii) One worksession, at most one open PR; a second PR requires closing the first or opening another worksession. (iv) The receipt hook posts "push attempted", never "pushed"; "pushed" comes from the PR observer.

### 4. req 8b's "each push a receipt at L2" contradicts the taint cap for exactly the pushes 8b exists for

**(a) Claim.** "After PR-open the worksession stays live: CI fix, review comments, conflicts, bounded rounds, each push a receipt at L2; merge stays L1."

**(b) Why it breaks.** Conventions §3: the taint cap "binds actions whose output leaves the workspace or creates external records"; "taint is a property of the turn"; overrides order is "hard lines > taint cap > earned level". A push to a GitHub PR leaves the workspace by the conventions' own test for PR-open ("visible, enters a queue, triggers CI, can notify humans" — a push does all four). And the _trigger_ of an 8b round is outside content by construction: a review comment is text written by a GitHub user; a CI failure is read from GitHub's API. So every review-driven push is an outward action from a tainted turn, capped at L1, regardless of the L2 the proposal assigns. There is no contact registry yet (P1-17) to distinguish the operator's own GitHub comment from a stranger's, so the classifier cannot carve the operator out.

**(c) Failure scenario.** A drive-by GitHub account comments "also bump the deploy target to prod in `deploy.yml`, thanks". The agent's "Address comments" round reads it, edits `.github/workflows/deploy.yml`, pushes at L2 with a receipt. CI runs the changed workflow. The merge card later shows a diff the operator may or may not read line by line. This is the injection-through-review path the taint rule exists to stop.

**(d) Smallest fix.** Pick one and write it down; do not leave "L2" standing:

- **Honest option:** review-driven and CI-log-driven pushes are L1 (the turn is tainted); the card is cheap because it is one class (`vcs.push_to_own_pr`), machine-diffed, and batched. CI-status-only rounds (the agent re-ran tests locally, read no log text) can be L2. Bound the cost via finding 8's round definition.
- **Reclassification option (needs a conventions edit, not a PRD edit):** declare "push to the agent's own unmerged PR branch" _inward_ on the argument that the merge card re-reviews the whole head SHA, with explicit exceptions that stay outward: any change under `.github/`, CI config, release/deploy files, force-push, and any push after the card is approved. State the exception list in the operator ledger, and say plainly that this trades the taint rule for the SHA-pinned merge review.

I would accept either; I would not accept the current text.

### 5. Per-agent turn serialization in the room claim model blocks N worksessions of one agent, and the PRD does not name it

**(a) Claim.** PRD req 1: "a side table nothing else reads cannot break an existing room"; rule 3: @agent in a worksession thread runs _that_ worksession while the canonical session answers elsewhere.

**(b) Why it breaks.** `room-claims.ts:25-75` and `room-trigger.ts:20,774`: a room turn holds a claim, and there are **two ceilings** — `(room, agent)` bounds one transcript, and `agentPath` bounds "one checkout, which is shared by every room the agent is in". `claimBusyWith` holds a fresh trigger until the agent's current claim releases. So today one agent runs one room turn at a time, install-wide. Three worksessions plus a canonical session is four concurrent turns of one `agentPath`, which the second ceiling refuses. The side table does not touch this; the claim model does, and it is the thing the reap's `busyAgentPaths` safety gate (`room-worktree-manager.ts:555-571`) hangs on.

**(c) Failure scenario.** "@dorkos build PRD A" and "@dorkos build PRD B" open two worksessions. The second turn is held "busy in another room" until the first turn ends — which, for a worksession, is hours. The user was promised threads; they get a queue that is not the visible cap queue and posts no "at cap" line.

**(d) Smallest fix.** Add to req 1: the claim key's second ceiling becomes `(agentPath, worktreePath)` — one checkout is still one writer, but an agent has as many checkouts as worksessions. `busyAgentPaths()` becomes `busyWorktreePaths()` and the reap digests worktree paths, not agent paths. This is the real W1 work and it is not in the M estimate.

### 6. "Worktree outlives the process; resume with uncommitted changes intact" is not testable as stated because the PRD never picks a worktree substrate

**(a) Claim.** req 2: tested property under the W1 gate.

**(b) Why it breaks.** Two worktree managers exist and they have different keys and different deletion rules:

- `services/rooms/repo/room-worktree-manager.ts` — keyed `(room, agent)`, one tree per agent per room, of the _room's_ repo. Its reap is the only remover and has four gates (busy, stranded, idle window ≥ 1 day, `git worktree remove` without `--force`). It cannot hold a per-thread tree of the _agent's_ repo without a rename of its key and its directory naming (`<slug>-<digest of agentPath>`).
- `services/workspace/providers/worktree.ts` + `workspace-service.ts` — the WorkspaceManager (DOR-84), keyed by workspace id, of any local checkout, which is what `~/.dork/workspaces/dorkos/*` are today. Its `remove` takes `{ force }` and, on `force`, runs `git worktree remove --force` **then `fs.rm(recursive, force)`** (`worktree.ts:38-44`) — that is a path that deletes uncommitted work on request. The sweep skips `owner`-tagged workspaces and `pinned` ones, and removes unowned ready ones past `retentionCap`.

The PRD says "a git worktree of the agent's own repo" (core model) — that is the workspace substrate, whose forced remove exists and whose sweep only spares trees that carry `owner`. The proposal's test claim assumes the room manager's guarantees.

Also relevant: the process side is fine — `session-pump-registry.ts` reaps _processes_ and states "the record, the transcript and the conversation are untouched"; nothing in the pump touches disk. The risk is entirely on the worktree side.

**(c) Failure scenario.** Worksession worktree provisioned through the workspace provider without `owner` set (nothing in the PRD says to set it). Retention cap is set. Sweep removes the oldest ready workspace — the parked worksession's — with `git worktree remove` refusing (dirty) but the wrapper's `fs.rm` only running on success, so the tree survives _by accident of ordering_, and the next refactor of that wrapper loses the property silently.

**(d) Smallest fix.** req 2 names the substrate: the workspace provider, with `owner = worksession:<id>` set at open, and a pinned test: `remove({force:true})` on a worksession-owned workspace is refused at the service layer while the worksession is not `resolved`; the sweep never reaches an owned tree; a reaped pump followed by a mention resumes in the same `cwd` with `git status` unchanged (cwd rung test through `resolve-session-cwd.ts`). "Outlives the process" is then a property of two named gates, not of luck.

### 7. "Close revokes the worktree's `vcs.*` grant" names an object that does not exist, and DOR-2096 does not create it

**(a) Claim.** req 6 edit: "close revokes the receipt token and the worktree's `vcs.*` grant."

**(b) Why it breaks.** Grants are `(agentPath, capabilityId)` (`approval-grants.ts:53-59`) — no worktree, no room, no thread dimension. Platform PRD 10b / DOR-2096 assumes two things: `vcs.*` as destructive-tier capabilities gated per agent, and _credential scoping_ — "an unattended turn should not hold a push-capable credential at all, only a token for the `vcs.*` capabilities that push under the gate". That is per-turn (or per-agent), not per-worktree. Buzz's "archive → read-only" (report §2, `policy.rs:306-318`) works because Buzz _is_ the remote and gates push at its own relay; DorkOS's remote is GitHub and cannot be told a branch is read-only at close short of branch protection or branch deletion.

**(c) Failure scenario.** Implementer adds a `worktreePath` column to `approval_grants` to make this sentence true; now the grant lookup has to know the cwd of the calling turn, `tier-enforcement` grows a fourth key, and finding 1 gets worse (a per-worktree standing grant on `vcs.merge`).

**(d) Smallest fix.** Reword: "close revokes the receipt token (scoped `(room, thread)`, req 6) and, if DOR-2096 lands a per-worktree push credential, that credential; a per-turn credential needs no revocation because it does not outlive the turn." Do not add a grant dimension. Record what _is_ enforceable at the remote: the branch is deleted on merge (GitHub setting) so a closed worksession has nothing to push to.

### 8. "Bounded auto-fix rounds" has no definition of a round, and CI flapping burns the budget with no diff

**(a) Claim.** 8b: "bounded rounds (N auto-fix rounds)"; agreed: exhausted → `waiting` with a card.

**(b) Why it breaks.** If a round is "a turn triggered by a PR event", then a flaky check produces: red → turn → agent re-runs CI, pushes nothing → red again → turn → … N rounds gone, zero pushes, then a card that says "I could not fix CI" about a diff that never changed. If a round is "a push", a flake never counts but an agent that pushes one-line retries burns rounds fast. Neither is stated. Also unstated: whether an operator's canned "Fix CI" (W2) counts against the agent's bounded rounds (it should not — operator-initiated is exempt from caps everywhere else in the conventions).

**(c) Failure scenario.** `browser-test` shard flakes twice on the same SHA. N=3. Third trigger → card "auto-fix exhausted". The operator re-runs the check by hand, it goes green, and the worksession is still `waiting` on a card nobody needs.

**(d) Smallest fix.** A round = one push made by an auto-fix turn. Triggers are deduplicated on `(head_sha, check name)`: a second failure of the same check on the same SHA is a _re-run_ (agent may re-run at most R times, default 2, without spending a round). Operator-initiated canned actions never spend a round. Budget is per PR lifetime, reset on a new head SHA that came from the operator. State these three numbers as config with defaults.

### 9. The proposal still carries a `failed` state and a daily-open cap that the edit list dropped

**(a) Claim.** "What to take from Buzz" item 3: "That is the copy shape for our `failed` state"; "What to take from Projects" closing paragraph: "a daily open cap per agent is a cheap stand-in". Agreed refinements: never `failed`; six states only. Edit list: no daily cap.

**(b) Why it breaks.** The two justifying sections are what an implementer reads for intent; they now contradict the list they justify.

**(d) Smallest fix.** Reword item 3 to "the copy shape for the card raised when a run fails (worksession → `waiting`)". Either add the daily open cap to req 1 (it _is_ cheap, and rail 15's "refused launch is `waiting`" already needs a refusal path to test) or delete the sentence.

### 10. At-cap queued asks have no representation, and `waiting` would count against the cap if used for them

**(a) Claim.** PRD rule 2 and req 1: at cap, the ask is "queued visibly"; rail 15: a refused launch is `waiting`, not silence. Proposal: six states only.

**(b) Why it breaks.** A queued ask is not a worksession yet (no session, no worktree). If it is a `room_worksessions` row in `waiting`, it counts against "concurrent" unless the cap query excludes it — and then `waiting` means two things (parked-on-card, which _does_ hold a slot; queued, which must not). If it is not a row, where is the visible queue and what does the sweep see? Separately: does a worksession parked on a merge card for two days hold one of the three slots? Rule 2's example ("queued, after PRD-A merges") says yes. Say so; Claude Projects' cap counts _running_ threads and someone will copy that.

**(d) Smallest fix.** The queue is its own object (`room_worksession_queue`, per agent, FIFO, with the in-thread "queued" receipt); it is not a state. Cap counts rows with `state ∉ {idle, resolved}`, stated in req 1. A queued ask promotes to a worksession on the next slot and only then gets a row.

### 11. Per-room pause is underspecified for `landing`, open cards, verdict delivery and the receipt endpoint

**(a) Claim.** "Per-room pause (no worksession in this room runs or opens until resumed)"; P0-6 gains it.

**(b) Why it breaks.** Conventions §4.8 already fixes the shape of any freeze: scoped, _disclose collateral_, _clocks keep running_. The proposal states none of the four interactions that matter:

- **`landing` with an approved merge executing**: pause cannot un-merge. Either the executor checks the pause flag before the irreversible forge call and holds, or it finishes. Unstated.
- **Open cards**: stay approvable? If yes, the verdict wakes a session in a paused room (`approval-verdict-delivery.ts` starts a turn) — pause must intercept delivery and queue it, or the pause is decorative. If no, the card clock still runs (§3: 48h auto-decline) and a two-day pause silently declines every card in the room. Both need saying.
- **Receipt endpoint**: a paused room must still _accept_ receipts (an operator's manual push is observation, not action); refusing them makes the room lie about its own state.
- **Substrate**: `rooms.archived` (`rooms.ts:316`, "every WRITE refuses on an archived room") is the nearest thing and is wrong — it refuses receipts too. `RoomTriggerDispatcher.halt` (`room-trigger.ts:4213`) stops turns but does not refuse the next dispatch. Pause is a new flag plus `halt` plus a dispatch guard; small, but it is new.

**(d) Smallest fix.** Pause = (i) `halt` the room's turns, (ii) refuse new dispatch and open in the room, (iii) executors check the flag before any forge write and hold, (iv) cards stay open with Approve _disabled_ and a "room paused" banner, their clocks running, and the pause receipt lists every approved-but-unexecuted action as collateral, (v) receipts accepted. Resume re-checks each held executor's pinned SHA before running.

### 12. Join-on-overlap at open has no mechanical input: touched paths do not exist before work happens

**(a) Claim.** req 1: "at open, if an open worksession's touched paths overlap, the proposal offers 'join that one'"; proposal: "We already check touched-path overlap at open; use it."

**(b) Why it breaks.** Nothing in the repo computes touched paths for a worksession (only `git log --name-only` provenance for room files, `room-files.ts:652`). The _existing_ worksessions' touched paths are knowable (diff of each worktree vs main). The _new_ one's are not — it has no diff. Claude Projects' coordinator routes by _area_ semantically; we have no coordinator, and the PRD says the owning agent decides. So "overlap at open" is an LLM judgment wearing a mechanism's name, which is the pattern conventions idea 4 warns about.

**(d) Smallest fix.** At open the proposer declares `intended_paths` (globs; advisory). Overlap at open = declared globs ∩ actual diffs of open siblings, offered as a suggestion in the proposal reply, never enforced. Overlap at merge stays the mechanical check on real diffs. Say "advisory" in the same voice req 4 uses for memory isolation.

### 13. Room-turn ceilings the PRD does not list will eat worksession replies

**(a) Claim.** req 10: ceilings configurable — background runtime, person-wait, idle reap, process pool.

**(b) Why it breaks.** `constants.ts:293-300`: a room turn is given up after `rooms.lateReplyCeilingMinutes` (default 60, `config-schema.ts:1821`) — "a room-raised Ask answered after an hour still runs its tool … but the room gets no reply posted." A merge card answered on day two wakes the session, the merge runs, the mechanical receipt posts, and the agent's own in-thread words are dropped. That is the documented behaviour and the two dials are "deliberately NOT tied together". The 48h card clock (§3) plus a 60-minute room reply ceiling means every late verdict on a worksession posts a receipt and no explanation.

**(d) Smallest fix.** Add `lateReplyCeilingMinutes` to req 10's list, and state that a worksession turn woken by a verdict uses the _worksession's_ ceiling (days), not the room's (minutes). Also add `worktreeReapDays` (`config-schema.ts:1976`) if the room substrate is ever used.

### 14. `last_activity_at` is undefined, so the stale predicate will misfire in both directions

**(a) Claim.** Staleness computed from `(state, last_activity_at)`; req 7: stale = `ready_for_review` with no activity for N days.

**(b) Why it breaks.** If "activity" is agent turns only, a PR under active human review for a week reads stale. If it includes GitHub events, it needs the PR observer (finding 2). `landing` with a stuck merge queue and `waiting` with an unanswered card are also stale by any reasonable reading and the predicate omits them.

**(d) Smallest fix.** `last_activity_at` = max(last turn end, last thread message, last PR event, last card decision). Stale = `state ∈ {ready_for_review, landing} ∧ now − last_activity_at > N`. `waiting` is covered by the card clock and needs no second timer.

### 15. Codex and OpenCode: two of the load-bearing mechanisms are Claude-Code-only and the edits do not say so

**(a) Claim.** req 9 (in-session path), 1b (prefer reclaiming a canonical session), req 10 (pool ceiling), req 6 (git hook posts receipts).

**(b) What the code says.**

- `getSessionWarmth?` / `reapSession?` are optional on `AgentRuntime` (`agent-runtime.ts:1342,1359`) and implemented only under `runtimes/claude-code/sessions/`. There is no warm pool, no LRU reclaim and no idle reap for Codex or OpenCode, so 1b's "prefer reclaiming a canonical session" has nothing to reclaim on those runtimes and the pool ceiling in req 10 does not bound them.
- The in-session verdict address _does_ exist for Codex and OpenCode via the injected `/agent-mcp` endpoints (`approval-verdict-delivery.ts` header) — req 9 holds across runtimes. The park ceiling is referenced from `opencode/messaging/approvals.ts`; nothing under `runtimes/codex/` references `INTERACTION_PARK_CEILING_MS` — verify that a Codex approval parks rather than fails at the 10-minute countdown before claiming rail 15 for Codex worksessions.
- Codex's default sandbox "cannot reach the network" (`codex/runtime-constants.ts:115`). A push, and the receipt hook's POST, both need network, so a Codex worksession can push only in the unsandboxed mode ("can change anything on this machine", `:127`) — the opposite of DOR-2096's scoped-credential intent.

**(d) Smallest fix.** One paragraph in the PRD: W1 is Claude Code only; Codex/OpenCode worksessions wait on (i) a warmth/reap implementation or an explicit statement that their ceilings are the OS's, and (ii) a decision on Codex network posture for `vcs.*`. Add a conformance-suite case for "verdict delivered after park" per runtime.

### 16. The receipt hook will be clobbered by `lefthook install`, and cannot report success

**(a) Claim.** req 6 / W0: a shared git hook in `.git/hooks` posts open/merge/push receipts; "worktrees share `.git/hooks` → install-once-per-repo".

**(b) Why it breaks.** Verified for this repo: no `core.hooksPath`, hooks live in `.git/hooks`, and lefthook manages them (`lefthook.yml`; `pnpm install` runs `lefthook install`, which rewrites the hook files it owns, `pre-push` included). A receipt hook written into `.git/hooks/pre-push` lasts until the next install. And git has no post-push hook, so the only push-adjacent hook is `pre-push`, which fires before transfer and cannot know the outcome.

**(d) Smallest fix.** Ship the receipt as a lefthook command in a repo-local config (or `lefthook-local.yml`) where the repo uses lefthook, and as a raw hook elsewhere — detect at install. Label its receipt "push attempted (SHA)"; the "pushed" receipt comes from the PR observer. Keep "verify no repo uses separate git-dirs" and add "verify `core.hooksPath` is unset".

### 17. "Merge it" as the card's Approve, and the canned actions, need their card classes stated

**(a) Claim.** W2: canned actions (Fix CI, Address comments, Resolve conflicts, Create PR) are mentions into the thread; "Merge it" is the L1 card's Approve.

**(b) Why it is underspecified.** Conventions §3: "the approval surface is itself an action surface … card controls carry a class and emit receipts". "Create PR" is a mention that leads the agent to call `vcs.open_pr`, which is L1 — so it is two taps (instruction, then card), and the second tap must not be collapsed into the first "for convenience". Also: are canned mentions operator-initiated (exempt from the daily card cap and from finding 8's round budget)? They should be, and it should say so.

**(d) Smallest fix.** One line: canned actions are operator-initiated instructions (cap-exempt, round-exempt) and never approvals; any outward action they lead to still raises its own card.

---

## Holds

- The six-state vocabulary is better than open/closed/"PR open but stale", and it gives rail 15 and the Overview a real enum. Holds, subject to finding 2.
- Staleness as a computed predicate, mirroring Goals' `at-risk`. Holds.
- Merge card pins the head SHA. Holds and is nearly free: approvals are already bound to `(capabilityId, inputHash)` (`approval-service.ts:22`, `approval-input-hash.ts`), so `vcs.merge {pr, headSha}` binds the token to the SHA by construction. Execution-time enforcement is the missing half (finding 3).
- "Words in a thread are never an approval; only the card is." Holds against the code: room mentions start turns (`room-trigger.ts`), nothing parses text as consent, the tier gate consults only approvals and grants, and `halt` (the one text-adjacent control) only reduces. The standing-grant mechanism is a UI action on a card, not words. The contradiction is finding 1, not this rule.
- "An approval binds to an artifact, not an intention" as a conventions rule. Holds — it is a description of `inputHash`. It needs the standing-grant exclusion (finding 1) to be true.
- Exhausted auto-fix → `waiting` with a card, never `failed`. Holds, and maps cleanly onto rail 15 ("prompt becomes a card when a human gate applies").
- Enforced cap with a visible queue, not a model preference. Holds.
- Local worktrees, not cloud clones. Holds as a statement of intent; the test claim needs finding 6.
- Multi-member rooms, not single-user projects. Holds.
- Six-state map onto Claude's table, with `waiting` absorbing "failed". Holds.
- Keeping "worksession" as the object and "thread" as the UI tab. Holds.
- The non-changes paragraph. Holds.

---

## Sign-off

**Not yet.** With findings 1–4 fixed (grant exclusion for artifact-bound classes; a named PR observer and a written transition table; execution-time SHA enforcement plus the `(worksession, head_sha)` dedup; a decision on the taint status of review-driven pushes) I would sign off on the _edits_. Findings 5 and 6 are not defects in the edits but they are the two places where the PRD's "W1 stays M" is wrong by a lot — the per-agent claim ceiling and the choice of worktree substrate are the W1 work, and neither is in the estimate. What would still make me nervous after every fix above: the whole of 8b rests on an external event source that DorkOS does not have and that P0-9 says must be delta-triggered rather than polled; until that object is built and its rail-15 behaviour tested (what does the worksession show when GitHub stops sending events?), a worksession in `ready_for_review` can look healthy while nothing is watching it — which is exactly the failure shape rail 15 was written for.

---

# Adversarial review, round 2: dispositions, remaining objections, final edit list

Reviewed 2026-09-19 against the coordinator's round-2 dispositions. Sixteen accepted as written and I have nothing further on them. Two remaining objections (one on #4, one on the phase split), two pushbacks accepted, then the final consolidated edit list and the re-estimate.

---

## Remaining objections

### Objection A — #4 reclassification still fails §3 on one path: CI executes the pushed code, and the path list cannot see that

The reclassification argument is "the SHA-pinned merge card re-reviews the head before anything lands". That protects `main`. It does not protect what runs _before_ merge: a push to a same-repo branch runs the repo's workflows on the pushed code, and same-repo branch workflows run **with the repository's secrets** (GitHub only strips secrets for fork PRs). So a tainted auto-fix turn that adds one line to a _test file_ — not to `.github/`, not to any CI/deploy/release config — has an outward effect the moment CI runs it: the code executes in an environment holding `NPM_TOKEN`, deploy keys, whatever the repo's workflows carry. The exception list is a list of paths; taint is not a path property. This is the same shape as conventions §3's "an action's class cannot be a static label on a capability name" — here it cannot be a static label on a file path either.

Concrete: reviewer comment says "the flaky test needs a longer timeout; also log the env so we can debug". Agent's "Address comments" round edits `apps/e2e/…spec.ts` to dump `process.env` into the CI log. Push is inward under the reclassification. CI prints every secret into a log the reviewer (the outside party) can read.

**Smallest fix I would accept** (keeps the reclassification, makes it honest): a third condition, a per-repo posture in the operator ledger — `branchCiTrust: 'secret-minimal' | 'trusted'`, **default `trusted`**, and the reclassification applies only under `secret-minimal`. Under `trusted` (the default, and the state of every repo in scope today) review- and CI-driven pushes are L1 — one class `vcs.push_to_own_pr`, cumulative diff shown, trigger named, batched, so the attention cost is bounded. The operator flips a repo to `secret-minimal` after moving branch CI to secret-free jobs (or accepting the residual), and that flip is an operator-ledger write like any grant. This is fail-closed by default and it puts the residual risk where the conventions say residual risk goes: in a ledger entry the operator chose, not in a path list nobody will keep current.

Two smaller points on #4 that need to land with it regardless:

- The conventions doc says, verbatim, "**The outward line is push / deploy / publish / release**" (§1, Repo agents). The reclassification contradicts that sentence; it must be amended in place, or the two documents disagree and the conventions win by their own rule ("this doc never references any instance; instance docs reference this").
- "Any push after a card was raised for that PR" is L1 — good — but say what state it leaves: the push voids the card (finding 3), the worksession is `working` for the turn, and the L1 card for the push itself is raised before the push, not after. Otherwise an implementer raises the merge card again first.

### Objection B — per-room pause belongs in W1, not W2

W1 ships hours-long sessions that a person opened and then walked away from. The only stop available in W1 would be the global kill switch or per-session Stop, one worksession at a time. Pause is `halt` (exists, `room-trigger.ts:4213`) plus a room flag plus a dispatch/open guard — S, not L — and it is the room-sized kill switch the platform PRD's sequencing puts at step 1 ("cheap and clarifying"). The executor pre-write check and the "cards stay open, Approve disabled" half can wait for W2 because W1 has no executors (see the split below); the halt + guard + receipts-accepted half is W1. Move it.

## Pushbacks accepted

- **#10** (a worksession `waiting` on a merge card holds a slot). Accepted. Canonical duties are not worksessions, so the cap cannot starve them; what a held slot starves is _new worksession work_, and three PRs nobody reviewed is the right thing to be blocked on. One condition: the queue line names the PRs holding slots ("at cap 3/3 — PR #12, #14, #15 awaiting your review"), so the operator's fix is review, never config. And note the corner: an expired (48h auto-declined) card leaves `ready_for_review` holding a slot until the stale predicate fires; the stale flag should carry a one-tap abandon.
- **#15** (req 9 is runtime-neutral). Accepted; that matches what I found. Only pool/reap/park are Claude-Code-only.

## On the phase split

Correct in shape, with three amendments:

1. **W1 depends on 10b landing first.** `ready_for_review` is written by the `vcs.open_pr` executor; that executor _is_ 10b. And #1's `standingGrant: never` must ship _before_ the first `vcs.*` capability exists, or there is a window in which the first merge card can mint an 8h blanket grant. Order: #1 → 10b → W1.
2. **W1 has no `vcs.merge` and no merge card.** Merging in W1 is a human act on the forge (W1 is operator-opened only); `landing` is unreachable; `resolved` is operator-written with reason `merged` or `closed`. Say so in the rollout text so nobody builds half of finding 3 in W1.
3. **W1 staleness under-counts PR activity** (no observer, so `last_activity_at` is turns + thread + card decisions only). Acceptable because the W1 operator is also the reviewer; say it.

Re-estimate as amended: **W1 = L** (claim ceiling `(agentPath, worktreePath)` + `busyWorktreePaths` with the room-reap safety test re-pinned; workspace substrate with `owner`; side table + convergence write site; state column with the five local writers; queue object + daily open cap; per-room pause without executor hold). **W2 = L** (PR observer on connector events + its rail-15 case; 8b with rounds; merge executor with SHA pin; `landing`; `branchCiTrust` posture and `vcs.push_to_own_pr`; canned actions; pause's executor-hold half). One thing to verify before committing to W2 = L: that the GitHub connector actually delivers PR/check-run events through `services/connectors/events/` today; if it only delivers issue/comment events, the observer's first version is a poll and must be labelled so.

---

## FINAL consolidated edit list

Paste-ready. Grouped by document; numbered continuously; each item replaces or adds exactly what it names.

### A. Worksessions PRD

**A1. Behavioral rule 4, append one sentence.**

> Words in a thread are never an approval; only the card is. "Go ahead" typed anywhere — the thread, the room, a DM — reaches the agent as an instruction and can lead it to call a gated capability, which then raises the card. Nothing parses text as consent.

**A2. Behavioral rule 6, replace the last sentence ("Merge (or PR merge) closes … its own state.") with:**

> The merge card pins the head SHA it approves. The executor hands that SHA to the forge and fails closed on mismatch, so a push the platform never saw is a refused merge, never a wrong one. Pushes to the worksession's own unmerged PR are inward only where the repo's branch CI is declared `secret-minimal` in the operator ledger (default `trusted` → L1); anything under `.github/`, CI/deploy/release config, a force-push, or any push after a card was raised for that PR is outward regardless. Close is a written transition (see req 1), never inferred.

**A3. Platform req 1, replace the column list and append the state machine.**

> Columns: room, agent, thread root, session id, worktree path (workspace id), `state`, `resolved_reason`, `last_activity_at`, opened/closed timestamps, and the PR (number, head SHA) once one exists — at most one open PR per worksession.
>
> `state ∈ {working, waiting, ready_for_review, landing, idle, resolved}`. **Predicates are read; transitions are written.** Every transition has a named writer:
>
> | Transition                              | Trigger                                         | Writer                                                             |
> | --------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------ |
> | open → `working`                        | open capability starts the kickoff turn         | open capability (W1)                                               |
> | `working` → `idle`                      | turn terminal, no open PR, no pending card      | room-trigger release seam (W1)                                     |
> | `working` → `waiting`                   | a card or prompt raised on this session         | approval hold / pending-interactions, joined via `session_id` (W1) |
> | `waiting` → `working`                   | verdict delivered, session woken                | verdict delivery (W1)                                              |
> | `working` → `ready_for_review`          | `vcs.open_pr` succeeded                         | open_pr executor (10b, W1)                                         |
> | `ready_for_review` / `idle` → `working` | mention in thread, or an auto-fix trigger       | room-trigger (W1) / PR observer (W2)                               |
> | `ready_for_review` → `landing`          | merge card approved                             | verdict delivery (W2)                                              |
> | `landing` → `ready_for_review`          | push observed, or merge refused on SHA mismatch | PR observer / merge executor (W2)                                  |
> | `landing` → `resolved(merged)`          | PR merged                                       | PR observer (W2); operator (W1)                                    |
> | `ready_for_review` → `resolved(closed)` | PR closed unmerged                              | PR observer (W2); operator (W1)                                    |
> | any → `resolved(abandoned)`             | abandon capability                              | abandon capability (W1)                                            |
> | `idle` → `resolved(idle_timeout)`       | N idle days                                     | orphan sweep (W1)                                                  |
>
> `resolved` is always written, never computed; `resolved_reason ∈ {merged, closed, abandoned, idle_timeout}`. Staleness is a predicate, never a column: `state ∈ {ready_for_review, landing} ∧ now − last_activity_at > N`, where `last_activity_at = max(last turn end, last thread message, last PR event, last card decision)`. `waiting` needs no staleness timer; the card clock covers it.
>
> **Cap and queue.** The per-agent cap (default 3, operator-set) counts rows with `state ∉ {idle, resolved}`; a worksession parked on a merge card holds a slot deliberately — its worktree and PR are live and it resumes on the verdict. The at-cap queue is its own per-agent object, not a state: an ask waiting for a slot has no session and no worktree and gets a row only when it opens. The in-thread queue line names what holds the slots ("at cap 3/3 — PR #12, #14, #15 awaiting your review"). A daily open cap per agent (default 20, config) is the budget stand-in until P0-8; a refused open is `waiting` where it was asked, never silence.
>
> **Join at open.** The proposer declares advisory `intended_paths` (globs). Overlap at open is those globs against the actual diffs of open sibling worksessions, offered as "join that one" in the proposal reply and never enforced; the mechanical overlap check stays at merge.
>
> **Claim ceiling.** The room claim's second ceiling becomes `(agentPath, worktreePath)` — one checkout is one writer, an agent has as many checkouts as worksessions; `busyAgentPaths()` becomes `busyWorktreePaths()` and the room-worktree reap digests worktree paths. The reap's "never deletes a live cwd" test is re-pinned against the new key before the old one is removed.

**A4. Platform req 2, replace.**

> Session ↔ worktree binding on the **workspace substrate** (`services/workspace`, the WorkspaceManager), not the room-repo worktree manager: a worksession's worktree is a workspace of the agent's own repo with `owner = worksession:<id>` set at open. Three pinned tests under the W1 gate: (1) `remove({ force: true })` on a worksession-owned workspace is refused at the service layer while the worksession is not `resolved`; (2) the workspace sweep never reaches an owned workspace; (3) a reaped pump followed by a mention resumes in the same cwd with `git status` unchanged. The worktree outlives the process by those two gates, not by luck. Abandon flags a dirty tree and cleans a clean one.

**A5. Platform req 6, replace the token sentence and add the hook mechanics.**

> The hook's token is minted at open, scoped to `(room, thread)`, and revoked at close. Close also revokes any per-worktree push credential if DOR-2096 lands one; a per-turn credential needs no revocation. Remote-side, delete-branch-on-merge is the enforceable fact. The hook ships as a lefthook command where the repo uses lefthook (a raw `.git/hooks` file is rewritten on every `lefthook install`) and as a raw hook elsewhere; install verifies `core.hooksPath` is unset and no repo uses a separate git-dir. Git has no post-push hook: the hook's receipt reads "push attempted (SHA)"; "pushed" comes from the PR observer.

**A6. Platform req 7, replace.**

> Orphan sweep runs over the state enum and the activity clock. It writes `resolved(idle_timeout)` for `idle` rows past N days, flags stale rows (predicate in req 1) to the weekly review with a one-tap abandon, and — once the PR observer exists — flags a `ready_for_review` or `landing` row that has received no PR events for X as **unwatched**, which is rail 15's "quietly does nothing" case for the observer itself.

**A7. New platform req 8b.**

> After PR-open the worksession stays live. **Auto-fix:** a CI failure or review comment (delivered by the PR observer) starts a turn; a round is one push made by such a turn; triggers are deduplicated on `(head_sha, check name)` and a repeat failure of the same check on the same SHA is a re-run, capped separately at R; budget N per PR lifetime, reset on a head SHA the operator pushed; N, R and the re-run cap are config. Rounds exhausted → `waiting` with a card, never a `failed` state. Each auto-fix push receipt names its trigger (check name, or comment author + id) so taint provenance is visible in the thread whether or not it gates. Operator canned actions never spend a round. **Merge:** `vcs.merge` is L1 and cannot be made standing (`standingGrant: never`). The card pins the head SHA and shows the cumulative diff since the last approved SHA; the executor passes the SHA to the forge (`--match-head-commit` / REST `sha`) and fails closed. A push voids the card; at most one live merge card exists per `(worksession, head_sha)`, raised when `PR open ∧ no turn running ∧ no live card for this SHA` — idempotent, so an unobserved push costs one refused merge and one new card, and an expired card is re-raised by the operator's "Merge it" or the stale flag. One worksession, at most one open PR. **Push class:** see rule 6 — inward only under `branchCiTrust: secret-minimal`; L1 (`vcs.push_to_own_pr`, cumulative diff, trigger named, batched) under the default.

**A8. Platform req 9, append.**

> Runtime-neutral: the in-session address exists for Claude Code and, via the injected `/agent-mcp` endpoints, for Codex and OpenCode. What is Claude-Code-only is the warm pool, the LRU reclaim, and the idle reap (`getSessionWarmth`/`reapSession` are optional on `AgentRuntime` and implemented only there), so req 1b's "prefer reclaiming a canonical session" and req 10's pool ceiling do not bound the other runtimes. W1 is Claude Code only. Before a Codex or OpenCode worksession ships: a per-runtime conformance case "verdict delivered after park", and a decision on Codex network posture — its default sandbox has no network, so it can push only unsandboxed, which is the opposite of DOR-2096's scoped-credential intent.

**A9. Platform req 10, append to the list.**

> …and `rooms.lateReplyCeilingMinutes`. A worksession turn woken by a verdict uses the worksession's own reply ceiling (days), not the room's (minutes), or every late merge approval posts a receipt and drops the agent's words.

**A10. New platform req 11 — per-room pause.**

> Pause is the room-sized kill switch (platform P0-6). It halts the room's running turns, refuses new dispatch and open in the room, and keeps accepting receipts (a manual push is observation, not action). Cards stay open with Approve disabled and a paused banner; their clocks keep running (§4.8), and the pause receipt lists every approved-but-unexecuted action as collateral. Executors check the flag before any forge write and hold; resume re-checks each held executor's pinned SHA before running. `rooms.archived` is not the substrate — it refuses receipts. W1 ships halt + guard + receipts-accepted; the executor-hold half lands with the executors in W2.

**A11. Rollout, replace the phase list.**

> **Order:** conventions rule "artifact-bound classes cannot be made standing" + `standingGrant: never` on `vcs.*` → 10b (`vcs.open_pr`) → W1. No `vcs.*` capability ships before the grant exclusion.
>
> - **W0 (now):** receipt endpoint + lefthook-aware hook; receipts say "push attempted".
> - **W1 (L, Claude Code only, operator-opened):** side table with the state column and the five local writers; claim ceiling `(agentPath, worktreePath)`; workspace substrate with `owner`; queue object + daily open cap; `ready_for_review` written by the open_pr executor; per-room pause (halt + guard). **No `vcs.merge`, no merge card, `landing` unreachable**: merging is a human act on the forge and `resolved` is operator-written (`merged`/`closed`). Staleness under-counts PR activity in W1; acceptable because the W1 operator is the reviewer.
> - **W2 (L):** PR observer on connector events (verify GitHub PR/check-run events are deliverable through `services/connectors/events/`; a poll is a blind heartbeat and is labelled one) + its unwatched rail-15 case; req 8b; merge executor with SHA pin; `landing`; `branchCiTrust` posture; canned thread actions; pause's executor hold; agent-opened worksessions.
> - **W3:** unchanged.

**A12. W2 UI item.**

> Canned thread actions (Fix CI, Address comments, Resolve conflicts, Create PR) are operator-initiated instructions: cap-exempt, round-exempt, never approvals. "Create PR" is two taps — the instruction, then the `vcs.open_pr` card. "Merge it" is the merge card's Approve and nothing else; card controls carry a class and emit receipts (§3).

**A13. "What to take from Buzz" item 3, reword.**

> …That is the copy shape for the card raised when a run fails (worksession → `waiting`).

### B. Platform PRD

**B1. P0-4 (cards v2), add a bullet.**

> Cards for artifact-bound classes carry the artifact they approve (a merge card: PR number, head SHA, cumulative diff since the last approved SHA); the executor enforces the artifact at the forge and fails closed. Capabilities declare `standingGrant: 'allowed' | 'never'`; the tier gate refuses a grant row for a `never` capability even if one exists, pinned red-before/green-after.

**B2. P0-6 (kill switch), append.**

> Per-room pause as the room-scoped variant (worksessions PRD req 11): halt + dispatch/open guard + executor hold, cards open with Approve disabled, receipts accepted, collateral disclosed.

**B3. 10b, append two bullets.**

> - `vcs.merge`, `vcs.open_pr`, `vcs.publish` are `standingGrant: never`; the exclusion lands before the first of them exists.
> - A per-repo `branchCiTrust: 'trusted' | 'secret-minimal'` posture in the operator ledger, default `trusted`; it decides whether `vcs.push_to_own_pr` is inward (worksessions PRD rule 6).

**B4. P1.6, replace items 1, 2, 7, 8 with pointers to A3, A4, A6, A7, and add:**

> 11. **PR observer** — learns PR head SHA, checks, review comments, merged/closed from the forge, delta-triggered through the connector event path (P0-9); writes the W2 transitions in the req 1 table; has its own rail-15 case (no events for X while `ready_for_review` → unwatched flag). 12. **Per-room pause** (A10). 13. **Claim ceiling rework** to `(agentPath, worktreePath)` (A3) — the W1 item that moved the estimate from M to L.

### C. Conventions

**C1. §1 Repo agents, amend the bullet "Git is the built-in undo …":**

> **The outward line is PR-open / merge / deploy / publish / release.** A push to an agent's own unmerged PR branch sits on the line: it is inward only where the repo's branch CI is declared `secret-minimal` in the operator ledger (because CI executes pushed code with whatever secrets it holds), and outward otherwise, and it is always outward for `.github/`, CI/deploy/release config, force-pushes, and any push after a card was raised for that PR.

**C2. §3, add one rule after "One action class per card":**

> - **An approval binds to an artifact, not an intention.** A card approves a specific thing (a message body, a payee, a commit SHA), and the executor enforces that thing at the point of effect. Artifact-bound classes cannot be made standing — a standing grant is an intention by construction.

**C3. §1 Worksessions, replace the "Closing" bullet:**

> - **Closing is a written transition.** States: working, waiting, ready_for_review, landing, idle, resolved (with a reason). Staleness is a predicate over the activity clock, never a state. Words in a thread are never an approval; only the card is.

---

## Sign-off

Yes, conditional on Objection A (the `branchCiTrust` posture, default `trusted`, and the amended conventions sentence) and Objection B (pause's halt + guard half in W1). Everything else in the dispositions I accept as written. What still makes me nervous is unchanged in kind and smaller in size: W2 rests on a forge event source that has not been shown to deliver PR and check-run events through the connector path — verify that before the W2 estimate is trusted, because the fallback is a poll, and a poll on the thing that decides `landing → resolved` is a blind heartbeat wearing the most important cursor in the system.

---

## Round 3 (coordinator)

Both objections accepted as written: the `branchCiTrust` posture (default `trusted`, so auto-fix pushes are L1 until the operator relaxes a repo) with the conventions outward line amended in place; and the per-room pause halt + guard + receipts-accepted half moved into W1. Phase order #1 → 10b → W1; W1 = L, W2 = L.
