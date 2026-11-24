import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CAPABILITY_HOLD_PAUSE_GRACE_MS,
  SessionStateProjector,
  SUBAGENT_SILENCE_TIMEOUT_MS,
} from '../../session-state-projector.js';
import type { RawSessionEvent } from '../../session-state-projector.js';
import { BLOCKING_INTERACTION_EVENT_TYPES } from '@dorkos/shared/session-stream';
import { TIMEOUT_MS, PARK_CEILING_MS } from './session-state-projector.fixtures.js';

describe('SessionStateProjector — status and running children', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Failure mode: the client cannot resolve gaps/dups unless seq is strictly
  // increasing and owned by the projector, not the adapter.
  it('assigns strictly-increasing per-session seq starting at 1; cursor tracks the latest', () => {
    const p = new SessionStateProjector('s1');
    expect(p.getCursor()).toBe(0);
    const a = p.ingest({ type: 'turn_start' });
    const b = p.ingest({ type: 'text_delta', text: 'hi' } as RawSessionEvent);
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(p.getCursor()).toBe(2);
  });

  // Failure mode: lifecycle drift — a turn that started must read as streaming,
  // and finalize back to idle on turn_end so the status badge is correct.
  it('projects lifecycle: idle -> streaming -> idle across a turn', () => {
    const p = new SessionStateProjector('s1');
    expect(p.getStatus().lifecycle).toBe('idle');
    p.ingest({ type: 'turn_start' });
    expect(p.getStatus().lifecycle).toBe('streaming');
    p.ingest({ type: 'turn_end' });
    expect(p.getStatus().lifecycle).toBe('idle');
  });

  // Failure mode: status_change deltas must fold into the held status, not
  // replace it wholesale, so unrelated fields survive a partial update.
  it('folds status_change partials into the held status', () => {
    const p = new SessionStateProjector('s1');
    p.ingest({
      type: 'status_change',
      status: { model: 'claude-x', cost: 0.5 },
    } as RawSessionEvent);
    p.ingest({ type: 'status_change', status: { cost: 0.9 } } as RawSessionEvent);
    const status = p.getStatus();
    expect(status.model).toBe('claude-x');
    expect(status.cost).toBe(0.9);
  });

  // Failure mode: outputTokens clobbered to 0 at turn end — the final
  // status_change carries context/cache totals but NO outputTokens, so a
  // wholesale contextUsage replace would reset the running output-token count.
  // The projector must merge contextUsage field-wise so outputTokens survives
  // and the context/cache fields still update (defeats requirement #4 otherwise).
  it('merges contextUsage field-wise so outputTokens survives the final status', () => {
    const p = new SessionStateProjector('s1');
    // Streaming update: only outputTokens present.
    p.ingest({
      type: 'status_change',
      status: { contextUsage: { outputTokens: 20 } },
    } as RawSessionEvent);
    expect(p.getStatus().contextUsage?.outputTokens).toBe(20);

    // Final update: context/cache totals, NO outputTokens.
    p.ingest({
      type: 'status_change',
      status: { contextUsage: { totalTokens: 100, cacheReadTokens: 80 } },
    } as RawSessionEvent);
    const usage = p.getStatus().contextUsage;
    expect(usage?.outputTokens).toBe(20); // survived the final event
    expect(usage?.totalTokens).toBe(100); // updated
    expect(usage?.cacheReadTokens).toBe(80); // updated
  });

  // Failure mode: todo/subagent tallies feed the status badge; a snapshot
  // todo_update must set total/completed/inProgress and running subagents.
  it('projects todoCounts and runningSubagentCount', () => {
    const p = new SessionStateProjector('s1');
    p.ingest({
      type: 'todo_update',
      action: 'snapshot',
      task: { id: 't1', subject: 'a', status: 'completed' },
      tasks: [
        { id: 't1', subject: 'a', status: 'completed' },
        { id: 't2', subject: 'b', status: 'in_progress' },
        { id: 't3', subject: 'c', status: 'pending' },
      ],
    } as RawSessionEvent);
    expect(p.getStatus().todoCounts).toEqual({ total: 3, completed: 1, inProgress: 1 });

    p.ingest({ type: 'subagent_update', taskId: 'x', status: 'running' } as RawSessionEvent);
    p.ingest({ type: 'subagent_update', taskId: 'y', status: 'running' } as RawSessionEvent);
    expect(p.getStatus().runningSubagentCount).toBe(2);
    p.ingest({ type: 'subagent_update', taskId: 'x', status: 'complete' } as RawSessionEvent);
    expect(p.getStatus().runningSubagentCount).toBe(1);
  });

  // Failure mode (DOR-1100): a background task outlives its turn, so the count
  // must survive `turn_end`. Clearing it beside the capability holds would erase
  // the only account of why an "idle" session is about to speak again. The set
  // then drains itself on the terminal updates, which is the same event that
  // wakes the agent. No leak, no manual clear.
  it('keeps running children counted past their turn, and drains them as each finishes', () => {
    const p = new SessionStateProjector('bg-2');
    p.ingest({ type: 'turn_start' } as RawSessionEvent);
    p.ingest({ type: 'subagent_update', taskId: 'bt1', status: 'running' } as RawSessionEvent);
    p.ingest({ type: 'subagent_update', taskId: 'bt2', status: 'running' } as RawSessionEvent);
    p.ingest({ type: 'turn_end' } as RawSessionEvent);

    // The pair a client reads as "stopped talking, not finished".
    expect(p.getStatus().lifecycle).toBe('idle');
    expect(p.getStatus().runningSubagentCount).toBe(2);

    p.ingest({ type: 'subagent_update', taskId: 'bt1', status: 'complete' } as RawSessionEvent);
    expect(p.getStatus().runningSubagentCount).toBe(1);
    p.ingest({ type: 'subagent_update', taskId: 'bt2', status: 'error' } as RawSessionEvent);
    expect(p.getStatus().runningSubagentCount).toBe(0);
    expect(p.getStatus().lifecycle).toBe('idle');
  });

  // Housekeeping children (spec `ambient-background-tasks`): the runtime marks
  // work it started on its own behalf and asks hosts to keep it out of activity
  // indicators. `runningSubagentCount` is exactly such an indicator — the status
  // line's subagent item reads it — so it must not see them.
  it('leaves housekeeping children out of runningSubagentCount', () => {
    const p = new SessionStateProjector('amb-1');
    p.ingest({ type: 'turn_start' } as RawSessionEvent);
    p.ingest({ type: 'subagent_update', taskId: 'real', status: 'running' } as RawSessionEvent);
    p.ingest({
      type: 'subagent_update',
      taskId: 'chore',
      status: 'running',
      ambient: true,
    } as RawSessionEvent);

    expect(p.getStatus().runningSubagentCount).toBe(1);
    // Tracked all the same: the liveness bound and the stranding sweep still
    // have to retire it, or a client's task panel holds a dead watcher forever.
    expect(p.listRunningSubagents()).toEqual(['real', 'chore']);

    // The progress reports that follow do not repeat the mark, and the count
    // must not gain a member because of that.
    p.ingest({
      type: 'subagent_update',
      taskId: 'chore',
      status: 'running',
    } as RawSessionEvent);
    expect(p.getStatus().runningSubagentCount).toBe(1);

    p.ingest({ type: 'subagent_update', taskId: 'real', status: 'complete' } as RawSessionEvent);
    expect(p.getStatus().runningSubagentCount).toBe(0);
  });

  // DOR-1104: the DOR-1100 set drains on terminal updates and on the stream-end
  // sweep, and a child that produces NEITHER — its turn interrupted, its process
  // killed, a runtime that simply stops reporting — used to sit in the count with
  // no bound and nothing that could ever clear it. On a quiet session no further
  // event arrives to notice, so the bound has to be a clock of its own.
  it('expires a running child that goes silent past the bound once the session is idle', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const p = new SessionStateProjector('leak-1');
    p.ingest({ type: 'turn_start' } as RawSessionEvent);
    p.ingest({ type: 'subagent_update', taskId: 'bt1', status: 'running' } as RawSessionEvent);
    p.ingest({ type: 'turn_end' } as RawSessionEvent);
    expect(p.getStatus().runningSubagentCount).toBe(1);

    // One millisecond short: still the honest "stopped talking, not finished".
    vi.advanceTimersByTime(SUBAGENT_SILENCE_TIMEOUT_MS - 1);
    expect(p.getStatus().runningSubagentCount).toBe(1);

    vi.advanceTimersByTime(1);
    expect(p.getStatus().runningSubagentCount).toBe(0);
    expect(p.listRunningSubagents()).toEqual([]);
  });

  // The same duplicate trap on the OTHER drain (DOR-1120). `markInterrupted`
  // retires through `ingest`, and `ingest` re-enters the sweep on its way in, so
  // a half-emptied set is what lets that sweep retire the ids the loop has not
  // reached yet — a second time. It has to empty the set BEFORE it ingests any of
  // them, for the same reason the sweep does. The state that reaches it: lifecycle
  // `streaming` with NO turn open passes markInterrupted's guard while leaving the
  // sweep's own turn guard open, which is why this cannot lean on the turn check.
  it('emits exactly one retirement per child when markInterrupted drains a stale set', () => {
    vi.useFakeTimers();
    vi.setSystemTime(8_000_000);
    const p = new SessionStateProjector('interrupt-drain');
    p.ingest({ type: 'turn_start' } as RawSessionEvent);
    for (const taskId of ['bt1', 'bt2', 'bt3']) {
      p.ingest({ type: 'subagent_update', taskId, status: 'running' } as RawSessionEvent);
    }
    p.ingest({ type: 'turn_end' } as RawSessionEvent);

    // Streaming without a turn, set BEFORE the clock moves: a status_change is an
    // `ingest`, and one arriving past the bound would spend the sweep early.
    p.ingest({ type: 'status_change', status: { lifecycle: 'streaming' } } as RawSessionEvent);

    // Silence past the bound with the armed sweep cancelled, so the children are
    // stale AND still tracked when markInterrupted runs — let the timer retire
    // them first and this proves nothing.
    p.cancelTimers();
    vi.advanceTimersByTime(SUBAGENT_SILENCE_TIMEOUT_MS);
    expect(p.listRunningSubagents()).toEqual(['bt1', 'bt2', 'bt3']);

    const ingestSpy = vi.spyOn(p, 'ingest');
    p.markInterrupted();

    // The list, not the count: zero is reached either way, and the damage is the
    // extra copies. Each one lands on the client's fold as an id it no longer
    // knows, which is the arm that discounts children still alive.
    expect(ingestSpy.mock.calls.map((c) => c[0])).toEqual([
      { type: 'subagent_update', taskId: 'bt1', status: 'untracked' },
      { type: 'subagent_update', taskId: 'bt2', status: 'untracked' },
      { type: 'subagent_update', taskId: 'bt3', status: 'untracked' },
    ]);
    expect(p.getStatus().lifecycle).toBe('interrupted');
    expect(p.getStatus().runningSubagentCount).toBe(0);
    expect(p.listRunningSubagents()).toEqual([]);
  });
});

describe('SessionStateProjector — pending interactions and holds', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Failure mode: an interaction left pending must surface as a recoverable
  // pending interaction with server-authoritative remainingMs; blocked lifecycle.
  it('projects pending interactions and goes blocked while one is open', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const p = new SessionStateProjector('s1');
    p.ingest({
      type: 'approval_required',
      id: 'tool-1',
      startedAt: Date.now(),
      remainingMs: TIMEOUT_MS,
      toolName: 'Bash',
      input: '{}',
      hasSuggestions: false,
    } as RawSessionEvent);
    expect(p.getStatus().lifecycle).toBe('blocked');
    const pending = p.getPendingInteractions();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe('tool-1');
    expect(pending[0]?.remainingMs).toBe(TIMEOUT_MS);
  });

  // Failure mode (DOR-782): hasPendingInteractions is what keeps the stall
  // watchdog from firing and the write-lock from expiring, so an entry it reads
  // as "still waiting" forever makes a turn IMMORTAL — the watchdog can never
  // close it and the lock can never be reclaimed. Entries do strand: a runtime
  // stream that throws with an approval outstanding never re-drains its event
  // queue, so the interaction_cancelled never arrives. Reading `interactions.size`
  // directly was exactly that bug, and it also regressed markInterrupted (below).
  it('stops counting a pending interaction once it passes the park ceiling', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const p = new SessionStateProjector('s1');
    p.ingest({
      type: 'approval_required',
      id: 'stranded-1',
      startedAt: Date.now(),
      remainingMs: TIMEOUT_MS,
      toolName: 'Bash',
      input: '{}',
      hasSuggestions: false,
    } as RawSessionEvent);
    expect(p.hasPendingInteractions()).toBe(true);

    // Eleven minutes in, the prompt has PARKED (spec `ask-parks-on-timeout`):
    // the turn's silence is still legitimate, so the write-lock is not dropped
    // and the watchdog does not fire.
    vi.setSystemTime(1_000_000 + TIMEOUT_MS + 60_000);
    expect(p.hasPendingInteractions()).toBe(true);
    expect(p.getPendingInteractions()).toHaveLength(1);

    // At and past the PARK CEILING the entry is stale — nobody is waiting on a
    // person any more, whatever the map still holds. The window widened; it did
    // not open. It agrees with the DTO selector, so the two answers to "what is
    // pending" cannot diverge.
    vi.setSystemTime(1_000_000 + PARK_CEILING_MS);
    expect(p.hasPendingInteractions()).toBe(false);
    expect(p.getPendingInteractions()).toHaveLength(0);

    vi.setSystemTime(1_000_000 + PARK_CEILING_MS + 60_000);
    expect(p.hasPendingInteractions()).toBe(false);
  });

  // DOR-939: an in-session capability hold parks the turn on a person the same
  // way an approval does, so it must pause the stall watchdog and hold the lock —
  // but it rides a SEPARATE set (no recovery DTO), so these pin that
  // `hasPendingInteractions` reads it too, and that it self-expires when stranded.
  const HELD_APPROVAL = {
    approvalId: 'appr-1',
    capabilityId: 'mcp.add',
    capabilityTitle: 'Add an MCP server',
    tier: 'destructive' as const,
    summary: 'Prober wants to run "Add an MCP server"',
    hasAgentPath: true,
    requestedAt: new Date(1_000_000).toISOString(),
    expiresAt: new Date(1_000_000 + 7_200_000).toISOString(),
  };
  const HOLD_CAP_MS = 45_000;

  it('pauses the stall watchdog while a capability call is held, then un-pauses on resolution', () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' });
    p.ingest({
      type: 'capability_approval_required',
      approval: HELD_APPROVAL,
      startedAt: Date.now(),
      capMs: HOLD_CAP_MS,
    } as RawSessionEvent);
    // The turn is legitimately parked on a person — the watchdog stays paused and
    // the lock is not stealable, exactly as for the three interaction kinds.
    expect(p.hasPendingInteractions()).toBe(true);
    expect(p.getStatus().lifecycle).toBe('blocked');

    p.ingest({
      type: 'capability_approval_resolved',
      approvalId: 'appr-1',
      outcome: 'granted',
    } as RawSessionEvent);
    // Resolved MID-turn (the held tool call resumes), so it settles back to
    // streaming — not idle — and the watchdog re-arms for the rest of the turn.
    expect(p.hasPendingInteractions()).toBe(false);
    expect(p.getStatus().lifecycle).toBe('streaming');
  });

  // The regression DOR-987 found, in the two shapes it takes: a turn interrupted
  // with a hold open never delivers `capability_approval_resolved` (the
  // message-sender drains its event queue only at the top of its loop, never
  // after a break or a throw), so the entry strands — and settling the lifecycle
  // off the map's RAW SIZE then pinned every LATER interaction at `blocked`.
  // TWO fixes answer it, and the cases below pin one each, written apart on
  // purpose: a single case that ends `streaming` is satisfied by EITHER fix.

  /** Ask a person something and get an answer, on a turn that is already open. */
  function askAndAnswer(p: SessionStateProjector, id: string): void {
    p.ingest({
      type: 'approval_required',
      id,
      startedAt: Date.now(),
      remainingMs: TIMEOUT_MS,
      toolName: 'Bash',
      input: '{}',
      hasSuggestions: false,
    } as RawSessionEvent);
    expect(p.getStatus().lifecycle).toBe('blocked');
    p.ingest({ type: 'interaction_resolved', id } as RawSessionEvent);
  }

  it('drops a hold its turn ended on, even while the hold is still inside its cap', () => {
    // Pins `turn_end` clearing the map, and ONLY that: every clock read here is
    // inside cap + grace, so the time bound still calls this hold live. A held
    // tool call cannot outlive its turn, so the entry is stranded by definition.
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' });
    p.ingest({
      type: 'capability_approval_required',
      approval: HELD_APPROVAL,
      startedAt: Date.now(),
      capMs: HOLD_CAP_MS,
    } as RawSessionEvent);
    p.ingest({ type: 'turn_end' });

    // A LATER turn, still well inside the hold's own window.
    vi.setSystemTime(1_000_000 + HOLD_CAP_MS - 1);
    p.ingest({ type: 'turn_start' });
    askAndAnswer(p, 'int-1');

    // Settled back into the live turn, exactly as a session that never held.
    expect(p.getStatus().lifecycle).toBe('streaming');
    expect(p.hasPendingInteractions()).toBe(false);
  });

  it('stops counting a hold that ran out its cap while the SAME turn kept going', () => {
    // Pins the time-bounded read, and ONLY that: there is no `turn_end` here, so
    // nothing ever clears the map. The hold degraded to the poll payload and the
    // turn carried on — its entry must stop deciding the lifecycle.
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' });
    p.ingest({
      type: 'capability_approval_required',
      approval: HELD_APPROVAL,
      startedAt: Date.now(),
      capMs: HOLD_CAP_MS,
    } as RawSessionEvent);

    vi.setSystemTime(1_000_000 + HOLD_CAP_MS + CAPABILITY_HOLD_PAUSE_GRACE_MS);
    askAndAnswer(p, 'int-1');

    expect(p.getStatus().lifecycle).toBe('streaming');
    expect(p.hasPendingInteractions()).toBe(false);
  });

  // Failure mode (drift pin): the projector's switch enumerates the three
  // blocking interactions by hand, because a switch cannot be driven by a
  // constant. A fourth member added to BLOCKING_INTERACTION_EVENT_TYPES would
  // be honored by every consumer that reads the list (the Telegram typing loop,
  // the Slack working indicator) and silently dropped here by `default: break`,
  // leaving a session that reads `streaming` while it waits on a person.
  it('goes blocked for every member of BLOCKING_INTERACTION_EVENT_TYPES', () => {
    for (const type of BLOCKING_INTERACTION_EVENT_TYPES) {
      const p = new SessionStateProjector('s1');
      p.ingest({
        type,
        id: `int-${type}`,
        startedAt: Date.now(),
        remainingMs: TIMEOUT_MS,
        toolName: 'Bash',
        input: '{}',
        hasSuggestions: false,
      } as unknown as RawSessionEvent);
      expect(p.getStatus().lifecycle, `${type} must block the session`).toBe('blocked');
      expect(p.getPendingInteractions(), `${type} must be pending`).toHaveLength(1);
    }
  });

  // Failure mode (CLI-C1): resolution must flow through the seq'd stream —
  // a live subscriber (this window, another window) must see the removal, and
  // replay must reproduce it. A silent map delete left ghost Approve/Deny
  // cards everywhere except the resolving window's optimistic UI.
  it("resolveInteraction ingests a seq'd interaction_resolved event (replayable, settles lifecycle)", () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' }); // seq 1
    p.ingest({
      type: 'approval_required',
      id: 'tool-1',
      startedAt: Date.now(),
      remainingMs: TIMEOUT_MS,
      toolName: 'Bash',
      input: '{}',
      hasSuggestions: false,
    } as RawSessionEvent); // seq 2
    expect(p.getStatus().lifecycle).toBe('blocked');

    p.resolveInteraction('tool-1', 'approved');

    // The resolution is a real seq'd event: present in replay for resuming clients.
    const replayed = p.replayFrom(2);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toMatchObject({ type: 'interaction_resolved', id: 'tool-1', seq: 3 });
    // Pending cleared and lifecycle settled back (turn still in progress → streaming).
    expect(p.getPendingInteractions()).toEqual([]);
    expect(p.getStatus().lifecycle).toBe('streaming');
  });

  // Failure mode: the resolution retires the ONLY record of what the
  // interaction was and when it began, so a consumer that needs either has no
  // way to recover it afterwards. Without the kind, a client cannot tell a
  // timed-out question from a timed-out permission prompt (both resolve
  // `expired`); without the start time it cannot say how long the request
  // waited. Both are read from the entry this event is about to drop.
  it('stamps a resolution with the kind and start time of what it retires', () => {
    const p = new SessionStateProjector('s1');
    const startedAt = Date.now();
    p.ingest({
      type: 'approval_required',
      id: 'tool-1',
      startedAt,
      remainingMs: TIMEOUT_MS,
      toolName: 'Bash',
      input: '{}',
      hasSuggestions: false,
    } as RawSessionEvent);

    const resolved = p.ingest({
      type: 'interaction_resolved',
      id: 'tool-1',
      resolution: 'approved',
    } as RawSessionEvent);

    expect(resolved).toMatchObject({ kind: 'approval', startedAt });
  });
});
