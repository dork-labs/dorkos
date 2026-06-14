# Crash/Stall Recovery & Session↔Issue Association for Agent Orchestrators

**Date:** 2026-06-14
**For:** spec #257 `unified-workflow-system` (the `/flow` engine) — §5.3/§5.4/§5.5/§5.11 recovery model
**Question:** When a scheduled loop claims an issue, starts an ephemeral agent session in a worktree, then the session crashes or stalls — how does the next tick recover without losing work or double-processing? How is a session associated with an issue durably? Is "parked waiting on human" distinguishable from "crashed"?

---

## Research Summary

Three principles are industry-converged:

1. **The tracker (+ a durable claim) is the source of truth; local scheduler state is a cache.** A crashed process loses in-memory state; recovery = re-read tracker state + reuse on-disk artifacts. (Symphony, GitHub Copilot, Sweep.)
2. **The checkpoint is the git commit / worktree + the agent's own session log.** Recovery means **resume from the last committed state + replay the session**, not "restart from scratch." (Temporal event-history replay, LangGraph `thread_id` checkpointer, OpenHands event sourcing, git-commit-as-checkpoint.)
3. **"Parked waiting for input" and "crashed" must be _structurally different states_, not two readings of one field** — otherwise recovery steals a task that's legitimately waiting on a human. (Temporal Signal-wait vs activity-heartbeat; LangGraph `interrupt()`; an explicit `waiting_for_review` status the stall sweep excludes.)

The minimal durable record to associate a run with an issue: `{ issue_id, session_id, worktree_path, git_branch, status, attempt_count, heartbeat_at | worker_pid }`.

---

## 1. OpenAI Symphony — authoritative (from SPEC.md re-review)

Symphony keeps **claims in memory only** — no persistent DB by design (§6.3, §14.3):

- `claimed` (set of issue IDs: reserved/running/retrying), `running` (map `issue_id → live-session entry`), `retry_attempts` (map `issue_id → RetryEntry`). (§7.1, §4.1.6–4.1.8)
- **Double-dispatch prevention** is purely in-memory: an issue dispatches only if "not already in `running`, not already in `claimed`," global+per-state slots available (§8.2/§8.3); the single-threaded poll loop serializes mutations (§7.4). Issue is added to `running`+`claimed` atomically only **after** worker spawn succeeds (§16.4). **No fencing tokens.**
- **Stall detection** (§8.5): each tick computes `elapsed` since `last_codex_timestamp`/`started_at`; if `> codex.stall_timeout_ms` (default 5 min) → terminate worker + queue retry. There is **no heartbeat** — the agent's own event stream is the liveness signal.
- **Retries** (§8.4): `delay = min(10000 * 2^(attempt-1), max_retry_backoff_ms)` capped 5 min; `RetryEntry { issue_id, identifier, attempt, due_at_ms, timer_handle, error }`. `due_at_ms` is just retry-timer bookkeeping.
- **Restart recovery** (§14.3): in-memory maps start empty; **no retry timers or running sessions are restored**. Recovery = (1) startup terminal-workspace cleanup (query tracker for terminal issues, remove their workspaces, §8.6); (2) immediate tick; (3) fresh poll re-dispatches eligible work. The **Linear record + the on-disk workspace are the only durable state.**
- **Session↔issue association**: `session_id = <thread_id>-<turn_id>` (§4.2), stored in the `running` map keyed by `issue_id` — **but not persisted**. After restart, fresh session IDs are generated; the existing **workspace is reused** but the live session is **not** resumed.
- **Workspace** (§9.2): keyed by sanitized issue identifier, **reused across attempts**; `create_for_issue()` is idempotent (`created_now=false` if the dir exists → `after_create` skipped, `before_run` re-runs). The committed git branch in the workspace is the implicit durable claim/checkpoint.
- **Parked vs crashed**: implicit — a run that reached "Human Review" submitted events up to the handoff (recent timestamp), so the stall timer stays low; a crashed run's timestamp goes stale and the 5-min stall fires. (Risk: a crash _en route_ to the handoff still trips the stall timer, which is acceptable.)
- **Known gap (§18.2 TODO):** "Add first-class tracker write APIs (comments/state transitions) in the orchestrator instead of only via agent tools." Today the coding agent does all tracker writes via tools.

**Net:** Symphony's recovery = _tracker-as-truth + workspace-reuse + last-event-timestamp stall timer + startup sweep_. It deliberately persists nothing and resumes nothing in-process; it re-derives everything from Linear + disk each boot. Our existing `linear-loop` already **improves on this** by claiming **durably in the tracker** (`agent/claimed` label + Todo→In Progress) rather than in memory (fixes Symphony's L2114/L18.2 TODO). See `research/20260611_work-sequencing-linear-method.md` §1.2.

---

## 2. Durable job-queue patterns (the lease/heartbeat toolbox)

| System                        | Mechanism                                                                                                                                                                                                                               | TTL/interval                  | Notes for /flow                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **AWS SQS**                   | Visibility timeout + `ChangeMessageVisibility` heartbeat                                                                                                                                                                                | 30 s default; renew at 20–30% | At-least-once; no fencing; dedup by business key. Background ticker extends the claim.                       |
| **Sidekiq Pro `super_fetch`** | `RPOPLPUSH` job → per-process working list; heartbeat key `EX 60`, set every 20 s; orphan sweep moves jobs back when owner heartbeat expired (single-winner lease)                                                                      | 20 s / 60 s TTL               | The working-list + TTL-heartbeat maps **directly to SQLite**: `status='running'` + `heartbeat_at`.           |
| **BullMQ**                    | Job lock renewed every `stalledInterval` (½ × `lockDuration`); a peer worker scans `active` for expired locks → `stalled` → back to `waiting`; `maxStalledCount` cap                                                                    | 15 s / 30 s                   | No parked/crashed distinction — so **don't leave a review-waiting item in `active`**; give it its own state. |
| **Celery `acks_late`**        | Ack **after** completion; broker re-delivers unacked on worker death (RabbitMQ TCP drop; SQS/Redis visibility timeout)                                                                                                                  | broker-dependent              | Only mark a run "complete" **after** the session finishes, never at start.                                   |
| **Google Cloud Tasks**        | Hold until handler returns 2xx; else exponential backoff retry                                                                                                                                                                          | up to hourly                  | Queue is the durable store; idempotent handlers required.                                                    |
| **Temporal/Cadence**          | **Durable execution**: event history replay; completed activities skipped. Four timeouts: Schedule-To-Start, Start-To-Close (primary crash detector), **Heartbeat** (stall within a running activity), Schedule-To-Close (total budget) | heartbeat configurable        | The gold standard for resume-not-restart; the event history _is_ the checkpoint.                             |

**Fencing tokens** (SQS none; GitLab `lock_id`; Redlock UUID): a monotonically re-issued token that storage rejects if stale — prevents a half-recovered ghost worker from writing. For /flow, an `attempt_id`/`run_id` can serve this role (`UPDATE … WHERE attempt_id = ?` returns 0 rows if superseded).

**TTL ratio rule of thumb:** heartbeat interval × 2 = lease TTL (tolerates one missed beat). GitLab Duo = 15 s/30 s; Sidekiq = 20 s/60 s.

---

## 3. Agent orchestrators

- **GitHub Copilot coding agent / Sweep**: run in **ephemeral GitHub Actions**; the **draft PR + commit history is the durable checkpoint**; issue ID is the permanent key; Actions native re-run handles crashes; a fresh invocation sees the PR's existing commits. **PR/commit-as-checkpoint.**
- **GitLab Duo Workflow**: `PUT …/lock/<LOCK_ID>` heartbeat every **15 s**, invalidated after **30 s**; **every checkpoint write must carry the current `lock_id`** (true fencing token); on expiry → `failed`, client re-acquires a new lock to resume.
- **OpenHands** (Nov 2025 SDK): **event sourcing** — every action appended to an immutable log, crash-replay reconstructs state in <20 ms; built-in stall/loop detection; thread ID persists across restarts.
- **LangGraph**: `thread_id` + checkpointer (SQLite/Postgres/Redis) snapshots full state after each node; resume with the same `thread_id` loads the last checkpoint and continues from that node; **`interrupt()` sets an explicit `interrupted` flag** distinguishing human-wait from crash.
- **Devin**: ephemeral cloud VM + **Machine Snapshots** (warm-start checkpoint); persistent user-visible session id with explicit `pause`/`resume`; `paused` status ≠ crashed.

**Common thread:** issue/thread ID is the durable key; the checkpoint is a commit/snapshot/event-log; resume re-attaches rather than restarting; human-wait is an explicit status.

---

## 4. Resume vs restart-clean — decision criteria

```
resume = worktree_exists AND session_log_intact AND attempt_count < MAX_RETRIES
restart-clean (else) = reset to base, fresh worktree, new session, attempt_count++
```

- Prior session log intact & under token limit → resume (SDK `resume: session_id`).
- Worktree has committed progress → resume from `HEAD`.
- Worktree corrupt (merge conflict / uncommitted half-changes) → discard, restart-clean from last good commit.
- Exceeded `MAX_RETRIES` → restart-clean with escalation (comment + `agent/blocked`).

For /flow the checkpoint is concretely **the git branch (committed work) + the Claude SDK JSONL session** (which already _is_ an event log à la OpenHands).

---

## 5. Parked-waiting-on-input vs crashed (the hard one)

Winning pattern (Temporal/LangGraph/DBOS): **distinct states, not a flag on one state.**

- A handoff to human writes an explicit `status = 'waiting_for_review'` (+ `review_requested_at`); the **stall sweep excludes it entirely** — it has no heartbeat requirement. The Linear issue's own `In Review` status is the external gate; resume is triggered by the human reply (next poll tick / `getInbox` / status change), not a timer.
- Only `status = 'running'` records are subject to stall/heartbeat reclaim.

```sql
-- reclaim stalled runs, but NEVER a parked one:
SELECT * FROM runs
WHERE status = 'running' AND heartbeat_at < now() - interval '5 min';
```

This maps cleanly to /flow's disposition labels: `agent/needs-input` (= parked, skip) vs `agent/claimed` with a dead worker (= recover).

---

## 6. Recommended recovery model for /flow

### Minimal durable run record (the session↔issue association)

```ts
interface FlowRun {
  issueId: string; // tracker issue id — the permanent key
  identifier: string; // "DOR-123" — worktree path / branch
  sessionId: string | null; // Claude SDK JSONL id (for resume)
  worktreePath: string; // ~/.dork/workspaces/<project>/<key>/
  branch: string; // dork/<key>
  status: 'queued' | 'running' | 'waiting_for_review' | 'complete' | 'failed';
  attemptCount: number; // increments on each reclaim
  workerPid: number | null; // v1 liveness check
  heartbeatAt: string; // v1.5/v2 liveness check (~60s interval)
  startedAt: string;
  completedAt: string | null;
}
```

### v1 — sequential, single machine (WIP 1)

Stale detection is **trivial**: on a fresh tick, _any_ `agent/claimed` + In-Progress item that is **not** `agent/needs-input` is orphaned by definition (sequential ⇒ the prior session is dead). So v1 needs only:

1. **Durable claim** (already designed: `agent/claimed` + In Progress, "survives restart").
2. **The run record** (above) in `flow-state.json` on disk, keyed by issue — the session↔issue link.
3. **Disposition distinction**: `needs-input` (parked → skip) vs `claimed` (orphaned → adopt).
4. **Tick/startup sweep**: adopt orphaned claims → **resume** (`resume = worktreeExists AND sessionLogIntact AND attempt < MAX`) else **restart-clean**; `attempt++`; over `MAX_RETRIES` → `agent/blocked` + comment.
5. **Tracker-as-truth fallback**: if Linear says In-Progress but no local run record exists (e.g. different machine), re-create the record from tracker + workspace (Symphony's model).

No heartbeat/lease/fencing token needed in v1 — sequential single-writer makes them unnecessary.

### v2 — server poller, concurrent (the DOR-89 "stall/restart reconciliation" residue)

Add exactly what concurrency forces:

1. **Heartbeat** (`heartbeatAt`, ~60 s) replacing the PID check — works across machines.
2. **Fencing token** (`attemptId` UUID) written on every status update; `UPDATE … WHERE attemptId = ?` rejects ghost writers.
3. **Atomic multi-claim** (`BEGIN IMMEDIATE` / `FOR UPDATE SKIP LOCKED`) so two workers never grab one issue.
4. **Stall detector** as a periodic server tick (heartbeat-expiry query), reclaim + notify tracker.
5. Run record graduates from `flow-state.json` → server **SQLite** (the ADR-0043 file-first + reconciler precedent).

### Mapping to /flow's existing primitives (little new infrastructure)

- Durable claim = `agent/claimed` label (§5.3) — have it.
- Workspace keyed by unit-of-work, reused across attempts = the gtr worktree (Decision #16) — have it.
- Checkpoint = git branch (committed work) + **the Claude SDK JSONL session** (already an event log) — have it.
- Externalized run record = extend `flow-state.json` (§5.7 `context.externalize`) — small add.
- The full lease/fencing reconciler = **earmarked for the server edition (Phase 2 / DOR-89)** — already in the plan.

---

## Sources

Symphony SPEC.md (§4, §6.3, §7–9, §14.3, §16, §18.2) · existing `research/20260611_work-sequencing-linear-method.md` §1.2 (Symphony in-memory claim vs linear-loop durable claim) · `research/20260611_workspace_strategy_runtimes_symphony.md` (workspace keyed by issue, reuse, reconciliation). Job queues: [SQS visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html), [Sidekiq Pro super_fetch](https://www.bigbinary.com/blog/increase-reliability-of-background-job-processing-using-super_fetch-of-sidekiq-pro), [BullMQ stalled jobs](https://docs.bullmq.io/guide/workers/stalled-jobs), [Celery acks_late](https://docs.celeryq.dev/en/stable/userguide/tasks.html), [Cloud Tasks](https://cloud.google.com/tasks/docs/dual-overview), [Temporal activity timeouts](https://temporal.io/blog/activity-timeouts) + [human-in-the-loop](https://learn.temporal.io/tutorials/ai/building-durable-ai-applications/human-in-the-loop/). Agent orchestrators: [Copilot coding agent](https://github.blog/news-insights/product-news/github-copilot-meet-the-new-coding-agent/), [GitLab Duo locking/heartbeat #548686](https://gitlab.com/gitlab-org/gitlab/-/issues/548686), [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence), [OpenHands SDK (arXiv)](https://arxiv.org/html/2511.03690v1), [DBOS durable AI agents](https://www.dbos.dev/blog/durable-execution-crashproof-ai-agents). [Fencing tokens](https://blog.suje.sh/posts/distributed-locks-and-fencing-tokens-handling-concurrency-safely-in-microservices/).
