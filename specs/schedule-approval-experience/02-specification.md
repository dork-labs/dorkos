---
id: 260821-185906
title: The schedule approval moment — informed consent, not a shrug
status: specified
created: 2026-08-21
design-session: .dork/visual-companion/46793-1787328179
---

# Specification: the schedule approval moment

Every claim below was verified against HEAD on 2026-08-21 (two audit passes,
file:line cited). Design authority: `design-decisions.md` in this directory.

## What ships

A pending schedule stops being a one-line shrug and becomes an informed,
demonstrable decision: a card that says who proposed it, why, what it will
do, exactly when it will run — with Approve, Reject (undoable), and
**Run it once** (a supervised test run before you commit). Plus the Inbox
polish wave the operator selected.

Out of scope (operator-decided): duplicate-proposal grouping; a dedicated
review sheet; edit-then-approve UI (the API already supports it; no client
work now).

---

## Task S1 — server: provenance, run-once on pending, nextRuns preview

One PR. These share `TaskSchema`, `routes/tasks.ts`, and the OpenAPI doc;
splitting them guarantees a merge-queue conflict.

### S1.1 Provenance columns

Migration on `pulse_schedules` (`packages/db/src/schema/tasks.ts:4-26`):
add nullable text columns `reason`, `proposed_by_session_id`,
`proposed_by_agent_path`. The existing `cwd` column is dead (never
written/read — verified); the migration MAY drop it as cleanup if the
Drizzle SQLite rebuild is clean, else leave it with a comment.

`TaskSchema` (`packages/shared/src/schemas.ts:3820-3839`) gains:

```ts
reason: z.string().nullable().default(null),
proposedBySessionId: z.string().nullable().default(null),
proposedByAgentPath: z.string().nullable().default(null),
proposedByName: z.string().nullable().default(null), // resolved at read time, not persisted
```

`proposedByName` is resolved when mapping rows (server): look up the agent
identity for `proposedByAgentPath` via
`getAgentIdentityService().describeAgent(path)`
(`services/core/agent-identity/agent-identity-service.ts:289-309`) —
`displayName` if a live identity exists, else null. Resolution failures
degrade to null, never throw.

### S1.2 `tasks_create` captures who and why

`apps/server/src/services/runtimes/claude-code/mcp-tools/task-tools.ts`:

- Add required `reason: z.string()` to `tasks_create`'s input
  (`task-tools.ts:302-311`), described as "Why this schedule should exist,
  in your own words — the operator reads this to decide." A missing/empty
  reason is a tool error asking for one.
- Thread the invoking session into the task tools the same way the
  capability tools already get it: `createDorkOsToolServer`
  (`mcp-tools/index.ts:255-325`) resolves
  `invokingSessionId = session?.sdkSessionId || sessionId` and has
  `session?.cwd`; pass a context provider into `getTasksTools(deps, ...)`
  (`mcp-tools/index.ts:171`) so the create handler stores
  `proposedBySessionId` and `proposedByAgentPath` (= the session's cwd,
  which is how agent identity is keyed — verified in
  `agent-token-env.ts:85-111`).
- The external sessionless `/mcp` registration
  (`services/core/external-mcp/task-tools.ts:45`) passes no session
  context; provenance stays null there, `reason` still required.
- `CreateTaskStoreInput` (`task-store.ts:32-44`) + `createTask` +
  `mapTaskRow` (`task-store.ts:743-762`) carry the three new fields.

### S1.3 The notification names the proposer

`scheduleParkPayload` (`services/notifications/emitters/schedule-park.ts:26-33`)
stops hardcoding `proposedBy: 'An agent'`: resolve the proposer display
name from `proposedByAgentPath` (as S1.1); fall back to `'An agent'` when
nothing resolves. Registry title (`notification-registry.ts:356-367`)
already interpolates `proposedBy` — no format change, real name now. Add
`proposedBySessionId` to the payload/`locate` so the resolved history row
can carry `sessionId` (DTO already supports it).

### S1.4 Run-once works for pending proposals

`POST /api/tasks/:id/trigger` (`routes/tasks.ts:484`) →
`triggerManualRun` (`task-scheduler-service.ts:299`) already executes a
run in an isolated session (`sessionId = run.id`, `unattended: true`,
recorded in `pulse_runs`, trigger `'manual'`). Required work:

- Verify (with a test) that a `pending_approval` task can be triggered —
  `triggerManualRun` does not consult the cron registry, so it should
  work; if any status/enabled guard blocks it, allow exactly
  `pending_approval` through. Runs use the task's stored `permissionMode`
  (server-defaulted `acceptEdits`; agents cannot set it — unchanged).
- Do NOT arm the cron, change `status`, or resolve the standing
  `schedule.parked` condition on a test run.

### S1.5 nextRuns preview for unregistered schedules

`scheduler.getNextRun(id)` reads the live cron registry, and pending
schedules are never registered — so today the API reports `nextRun: null`
for exactly the rows where the operator most needs it (verified:
`routes/tasks.ts:191-197,314-316,392-396`; `task-scheduler-service.ts:400-405`).

- Add `previewNextRuns(cron, timezone, count)` to the scheduler service
  using a transient, never-started `croner` `Cron` instance
  (`nextRuns(count)`); invalid cron → empty array, never throw.
- `TaskSchema` gains `nextRuns: z.array(z.string()).default([])` — first
  3 occurrences, populated for every task with a cron (registered tasks
  may use the live job; unregistered ones the preview). Keep `nextRun`
  as-is for compatibility, but populate it for pending rows too (first
  preview element).

### S1.6 Gates

OpenAPI: run BOTH `pnpm docs:export-api` and
`pnpm --filter=@dorkos/site generate:api-docs`, commit `docs/api`
(openapi-fresh). Changelog fragment with every feat/fix commit subject in
`covers:`. Conformance/tests: task-store round-trip of new fields; MCP
create records provenance; reason required; trigger-on-pending test;
preview edge cases (bad cron, timezone).

---

## Task C1 — client: `ScheduleApprovalCard` (depends on S1)

Replace `ScheduleApprovalRow` (`features/dashboard-attention/ui/ScheduleApprovalRow.tsx`)
with a card composed from the AskCard family
(`features/ask/ui/AskCard.tsx:369-377`). Consumers to swap (all three plus
the barrel): `widgets/inbox-bell/ui/InboxBell.tsx:392`,
`widgets/home/ui/PinnedTriageHeaderView.tsx:492`,
`widgets/pulse/ui/PulseAttentionSection.tsx:82`.

Card anatomy (see mockup in the design session, screen
`01-approval-experience.html`):

- **Face**: `RequestingAgent` pattern (`features/approvals/ui/RequestingAgent.tsx:42-66`)
  fed `task.proposedByAgentPath`; falls back exactly as approvals do.
- **Headline**: `task.displayName ?? task.name`, plus
  "Proposed by «proposedByName ?? 'an agent'» · from "«session title»" ·
  waiting «age»". Session title via
  `useSessionDetail(task.proposedBySessionId, { select: s => s.title })`
  with `dir` = `proposedByAgentPath` (the hook needs the cwd — verified
  `use-session-detail.ts:41-55`); omit the "from" fragment when there is
  no session or the lookup fails. Age from `task.createdAt`.
- **Reason**: `task.reason` quoted, full text, no truncation. When null
  (legacy/external proposals): show `task.description` if it differs from
  the name, else omit the line.
- **Cadence line**: `cronstrue` full text + timezone — wrapped, never
  CSS-truncated.
- **First runs**: from `task.nextRuns` — "First run: «t₀» · then «t₁», «t₂»"
  with friendly local formatting; omit when empty.
- **Instructions reveal**: "Show exact instructions" disclosure rendering
  `task.prompt` verbatim in a scrollable monospace block; collapsed by
  default (progressive disclosure).
- **Actions**: Approve (primary) — `useUpdateTask` `{status:'active',
enabled:true}` (unchanged); Reject (ghost); **Run it once** —
  `useTriggerTask()` (`entities/tasks/model/use-tasks.ts:68-79`, already
  exists), then watch that run via `useTaskRuns({scheduleId, limit:…})`
  (`entities/tasks/model/use-task-runs.ts:14-25`, polls while running) and
  render a result strip: running → "Test run in progress…", finished →
  "Test run finished «age» — view what it did →" linking to
  `/session?session=«run.sessionId»&dir=«?»` when the run has a session,
  else to `/tasks` history. Failed → honest failure line. Approve/Reject
  stay available throughout.
- **Keyboard**: `AskCard.Root`'s A/D contract (`onAllow`/`onDeny`), same
  focus scoping (`AskCard.tsx:142-156`).
- **Receipt + undo**: on Approve — receipt "Approved — first run «t₀»"
  (tone `allowed`), then the standard `askExitTransition` hold-and-melt.
  On Reject — receipt "Rejected · Undo" (tone `denied`) with a live Undo
  button; the DELETE is **deferred** ~5s in a module-level scheduler that
  survives popover unmount (fires on window unload too); Undo cancels it
  and restores the card. The mutation only reaches the server after the
  window closes — no server-side undo needed. Failure of the eventual
  DELETE surfaces via the app's single failure toast; the standing row
  will reappear on the next data tick (state stays honest).
- **Motion**: entrance/exit through `AskCard.Root` — decided cards hold
  0.4s and melt 0.2s (`ask-exit-transition.ts:37-45`), reduced-motion
  respected. The three consumer lists must wrap the cards in
  `AnimatePresence` where they don't already.

Tests: RTL for every consumer surface that renders the card (grep for
mounting parents — run all tests rendering changed components), receipt
and undo timing (fake timers; prove the deferred DELETE fires and that
Undo prevents it), keyboard answers, reveal, and the run-once state
machine against a mock transport.

---

## Task C2 — client: popover copy, mobile a11y, all-clear motion

`widgets/inbox-bell/ui/InboxBell.tsx`:

- Copy: one honest summary per state. `waitingSummary`
  (`InboxBell.tsx:80-91`) speaks in the right nouns — schedules are
  approvals, not "requests waiting for your answer"; when only schedules
  wait: "2 schedules want your approval." Drop the "Scheduled Runs"
  sub-explainer sentence (`InboxBell.tsx:373-376`) — the card now carries
  its own context; keep the sub-header.
- A11y: all four `hidden md:block` section headings
  (`InboxBell.tsx:323,370,416,466`) become visually hidden but
  SR-present below `md` (`sr-only md:not-sr-only` pattern preserving the
  desktop styles).
- Motion: the "All clear ✓" beat (`InboxBell.tsx:400-408`) fades/rises in
  via `motion` with reduced-motion respect (the hook
  `use-pinned-drain-beat.ts` already gates the beat itself).

Update the copy assertions in existing InboxBell tests rather than
weakening them; add an axe-style/heading-presence test for the mobile
drawer if a pattern exists.

## Task C3 — client: Activity faces + burst coalescing

- `features/inbox/ui/InboxRow.tsx`: rows whose notification carries
  `agentId` render an xs `AgentAvatar` (`entities/agent/ui/AgentAvatar.tsx`)
  in place of the generic kind icon (kind icon remains for agent-less
  rows). Resolve visuals via the roster the way other surfaces do; a
  non-roster `agentId` degrades to the kind icon.
- Coalescing: consecutive Activity rows with the same `agentId` + `kind`
  inside a short window collapse to one row ("«Agent» finished 4 runs ·
  12m") that expands in place; expansion state is ephemeral. Read
  semantics: opening the group marks nothing; each row keeps its own
  read state; the group shows the unread dot if any member is unread, and
  "mark all read" behavior is unchanged. Do not break the 50-row live
  page cap or cursor invariants (`entities/notifications` cache — see its
  doc comments before touching).

## Task C4 — client: one derivation of "what's waiting" (after C2 merges)

The popover composes `usePendingApprovals`/`usePendingInteractions`/
`usePendingScheduleApprovals` (`InboxBell.tsx:177-184`) while the
knock/banner machinery derives separately via `useAttentionSignals()`
(`features/notifications/model/use-blocking-arrivals.ts:114-151`). Extract
one shared derivation (entities layer) that both consume, so "what's
blocking" can never disagree between the pill, the popover, the sounds,
and the OS banners. Pure refactor: behavior-preserving, proven by the
existing tests of both consumers plus a new test that the two surfaces
agree on a synthesized mixed state.

---

## Sequencing and machinery

- Wave 1: **S1** and **C2** in parallel (disjoint files). Wave 2 (after
  C2): **C3**, **C4** (both touch inbox surfaces; C4 also waits for C2's
  InboxBell edits). Wave 3 (after S1): **C1**.
- Every task: isolated worktree from `origin/main`, Sonnet/Opus
  implementer, adversarial Opus review per `REVIEW.md` BEFORE the PR
  opens (brief the reviewer on the named repo failure modes:
  declared-validated-unreachable, assertions that cannot fail + mutation
  probes, scope asserted from where you stand, a comment is a claim, the
  fix that makes things worse), fragment `covers:` every feat/fix commit
  subject, merge-queue via bare `gh pr merge --auto`.
- Server PR additionally: openapi-fresh (both commands), migration
  hand-audit (the 0069 precedent), conformance suites stay green.
