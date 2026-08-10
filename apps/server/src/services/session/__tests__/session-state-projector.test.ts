import { getEventListeners } from 'node:events';
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SessionStateProjector,
  CAPABILITY_HOLD_PAUSE_GRACE_MS,
  SUBAGENT_SILENCE_TIMEOUT_MS,
  getOrCreateProjector,
  peekProjector,
  disposeProjector,
  rekeyProjector,
  onProjectorRekey,
  onProjectorStatusChange,
} from '../session-state-projector.js';
import type { RawSessionEvent, ProjectorStatusUpdate } from '../session-state-projector.js';
import { EVENT_LOG_MAX_EVENTS } from '../event-log.js';
import {
  StaleResumeCursorError,
  BLOCKING_INTERACTION_EVENT_TYPES,
} from '@dorkos/shared/session-stream';
import type { HistoryMessage } from '@dorkos/shared/types';

const TIMEOUT_MS = 10 * 60 * 1000;

/** Drain up to `count` events from an async iterable, then return them. */
async function take(iter: AsyncIterable<unknown>, count: number): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const e of iter) {
    out.push(e);
    if (out.length >= count) break;
  }
  return out;
}

describe('SessionStateProjector', () => {
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
    p.ingest({ type: 'status_change', status: { model: 'claude-x', cost: 0.5 } });
    p.ingest({ type: 'status_change', status: { cost: 0.9 } });
    const status = p.getStatus();
    expect(status.model).toBe('claude-x');
    expect(status.cost).toBe(0.9);
  });

  // Failure mode: a usage-only status_change (Claude rate_limit_event) would zero
  // the held cost/model if it replaced the status wholesale. The usage folds in
  // and unrelated fields survive; the cold status starts with usage null.
  it('folds a usage-only status_change without zeroing cost/model', () => {
    const p = new SessionStateProjector('s1');
    expect(p.getStatus().usage).toBeNull();
    p.ingest({ type: 'status_change', status: { model: 'claude-x', cost: 0.5 } });
    p.ingest({
      type: 'status_change',
      status: { usage: { kind: 'subscription', utilization: 0.6, state: 'ok' } },
    });
    const status = p.getStatus();
    expect(status.model).toBe('claude-x');
    expect(status.cost).toBe(0.5);
    expect(status.usage).toMatchObject({ kind: 'subscription', utilization: 0.6 });
  });

  // Failure mode: a later cost-only status must not drop a prior usage — the
  // whole-object usage is preserved when a partial omits it.
  it('preserves prior usage when a later status_change omits it', () => {
    const p = new SessionStateProjector('s1');
    p.ingest({
      type: 'status_change',
      status: { usage: { kind: 'subscription', utilization: 0.3 } },
    });
    p.ingest({ type: 'status_change', status: { cost: 1.2 } });
    const status = p.getStatus();
    expect(status.cost).toBe(1.2);
    expect(status.usage).toMatchObject({ kind: 'subscription', utilization: 0.3 });
  });

  // Failure mode: outputTokens clobbered to 0 at turn end — the final
  // status_change carries context/cache totals but NO outputTokens, so a
  // wholesale contextUsage replace would reset the running output-token count.
  // The projector must merge contextUsage field-wise so outputTokens survives
  // and the context/cache fields still update (defeats requirement #4 otherwise).
  it('merges contextUsage field-wise so outputTokens survives the final status', () => {
    const p = new SessionStateProjector('s1');
    // Streaming update: only outputTokens present.
    p.ingest({ type: 'status_change', status: { contextUsage: { outputTokens: 20 } } });
    expect(p.getStatus().contextUsage?.outputTokens).toBe(20);

    // Final update: context/cache totals, NO outputTokens.
    p.ingest({
      type: 'status_change',
      status: { contextUsage: { totalTokens: 100, cacheReadTokens: 80 } },
    });
    const usage = p.getStatus().contextUsage;
    expect(usage?.outputTokens).toBe(20); // survived the final event
    expect(usage?.totalTokens).toBe(100); // updated
    expect(usage?.cacheReadTokens).toBe(80); // updated
  });

  // Failure mode: a null contextUsage delta must clear the held usage outright
  // (e.g. an explicit reset), not be silently field-merged.
  it('clears contextUsage when a status_change carries an explicit null', () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'status_change', status: { contextUsage: { outputTokens: 5 } } });
    p.ingest({ type: 'status_change', status: { contextUsage: null } });
    expect(p.getStatus().contextUsage).toBeNull();
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
  // the only account of why an "idle" session is about to speak again.
  it('keeps running children counted after the turn that started them closes', () => {
    const p = new SessionStateProjector('bg-1');
    p.ingest({ type: 'turn_start' } as RawSessionEvent);
    p.ingest({ type: 'subagent_update', taskId: 'bt1', status: 'running' } as RawSessionEvent);
    p.ingest({ type: 'subagent_update', taskId: 'bt2', status: 'running' } as RawSessionEvent);
    p.ingest({ type: 'turn_end' } as RawSessionEvent);

    // The pair a client reads as "stopped talking, not finished".
    expect(p.getStatus().lifecycle).toBe('idle');
    expect(p.getStatus().runningSubagentCount).toBe(2);
  });

  // …and the set drains itself on the terminal updates, which is the same event
  // that wakes the agent. No leak, no manual clear.
  it('drains the running-children count as each one finishes past the turn', () => {
    const p = new SessionStateProjector('bg-2');
    p.ingest({ type: 'turn_start' } as RawSessionEvent);
    p.ingest({ type: 'subagent_update', taskId: 'bt1', status: 'running' } as RawSessionEvent);
    p.ingest({ type: 'subagent_update', taskId: 'bt2', status: 'running' } as RawSessionEvent);
    p.ingest({ type: 'turn_end' } as RawSessionEvent);

    p.ingest({ type: 'subagent_update', taskId: 'bt1', status: 'complete' } as RawSessionEvent);
    expect(p.getStatus().runningSubagentCount).toBe(1);
    p.ingest({ type: 'subagent_update', taskId: 'bt2', status: 'error' } as RawSessionEvent);
    expect(p.getStatus().runningSubagentCount).toBe(0);
    expect(p.getStatus().lifecycle).toBe('idle');
  });

  // Eviction tears a session down without ever running a stream's `finally`, so
  // the stranding sweep never fires there. A count left standing would report
  // live work for a session that no longer exists (DOR-1100).
  it('retires running children when a turn is marked interrupted', () => {
    const p = new SessionStateProjector('bg-4');
    p.ingest({ type: 'turn_start' } as RawSessionEvent);
    p.ingest({ type: 'subagent_update', taskId: 'bt1', status: 'running' } as RawSessionEvent);
    p.ingest({ type: 'subagent_update', taskId: 'bt2', status: 'running' } as RawSessionEvent);
    expect(p.getStatus().runningSubagentCount).toBe(2);

    const ingestSpy = vi.spyOn(p, 'ingest');
    p.markInterrupted();

    expect(p.getStatus().lifecycle).toBe('interrupted');
    expect(p.getStatus().runningSubagentCount).toBe(0);
    expect(p.listRunningSubagents()).toEqual([]);
    // Retired through the STREAM, so a client folding its own count drains the
    // same ids the server just dropped rather than holding them forever — and
    // as `untracked`, because tearing the session down tells us nothing about
    // whether its children died with it (DOR-1108).
    expect(ingestSpy.mock.calls.map((c) => c[0])).toEqual([
      { type: 'subagent_update', taskId: 'bt1', status: 'untracked' },
      { type: 'subagent_update', taskId: 'bt2', status: 'untracked' },
    ]);
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

  // It drains through the STREAM, like every other retirement, so a client that
  // folds its own count (the cockpit does) drops the same id instead of holding
  // it forever while the server reads zero. And `untracked` (DOR-1108): silence
  // is not evidence of a stop.
  it('retires an expired child through the stream as untracked', () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    const p = new SessionStateProjector('leak-2');
    p.ingest({ type: 'turn_start' } as RawSessionEvent);
    p.ingest({ type: 'subagent_update', taskId: 'bt1', status: 'running' } as RawSessionEvent);
    p.ingest({ type: 'turn_end' } as RawSessionEvent);

    const ingestSpy = vi.spyOn(p, 'ingest');
    vi.advanceTimersByTime(SUBAGENT_SILENCE_TIMEOUT_MS);

    expect(ingestSpy.mock.calls.map((c) => c[0])).toEqual([
      { type: 'subagent_update', taskId: 'bt1', status: 'untracked' },
    ]);
  });

  // The bound is on SILENCE, not on age: a child that keeps reporting keeps its
  // place however long it runs. Without this the fix would cap every background
  // task at the window and cut real work off mid-flight.
  it('keeps a child that is still reporting, however long it has run', () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000_000);
    const p = new SessionStateProjector('leak-3');
    p.ingest({ type: 'turn_start' } as RawSessionEvent);
    p.ingest({ type: 'subagent_update', taskId: 'bt1', status: 'running' } as RawSessionEvent);
    p.ingest({ type: 'turn_end' } as RawSessionEvent);

    // Four windows' worth of work, each one broken by a progress report.
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(SUBAGENT_SILENCE_TIMEOUT_MS - 1_000);
      p.ingest({
        type: 'subagent_update',
        taskId: 'bt1',
        status: 'running',
        toolUses: i + 1,
      } as RawSessionEvent);
    }
    expect(p.getStatus().runningSubagentCount).toBe(1);

    // …and it goes when the reports do.
    vi.advanceTimersByTime(SUBAGENT_SILENCE_TIMEOUT_MS);
    expect(p.getStatus().runningSubagentCount).toBe(0);
  });

  // The clock only runs while the session is idle. A quiet child during a turn
  // the agent is still working is not suspicious — the agent is right there, and
  // finishing is what wakes it. Expiring one mid-turn would delete a live child
  // out from under the turn that is about to hear from it.
  it('does not expire a child while a turn is still open', () => {
    vi.useFakeTimers();
    vi.setSystemTime(4_000_000);
    const p = new SessionStateProjector('leak-4');
    p.ingest({ type: 'turn_start' } as RawSessionEvent);
    p.ingest({ type: 'subagent_update', taskId: 'bt1', status: 'running' } as RawSessionEvent);

    vi.advanceTimersByTime(SUBAGENT_SILENCE_TIMEOUT_MS * 3);
    expect(p.getStatus().runningSubagentCount).toBe(1);

    // The window starts over when the turn closes, not when the child last spoke:
    // a long turn must not hand the child a deadline that has already passed.
    p.ingest({ type: 'turn_end' } as RawSessionEvent);
    vi.advanceTimersByTime(SUBAGENT_SILENCE_TIMEOUT_MS - 1);
    expect(p.getStatus().runningSubagentCount).toBe(1);
    vi.advanceTimersByTime(1);
    expect(p.getStatus().runningSubagentCount).toBe(0);
  });

  // A snapshot reconciles too, so a tab opened after the deadline passed reads
  // the truth even if the timer never got to run (a suspended process, a
  // projector nothing has touched since).
  it('reconciles the expired count when a snapshot is built', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000_000);
    const p = new SessionStateProjector('leak-5');
    p.ingest({ type: 'turn_start' } as RawSessionEvent);
    p.ingest({ type: 'subagent_update', taskId: 'bt1', status: 'running' } as RawSessionEvent);
    p.ingest({ type: 'turn_end' } as RawSessionEvent);
    // Cancel the armed sweep the way disposal does, so only the snapshot can fix
    // this — otherwise the timer would answer and the reconcile prove nothing.
    p.cancelTimers();

    vi.advanceTimersByTime(SUBAGENT_SILENCE_TIMEOUT_MS);
    const snapshot = await p.buildSnapshot(async () => []);
    expect(snapshot.status.runningSubagentCount).toBe(0);
  });

  // A reopened window (DOR-1100) is a real turn as far as the projection is
  // concerned: it streams, it clears the previous failure, and it does not
  // disturb the children still running underneath it.
  it('streams again on a reopened turn without disturbing the running children', () => {
    const p = new SessionStateProjector('bg-3');
    p.ingest({ type: 'turn_start' } as RawSessionEvent);
    p.ingest({ type: 'subagent_update', taskId: 'bt1', status: 'running' } as RawSessionEvent);
    p.ingest({ type: 'turn_end' } as RawSessionEvent);
    expect(p.getStatus().lifecycle).toBe('idle');

    p.ingest({ type: 'turn_start' } as RawSessionEvent);
    expect(p.getStatus().lifecycle).toBe('streaming');
    expect(p.getStatus().runningSubagentCount).toBe(1);
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
  it('stops counting a pending interaction once it passes the interaction timeout', () => {
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

    // One tick short of the exclusive boundary: still a live wait.
    vi.setSystemTime(1_000_000 + TIMEOUT_MS - 1);
    expect(p.hasPendingInteractions()).toBe(true);

    // At and past the boundary the entry is stale — nobody is waiting on a
    // person any more, whatever the map still holds. It agrees with the DTO
    // selector, so the two answers to "what is pending" cannot diverge.
    vi.setSystemTime(1_000_000 + TIMEOUT_MS);
    expect(p.hasPendingInteractions()).toBe(false);
    expect(p.getPendingInteractions()).toHaveLength(0);

    vi.setSystemTime(1_000_000 + TIMEOUT_MS * 100);
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

  it('stops pausing once a STRANDED capability hold passes its cap and its grace', () => {
    // The turn threw with a hold outstanding, so no resolution ever arrives. The
    // hold must not pin the watchdog forever — it self-expires at its own cap
    // (plus the grace), the same immortality guard the interaction set carries.
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const p = new SessionStateProjector('s1');
    p.ingest({
      type: 'capability_approval_required',
      approval: HELD_APPROVAL,
      startedAt: Date.now(),
      capMs: HOLD_CAP_MS,
    } as RawSessionEvent);
    expect(p.hasPendingInteractions()).toBe(true);

    // One tick short of the cap: still a live wait.
    vi.setSystemTime(1_000_000 + HOLD_CAP_MS - 1);
    expect(p.hasPendingInteractions()).toBe(true);

    // AT the cap the pause is still held: the hold's own degradation fires on the
    // same millisecond, and its resolution needs to reach the stream before the
    // watchdog re-arms — see CAPABILITY_HOLD_PAUSE_GRACE_MS.
    vi.setSystemTime(1_000_000 + HOLD_CAP_MS);
    expect(p.hasPendingInteractions()).toBe(true);

    // Past cap + grace the hold is stale — nobody is waiting any more, whatever
    // the map still holds.
    vi.setSystemTime(1_000_000 + HOLD_CAP_MS + CAPABILITY_HOLD_PAUSE_GRACE_MS);
    expect(p.hasPendingInteractions()).toBe(false);
  });

  // The regression DOR-987 found, in the two shapes it takes: a turn interrupted
  // with a hold open never delivers `capability_approval_resolved` (the
  // message-sender drains its event queue only at the top of its loop, never
  // after a break or a throw), so the entry strands — and settling the lifecycle
  // off the map's RAW SIZE then pinned every LATER interaction at `blocked`.
  //
  // TWO fixes answer it, and each of these pins exactly one. Written apart on
  // purpose: a single case that ends `streaming` is satisfied by EITHER fix, so
  // it stayed green when a reviewer reverted either one alone.

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

  it('does not treat an interrupted turn as still waiting on a person', () => {
    // markInterrupted leaves `interactions` populated by design, so the raw-size
    // read made every interrupted turn look permanently blocked — a turn the
    // pre-DOR-782 watchdog would have closed became one it never could.
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' });
    p.ingest({
      type: 'approval_required',
      id: 'int-1',
      startedAt: Date.now(),
      remainingMs: TIMEOUT_MS,
      toolName: 'Bash',
      input: '{}',
      hasSuggestions: false,
    } as RawSessionEvent);
    p.markInterrupted();
    expect(p.getStatus().lifecycle).toBe('interrupted');

    // Still inside the window, the wait is real and the guard stays paused.
    expect(p.hasPendingInteractions()).toBe(true);
    // Past it, the guard is armed again and the lock is reclaimable.
    vi.setSystemTime(1_000_000 + TIMEOUT_MS);
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

  // Failure mode: a stale prompt must never be re-presented; an interaction past
  // the timeout boundary (remainingMs <= 0) is excluded from the snapshot.
  it('excludes expired interactions at the exclusive timeout boundary', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const p = new SessionStateProjector('s1');
    p.ingest({
      type: 'approval_required',
      id: 'tool-1',
      startedAt: 0,
      remainingMs: TIMEOUT_MS,
      toolName: 'Bash',
      input: '{}',
      hasSuggestions: false,
    } as RawSessionEvent);
    // Advance to exactly the timeout: remainingMs === 0 -> excluded.
    vi.setSystemTime(TIMEOUT_MS);
    expect(p.getPendingInteractions()).toEqual([]);
  });

  // Failure mode: resolving an interaction (deny/approve) must remove it from
  // the pending map so it does not reappear on reconnect.
  it('clears a pending interaction once resolved', () => {
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
    expect(p.getPendingInteractions()).toHaveLength(1);
    p.resolveInteraction('tool-1');
    expect(p.getPendingInteractions()).toEqual([]);
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

  it('stamps a resolved question as a question, not an approval', () => {
    // Purpose: the distinction the stamp exists for. A question and a
    // permission prompt resolve through the same path with the same values.
    const p = new SessionStateProjector('s1');
    p.ingest({
      type: 'question_prompt',
      id: 'q-1',
      startedAt: Date.now(),
      remainingMs: TIMEOUT_MS,
      questions: [],
    } as unknown as RawSessionEvent);

    const resolved = p.ingest({
      type: 'interaction_resolved',
      id: 'q-1',
      resolution: 'expired',
    } as RawSessionEvent);

    expect(resolved).toMatchObject({ kind: 'question' });
  });

  it('leaves an untracked resolution unstamped rather than inventing a kind', () => {
    // Purpose: degrade to "an interaction resolved" — an id this projector never
    // tracked has no kind to report, and guessing one would be worse than none.
    const p = new SessionStateProjector('s1');
    const resolved = p.ingest({
      type: 'interaction_resolved',
      id: 'never-tracked',
      resolution: 'expired',
    } as RawSessionEvent);

    expect(resolved).not.toHaveProperty('kind');
    expect(resolved).not.toHaveProperty('startedAt');
  });

  it('resolveInteraction is a no-op for an unknown id (stale click emits nothing)', () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' }); // seq 1
    p.resolveInteraction('never-tracked', 'denied');
    expect(p.getCursor()).toBe(1); // no event emitted
  });

  // Failure mode: replay over live overlap must not duplicate or skip; cursor is
  // strictly exclusive against the buffered events.
  it('replayFrom returns only events with seq greater than the cursor', () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' });
    p.ingest({ type: 'text_delta', text: 'a' } as RawSessionEvent);
    p.ingest({ type: 'text_delta', text: 'b' } as RawSessionEvent);
    expect(p.replayFrom(1).map((e) => e.seq)).toEqual([2, 3]);
    expect(p.replayFrom(3)).toEqual([]);
  });

  // Failure mode: multi-turn replay must not drop the prior turn's tail across
  // the ring-clear boundary — the ring holds only the new turn after
  // markTurnStarted, so a cursor predating it must fall back to the EventLog for
  // the missed seqs without losing the new turn's events (gap-free, spec §B.3).
  it('replayFrom merges ring + log so the prior turn is not dropped across a new turn', () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' }); // seq 1
    p.ingest({ type: 'text_delta', text: 'a' } as RawSessionEvent); // seq 2
    p.ingest({ type: 'turn_end' }); // seq 3
    p.ingest({ type: 'turn_start' }); // seq 4 (clears the ring)
    p.ingest({ type: 'text_delta', text: 'b' } as RawSessionEvent); // seq 5

    // A client resuming at seq 1 must receive the full range, including the prior
    // turn's tail (seq 2) and its turn_end (seq 3), not just the current turn.
    expect(p.replayFrom(1).map((e) => e.seq)).toEqual([2, 3, 4, 5]);
    // Resuming at seq 2 still includes the prior turn's turn_end (seq 3).
    expect(p.replayFrom(2).map((e) => e.seq)).toEqual([3, 4, 5]);
    // No duplicates where the ring and log overlap on the current turn.
    expect(p.replayFrom(3).map((e) => e.seq)).toEqual([4, 5]);
  });

  // Failure mode: the snapshot must combine injected history with the live
  // projection and report the current cursor as the resume point.
  it('buildSnapshot assembles messages from the injected loader plus projection', async () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' });
    p.ingest({ type: 'text_delta', text: 'live' } as RawSessionEvent);
    const history: HistoryMessage[] = [
      { id: 'm1', role: 'user', content: 'hello', timestamp: '2026-01-01T00:00:00Z' },
    ];
    const snap = await p.buildSnapshot(async () => history);
    expect(snap.messages).toEqual(history);
    expect(snap.cursor).toBe(2);
    expect(snap.inProgressTurn?.map((e) => e.type)).toEqual(['turn_start', 'text_delta']);
    expect(snap.status.lifecycle).toBe('streaming');
  });

  // Failure mode: an idle session must report a null in-progress turn, not an
  // empty array, so the client distinguishes "no turn" from "empty turn".
  it('buildSnapshot reports null inProgressTurn when idle', async () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' });
    p.ingest({ type: 'turn_end' });
    const snap = await p.buildSnapshot(async () => []);
    expect(snap.inProgressTurn).toBeNull();
  });

  // Failure mode: snapshot-then-subscribe race — a subscriber resuming at a
  // cursor must receive the missed events (replay) then live ones, with no gaps
  // and no duplicates across the boundary.
  it('subscribe(sinceCursor) yields replay-then-live with no dup or gap', async () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' }); // seq 1
    p.ingest({ type: 'text_delta', text: 'a' } as RawSessionEvent); // seq 2 (missed by client)

    const iter = p.subscribe(1)[Symbol.asyncIterator]();
    // First yield is the replayed seq-2 event.
    const first = await iter.next();
    expect((first.value as { seq: number }).seq).toBe(2);

    // A live event ingested after subscription must arrive next, contiguous.
    p.ingest({ type: 'text_delta', text: 'b' } as RawSessionEvent); // seq 3
    const second = await iter.next();
    expect((second.value as { seq: number }).seq).toBe(3);
  });

  // Failure mode: a fresh subscriber with no cursor must still receive live
  // events as they are ingested.
  it('subscribe() with no cursor yields live events', async () => {
    const p = new SessionStateProjector('s1');
    const collected = take(p.subscribe(), 2);
    p.ingest({ type: 'turn_start' });
    p.ingest({ type: 'text_delta', text: 'x' } as RawSessionEvent);
    const events = (await collected) as Array<{ seq: number }>;
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
  });

  // Failure mode (I2): a parked subscriber whose AbortSignal fires (the route's
  // client-disconnect path) must remove its waiter, or the projector leaks a
  // dangling resolver per disconnect. A bare iterator.return() cannot do this —
  // it is queued behind the un-settleable parked wait — so the signal is the
  // deterministic teardown that lets the generator's finally run.
  it('subscribe(signal) removes its parked waiter when the signal aborts', async () => {
    const p = new SessionStateProjector('s1');
    const ac = new AbortController();
    const iter = p.subscribe(0, ac.signal)[Symbol.asyncIterator]();
    // First next() parks a waiter (no buffered events yet).
    const pending = iter.next();
    await Promise.resolve(); // let the generator register its waiter
    expect(p.getWaiterCount()).toBe(1);

    // Abort (what the route does on client disconnect): the parked wait resolves
    // to the ABORTED sentinel, the generator returns, and its finally splices
    // the resolver out of the waiters list.
    ac.abort();
    const result = await pending;
    expect(result.done).toBe(true);
    expect(p.getWaiterCount()).toBe(0);

    // A subsequent ingest must not error or grow the waiter set — proving no
    // dangling resolver was left to fire against a dead generator.
    expect(() => p.ingest({ type: 'turn_start' })).not.toThrow();
    expect(p.getWaiterCount()).toBe(0);
  });

  // Failure mode (SRV-I1): every park raced an abort listener registered with
  // {once:true}, which only auto-removes when abort FIRES — so the normal
  // delivered-event path accumulated one listener (and one retained closure)
  // per event for the connection's lifetime: MaxListenersExceededWarning at 11,
  // unbounded growth on an hours-long durable stream.
  it('does not accumulate abort listeners across delivered events (one park = one listener, removed)', async () => {
    const p = new SessionStateProjector('s1');
    const ac = new AbortController();
    const collected = take(p.subscribe(0, ac.signal), 25);
    for (let i = 0; i < 25; i++) {
      // Yield to the event loop so the generator re-parks (and re-registers an
      // abort listener) for EVERY event — the exact leak shape.
      await new Promise((r) => setImmediate(r));
      p.ingest({ type: 'text_delta', text: String(i) } as RawSessionEvent);
    }
    await collected;
    expect(getEventListeners(ac.signal, 'abort').length).toBeLessThanOrEqual(1);
  });

  // Failure mode (SRV-I3): the no-404 policy creates a projector for ANY
  // well-formed id a client opens `/events` for. Without self-dispose, every
  // casually-browsed session id pins an empty projector in the registry for the
  // server's lifetime (unbounded growth, hostile or not).
  it('an empty projector self-disposes from the registry when its last subscriber detaches', async () => {
    const id = 'i3-empty-self-dispose';
    const p = getOrCreateProjector(id);
    const ac = new AbortController();
    const pending = p.subscribe(0, ac.signal)[Symbol.asyncIterator]().next();
    await Promise.resolve(); // let the generator park
    ac.abort();
    await pending;
    expect(peekProjector(id)).toBeUndefined();
  });

  it('a projector with ingested events survives subscriber detach (replay state must remain)', async () => {
    const id = 'i3-live-survives';
    const p = getOrCreateProjector(id);
    p.ingest({ type: 'turn_start' });
    const ac = new AbortController();
    const pending = p.subscribe(1, ac.signal)[Symbol.asyncIterator]().next();
    await Promise.resolve();
    ac.abort();
    await pending;
    expect(peekProjector(id)).toBe(p);
    disposeProjector(id);
  });

  // Failure mode: a server restart leaves a turn streaming with no turn_end;
  // markInterrupted must flip lifecycle so the client stops showing a live spinner.
  it('markInterrupted flips a streaming turn to interrupted', () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' });
    expect(p.getStatus().lifecycle).toBe('streaming');
    p.markInterrupted();
    expect(p.getStatus().lifecycle).toBe('interrupted');
  });

  // Failure mode (C2): an errored turn settles to idle, masking failure on cold
  // hydrate. The detached-error path ingests status_change{error} then a terminal
  // turn_end{terminalReason:'error'}. If turn_end unconditionally derived idle, it
  // would OVERWRITE the error — a hard-refresh snapshot would show a clean idle
  // session and the failure would be invisible. The terminal lifecycle must
  // survive in BOTH the live projection AND the cold snapshot.
  it('settles to error (not idle) when an errored turn ends, in projection and snapshot', async () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' });
    p.ingest({ type: 'status_change', status: { lifecycle: 'error' } });
    p.ingest({ type: 'turn_end', terminalReason: 'error' });

    // Live projection reflects the terminal error, not idle.
    expect(p.getStatus().lifecycle).toBe('error');
    // Cold hydrate (the path a hard-refresh takes) also shows error.
    const snap = await p.buildSnapshot(async () => []);
    expect(snap.status.lifecycle).toBe('error');
  });

  // Failure mode (C2): an interrupted/aborted turn must likewise settle terminal
  // so a cold hydrate shows it was cut short, not cleanly idle. Here the turn
  // closes with an abort terminalReason (no prior error status_change).
  it('settles to interrupted (not idle) when a turn ends with an abort terminalReason', async () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' });
    p.ingest({ type: 'turn_end', terminalReason: 'aborted_streaming' });

    expect(p.getStatus().lifecycle).toBe('interrupted');
    const snap = await p.buildSnapshot(async () => []);
    expect(snap.status.lifecycle).toBe('interrupted');
  });

  // Failure mode (C2 guard): a normal completion must STILL settle idle — the
  // terminal-lifecycle handling is scoped to error/abort reasons only.
  it('still settles to idle when a turn ends cleanly (completed)', () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' });
    p.ingest({ type: 'turn_end', terminalReason: 'completed' });
    expect(p.getStatus().lifecycle).toBe('idle');
  });

  // A cold projector has no failure to surface.
  it('starts with a null lastError on the cold status', () => {
    const p = new SessionStateProjector('s1');
    expect(p.getStatus().lastError).toBeNull();
  });

  // Failure mode: a typed error must latch its details into the status WITHOUT
  // settling the lifecycle — non-terminal errors exist (e.g. a Codex item_error
  // the turn recovers from); terminal settling is owned by turn_end.
  it('projects an error event into lastError without touching lifecycle', () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' });
    p.ingest({
      type: 'error',
      message: 'boom',
      code: 'turn_exception',
      category: 'execution_error',
      details: 'stack',
    } as RawSessionEvent);
    const status = p.getStatus();
    expect(status.lifecycle).toBe('streaming'); // untouched
    expect(status.lastError).toEqual({
      message: 'boom',
      code: 'turn_exception',
      category: 'execution_error',
      details: 'stack',
    });
  });

  // The reconnect guarantee: a hard-refresh (cold hydrate) must still see the
  // failure details, not just the error lifecycle.
  it('carries lastError into buildSnapshot after an errored turn closes', async () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' });
    p.ingest({ type: 'error', message: 'boom', code: 'turn_exception' } as RawSessionEvent);
    p.ingest({ type: 'turn_end', terminalReason: 'error' });

    expect(p.getStatus().lastError).toEqual({ message: 'boom', code: 'turn_exception' });
    const snap = await p.buildSnapshot(async () => []);
    expect(snap.status.lifecycle).toBe('error');
    expect(snap.status.lastError).toEqual({ message: 'boom', code: 'turn_exception' });
  });

  // A new turn clears the previous failure surface.
  it('clears lastError on the next turn_start', () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' });
    p.ingest({ type: 'error', message: 'boom' } as RawSessionEvent);
    p.ingest({ type: 'turn_end', terminalReason: 'error' });
    expect(p.getStatus().lastError).not.toBeNull();

    p.ingest({ type: 'turn_start' });
    expect(p.getStatus().lastError).toBeNull();
  });

  // A recovered turn (error mid-turn, clean close) must not leave a stale
  // failure pinned on the status.
  it('clears lastError when a turn ends without settling to error', () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' });
    p.ingest({ type: 'error', message: 'transient' } as RawSessionEvent);
    p.ingest({ type: 'turn_end', terminalReason: 'completed' });
    const status = p.getStatus();
    expect(status.lifecycle).toBe('idle');
    expect(status.lastError).toBeNull();
  });

  // An error turn_end retains the latched details alongside the error lifecycle.
  it('retains lastError when the turn_end settles to error', () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' });
    p.ingest({ type: 'error', message: 'fatal' } as RawSessionEvent);
    p.ingest({ type: 'turn_end', terminalReason: 'error' });
    const status = p.getStatus();
    expect(status.lifecycle).toBe('error');
    expect(status.lastError).toEqual({ message: 'fatal' });
  });

  // Failure mode (SRV-C1): a cursor ahead of the counter means the seq space
  // was reset (server restart re-created the projector). Subscribing anyway
  // leaves the live filter dropping EVERY future event — a permanently deaf
  // client. subscribe() must reject EAGERLY (at call time) so the route can
  // fall back to the cold snapshot path.
  it('subscribe throws StaleResumeCursorError at call time for a cursor ahead of the counter', () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' });
    expect(() => p.subscribe(4523)).toThrowError(StaleResumeCursorError);
  });

  // Failure mode (SRV-C1): the EventLog trims past EVENT_LOG_MAX_EVENTS, so a
  // resume below the replay floor has a gap the buffers cannot serve — silently
  // skipping it would violate the gap-free guarantee.
  it('subscribe throws StaleResumeCursorError for a cursor below the trimmed replay floor', () => {
    const p = new SessionStateProjector('s1');
    for (let i = 0; i < EVENT_LOG_MAX_EVENTS + 10; i++) {
      p.ingest({ type: 'text_delta', text: 'x' } as RawSessionEvent);
    }
    // Oldest retained seq is 11; a cursor of 5 misses events 6..10 forever.
    expect(() => p.subscribe(5)).toThrowError(StaleResumeCursorError);
    // The exact floor (oldest - 1 = 10) is servable: every event > 10 is retained.
    expect(() => p.subscribe(10)).not.toThrow();
  });

  it('subscribe accepts a fully-caught-up cursor, an in-range cursor, and 0 on a fresh projector', () => {
    const fresh = new SessionStateProjector('s-fresh');
    expect(() => fresh.subscribe(0)).not.toThrow();

    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' });
    p.ingest({ type: 'text_delta', text: 'x' } as RawSessionEvent);
    expect(() => p.subscribe(2)).not.toThrow(); // caught up (== counter)
    expect(() => p.subscribe(1)).not.toThrow(); // in retained range
    expect(() => p.subscribe(0)).not.toThrow(); // full replay, nothing trimmed
  });

  // Failure mode: task #4/#5 must share one projector per session; the registry
  // must return the same instance and dispose must drop it.
  it('getOrCreateProjector returns one instance per session id', () => {
    const a = getOrCreateProjector('shared-session');
    const b = getOrCreateProjector('shared-session');
    expect(a).toBe(b);
    disposeProjector('shared-session');
    const c = getOrCreateProjector('shared-session');
    expect(c).not.toBe(a);
    disposeProjector('shared-session');
  });

  // The eviction path (I1) must finalize-and-drop only live projectors, never
  // allocate a throwaway for an id that was never streamed.
  it('peekProjector returns an existing projector without creating one', () => {
    expect(peekProjector('peek-only')).toBeUndefined();
    const created = getOrCreateProjector('peek-only');
    expect(peekProjector('peek-only')).toBe(created);
    disposeProjector('peek-only');
    expect(peekProjector('peek-only')).toBeUndefined();
  });

  // Failure mode (C1): a brand-new session's turn is fed under the request UUID,
  // but the client re-keys its /events subscription to the canonical id the 202
  // returns. Without a rekey, getOrCreateProjector(canonical) mints a FRESH EMPTY
  // projector and the already-ingested turn (held under the UUID) is invisible —
  // cursor 0, empty snapshot. rekeyProjector must move the SAME instance to the
  // canonical id, preserving its cursor/snapshot, so the in-flight feed and any
  // open subscription survive (they hold the instance, not the key).
  it('rekeyProjector moves the SAME instance to the canonical id, preserving cursor/snapshot', async () => {
    const UUID = 'request-uuid';
    const CANONICAL = 'canonical-id';
    disposeProjector(UUID);
    disposeProjector(CANONICAL);

    // Drive the real flow: create under the UUID, ingest a turn (cursor 3).
    const original = getOrCreateProjector(UUID);
    original.ingest({ type: 'turn_start' });
    original.ingest({ type: 'text_delta', text: 'hi' } as RawSessionEvent);
    original.ingest({ type: 'turn_end', terminalReason: 'completed' });
    expect(original.getCursor()).toBe(3);

    // Re-key to the canonical id (what triggerTurn does once the id is resolved).
    rekeyProjector(UUID, CANONICAL);

    // getOrCreateProjector(canonical) now resolves to the SAME instance with the
    // full cursor and a populated snapshot — not a fresh empty one.
    const afterRekey = getOrCreateProjector(CANONICAL);
    expect(afterRekey).toBe(original);
    expect(afterRekey.getCursor()).toBe(3);
    const snap = await afterRekey.buildSnapshot(async () => []);
    expect(snap.cursor).toBe(3);

    // The old UUID is freed: a lookup there is now a DIFFERENT, fresh instance
    // (cursor 0), proving the move was not a copy/alias (ADR-0267 — no dual-id).
    const fresh = getOrCreateProjector(UUID);
    expect(fresh).not.toBe(original);
    expect(fresh.getCursor()).toBe(0);

    disposeProjector(UUID);
    disposeProjector(CANONICAL);
  });

  // Failure mode (C1 guards): rekey must be a no-op when the id is unchanged or
  // when nothing is registered under oldId — so an existing session (whose id
  // never changes) and a missing source are both safe.
  it('onProjectorRekey notifies subscribers with (oldId, newId) on a real rekey', () => {
    const seen: Array<[string, string]> = [];
    const unsubscribe = onProjectorRekey((oldId, newId) => seen.push([oldId, newId]));
    getOrCreateProjector('rekey-obs-uuid');

    rekeyProjector('rekey-obs-uuid', 'rekey-obs-canonical');
    expect(seen).toEqual([['rekey-obs-uuid', 'rekey-obs-canonical']]);

    // A no-op rekey (unchanged id) fires nothing.
    rekeyProjector('rekey-obs-canonical', 'rekey-obs-canonical');
    expect(seen).toHaveLength(1);

    // After unsubscribe, no further notifications.
    unsubscribe();
    getOrCreateProjector('rekey-obs-2');
    rekeyProjector('rekey-obs-2', 'rekey-obs-2-canonical');
    expect(seen).toHaveLength(1);

    disposeProjector('rekey-obs-canonical');
    disposeProjector('rekey-obs-2-canonical');
  });

  it('rekeyProjector is a no-op for an unchanged id or a missing source', () => {
    const SAME = 'same-id';
    const a = getOrCreateProjector(SAME);
    rekeyProjector(SAME, SAME); // same id: instance untouched
    expect(getOrCreateProjector(SAME)).toBe(a);
    disposeProjector(SAME);

    // Missing source: nothing to move, and the target stays unregistered.
    rekeyProjector('never-created', 'still-unregistered');
    expect(peekProjector('still-unregistered')).toBeUndefined();
  });

  // Failure mode (C1 edge): a projector already under newId. The ACTIVE turn's
  // instance (oldId) must win — dropping it would orphan the in-flight feed —
  // and the stale target is replaced.
  it('rekeyProjector prefers the active turn instance when the target already exists', () => {
    const OLD = 'old-active';
    const NEW = 'new-stale';
    const active = getOrCreateProjector(OLD);
    active.ingest({ type: 'turn_start' }); // active turn under OLD
    const stale = getOrCreateProjector(NEW); // pre-existing (no active turn)
    expect(active).not.toBe(stale);

    rekeyProjector(OLD, NEW);

    // NEW now resolves to the ACTIVE turn's instance, not the stale one.
    expect(getOrCreateProjector(NEW)).toBe(active);
    disposeProjector(OLD);
    disposeProjector(NEW);
  });

  // Failure mode (DOR-782): the displaced instance is evicted from the registry
  // but its live `/events` subscribers are still parked inside it, awaiting an
  // ingest that can never come — the session is off the registry, so nothing
  // will ever feed it again. Those connections received only keepalives, forever.
  it('ENDS the displaced instance subscribers so their clients reconnect and re-snapshot', async () => {
    const OLD = 'displace-active';
    const NEW = 'displace-target';
    const active = getOrCreateProjector(OLD);
    active.ingest({ type: 'turn_start' });

    const stale = getOrCreateProjector(NEW);
    stale.ingest({ type: 'turn_start' });
    // A live subscriber, caught up and parked on the next ingest.
    const received: unknown[] = [];
    let ended = false;
    const consuming = (async () => {
      for await (const event of stale.subscribe(0)) received.push(event);
      ended = true;
    })();
    await Promise.resolve();
    await Promise.resolve();
    expect(stale.getWaiterCount()).toBe(1);
    expect(ended).toBe(false);

    rekeyProjector(OLD, NEW);
    await consuming;

    // The stream ENDED (the route then closes the SSE response and the client
    // reconnects), rather than hanging on a projector nothing can feed.
    expect(ended).toBe(true);
    expect(stale.getWaiterCount()).toBe(0);
    // Everything it had already been sent still arrived — termination ends the
    // stream, it does not rewrite history.
    expect(received).toHaveLength(1);

    // A subscriber that attaches to the retired instance afterwards likewise
    // ends immediately instead of parking forever.
    const late: unknown[] = [];
    for await (const event of stale.subscribe(1)) late.push(event);
    expect(late).toEqual([]);

    disposeProjector(OLD);
    disposeProjector(NEW);
  });

  it('leaves the winner untouched: a rekey with no collision ends nobody', async () => {
    const OLD = 'no-collide-uuid';
    const NEW = 'no-collide-canonical';
    const active = getOrCreateProjector(OLD);
    active.ingest({ type: 'turn_start' });

    let ended = false;
    const received: unknown[] = [];
    const consuming = (async () => {
      for await (const event of active.subscribe(0)) {
        received.push(event);
        if (received.length === 2) break;
      }
      ended = true;
    })();
    await Promise.resolve();
    await Promise.resolve();

    rekeyProjector(OLD, NEW);
    // The in-flight subscriber is still live and still receiving — the rekey
    // moves the key, never the stream.
    expect(ended).toBe(false);
    active.ingest({ type: 'turn_end' });
    await consuming;
    expect(received).toHaveLength(2);

    disposeProjector(NEW);
  });
});

describe('onProjectorStatusChange (global lifecycle fan-out)', () => {
  // The sidebar's liveness indicators are driven by session_status events on
  // /api/events; the session-list broadcaster builds those from this listener.
  // Regression context: before this fan-out existed, the sidebar could only
  // show state for sessions whose legacy chat-store entry happened to be
  // written, so "Working" never appeared (user report 2026-06-11).
  const unsubs: Array<() => void> = [];
  const listen = (fn: (u: ProjectorStatusUpdate) => void) => {
    const unsub = onProjectorStatusChange(fn);
    unsubs.push(unsub);
    return unsub;
  };

  afterEach(() => {
    while (unsubs.length) unsubs.pop()?.();
  });

  it('notifies on lifecycle transitions with id, cwd, and status — not on token-only deltas', () => {
    const p = getOrCreateProjector('status-1', '/work/alpha');
    const updates: ProjectorStatusUpdate[] = [];
    listen((u) => updates.push(u));

    p.ingest({ type: 'turn_start' });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      sessionId: 'status-1',
      cwd: '/work/alpha',
      status: { lifecycle: 'streaming' },
    });

    // Per-chunk output-token deltas must NOT fan out (they fire constantly).
    p.ingest({
      type: 'status_change',
      status: { contextUsage: { outputTokens: 42 } },
    } as RawSessionEvent);
    expect(updates).toHaveLength(1);

    p.ingest({ type: 'turn_end' });
    expect(updates).toHaveLength(2);
    expect(updates[1]?.status.lifecycle).toBe('idle');
    disposeProjector('status-1');
  });

  it('notifies on blocked (interaction) and again when the interaction resolves', () => {
    const p = getOrCreateProjector('status-2', '/work/alpha');
    const lifecycles: string[] = [];
    listen((u) => lifecycles.push(u.status.lifecycle));

    p.ingest({ type: 'turn_start' });
    p.ingest({
      type: 'approval_required',
      id: 'tool-1',
      startedAt: Date.now(),
      remainingMs: TIMEOUT_MS,
      toolName: 'Bash',
      input: '{}',
      hasSuggestions: false,
    } as RawSessionEvent);
    p.resolveInteraction('tool-1', 'approved');
    expect(lifecycles).toEqual(['streaming', 'blocked', 'streaming']);
    disposeProjector('status-2');
  });

  it('notifies when markInterrupted settles a dangling turn', () => {
    const p = getOrCreateProjector('status-3');
    const lifecycles: string[] = [];
    listen((u) => lifecycles.push(u.status.lifecycle));

    p.ingest({ type: 'turn_start' });
    p.markInterrupted();
    expect(lifecycles).toEqual(['streaming', 'interrupted']);
    disposeProjector('status-3');
  });

  it('re-announces under the canonical id after a rekey', () => {
    // First-turn split-brain: transitions before the rekey go out under the
    // request UUID, which no sidebar row matches. The rekey must re-announce
    // under the canonical id the session_upserted row is keyed by.
    const p = getOrCreateProjector('request-uuid', '/work/beta');
    const updates: ProjectorStatusUpdate[] = [];
    listen((u) => updates.push(u));

    p.ingest({ type: 'turn_start' });
    expect(updates[0]?.sessionId).toBe('request-uuid');

    rekeyProjector('request-uuid', 'canonical-id');
    expect(updates).toHaveLength(2);
    expect(updates[1]).toMatchObject({
      sessionId: 'canonical-id',
      cwd: '/work/beta',
      // The retire signal: clients drop state held under the request UUID —
      // no session_removed ever fires for it, so without this the pre-rekey
      // 'streaming' entry would pin agent-row liveness forever.
      retiredSessionId: 'request-uuid',
      status: { lifecycle: 'streaming' },
    });
    // Ordinary transitions never carry a retire signal.
    expect(updates[0]).not.toHaveProperty('retiredSessionId');
    // Subsequent transitions carry the canonical id too.
    p.ingest({ type: 'turn_end' });
    expect(updates[2]?.sessionId).toBe('canonical-id');
    disposeProjector('canonical-id');
  });

  it('stops notifying after unsubscribe', () => {
    const p = getOrCreateProjector('status-4');
    const updates: ProjectorStatusUpdate[] = [];
    const unsub = listen((u) => updates.push(u));

    p.ingest({ type: 'turn_start' });
    unsub();
    p.ingest({ type: 'turn_end' });
    expect(updates).toHaveLength(1);
    disposeProjector('status-4');
  });

  it('isolates a throwing listener: ingest completes and later listeners still fire', () => {
    const p = getOrCreateProjector('status-6');
    const seen: string[] = [];
    listen(() => {
      throw new Error('listener exploded');
    });
    listen((u) => seen.push(u.status.lifecycle));

    const event = p.ingest({ type: 'turn_start' });
    expect(event.seq).toBe(1);
    expect(p.getStatus().lifecycle).toBe('streaming');
    expect(seen).toEqual(['streaming']);
    disposeProjector('status-6');
  });

  it('stamps cwd once on getOrCreateProjector — first writer wins', () => {
    const p = getOrCreateProjector('status-5', '/work/first');
    expect(p.cwd).toBe('/work/first');
    // A later subscribe with a different (or absent) cwd must not clobber it.
    expect(getOrCreateProjector('status-5', '/work/second').cwd).toBe('/work/first');
    expect(getOrCreateProjector('status-5').cwd).toBe('/work/first');
    disposeProjector('status-5');
  });
});

describe('in-conversation MCP sign-in card (DOR-1004)', () => {
  const CARD: RawSessionEvent = {
    type: 'mcp_signin_required',
    serverName: 'granola',
    agentId: '01HV7KJZZZ0000000000000000',
    flowId: 'flow-1',
    authorizeUrl: 'https://mcp.test.local/authorize',
    disclosure: 'DorkOS stores the token on this machine.',
  };

  /** Push a turn that asks for a sign-in and then ends, as the real flow does. */
  function signinTurn(p: SessionStateProjector): void {
    p.ingest({ type: 'turn_start' });
    p.ingest(CARD);
    p.ingest({ type: 'text_delta', text: 'Connecting your meeting notes.' });
    p.ingest({ type: 'turn_end' });
  }

  it('keeps the card in a cold snapshot after the turn that asked for it ended', async () => {
    // The whole point of not holding the tool call: the turn ends immediately and
    // the person walks off to a browser. A tab opened while they are away — the
    // most likely moment for one to be opened — must still draw the card, and
    // `inProgressTurn` is null by then.
    const p = new SessionStateProjector('s1');
    signinTurn(p);

    const snap = await p.buildSnapshot(async () => []);

    expect(snap.inProgressTurn).toEqual([expect.objectContaining({ type: 'mcp_signin_required' })]);
    // …and nothing else from the finished turn came back with it.
    expect(snap.inProgressTurn).toHaveLength(1);
  });

  it('carries the card without claiming a turn is running', async () => {
    const p = new SessionStateProjector('s1');
    signinTurn(p);

    expect(p.getStatus().lifecycle).toBe('idle');
    expect(p.hasPendingInteractions()).toBe(false);
    expect(p.peekInProgressTurn()).toBeNull();
  });

  it('does not duplicate a card that is still inside the live turn', async () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' });
    p.ingest(CARD);

    const snap = await p.buildSnapshot(async () => []);

    expect(snap.inProgressTurn?.filter((e) => e.type === 'mcp_signin_required')).toHaveLength(1);
    expect(snap.inProgressTurn?.[0].type).toBe('turn_start');
  });

  it('carries the RECEIPT through the resume turn the sign-in caused', async () => {
    // The one-turn grace, and the whole reason it exists: signing in triggers a
    // turn within about a second, and retiring the card on that turn's
    // `turn_start` erased the payoff before the person had walked back from their
    // browser. A cold hydrate mid-resume-turn must still show what was connected.
    const p = new SessionStateProjector('s1');
    signinTurn(p);
    p.ingest({ type: 'mcp_signin_resolved', flowId: 'flow-1', outcome: 'connected', toolCount: 7 });
    p.ingest({ type: 'turn_start' });

    const snap = await p.buildSnapshot(async () => []);

    // The PAIR travels: the card names the server, the resolution says how it
    // ended. Either alone renders the wrong thing.
    expect(snap.inProgressTurn?.map((e) => e.type)).toEqual([
      'turn_start',
      'mcp_signin_required',
      'mcp_signin_resolved',
    ]);
    expect(snap.inProgressTurn?.find((e) => e.type === 'mcp_signin_resolved')).toMatchObject({
      outcome: 'connected',
      toolCount: 7,
    });
  });

  it('does not spend the grace on a window nobody asked for', async () => {
    // A wake-up (DOR-1100) fires milliseconds after the turn closes and nobody
    // asked for it, so it is not "the conversation moved on" — spending the
    // grace on it would erase the card just as the person got back from their
    // browser, which is the exact failure the grace exists to prevent.
    const p = new SessionStateProjector('s1');
    signinTurn(p);
    p.ingest({ type: 'turn_start', origin: 'runtime' } as RawSessionEvent);
    p.ingest({ type: 'turn_end' });
    // A SECOND runtime window still does not retire it…
    p.ingest({ type: 'turn_start', origin: 'runtime' } as RawSessionEvent);

    const snap = await p.buildSnapshot(async () => []);
    expect(snap.inProgressTurn?.some((e) => e.type === 'mcp_signin_required')).toBe(true);
  });

  it('still spends the grace on the next turn a person asks for', async () => {
    const p = new SessionStateProjector('s1');
    signinTurn(p);
    p.ingest({ type: 'turn_start', origin: 'runtime' } as RawSessionEvent);
    p.ingest({ type: 'turn_end' });
    // The person sends something: NOW the conversation has moved on.
    p.ingest({ type: 'turn_start' });
    p.ingest({ type: 'turn_end' });
    p.ingest({ type: 'turn_start' });

    const snap = await p.buildSnapshot(async () => []);
    expect(snap.inProgressTurn?.some((e) => e.type === 'mcp_signin_required')).toBe(false);
  });

  it('retires the receipt on the turn AFTER the one it rode through', async () => {
    const p = new SessionStateProjector('s1');
    signinTurn(p);
    p.ingest({ type: 'mcp_signin_resolved', flowId: 'flow-1', outcome: 'connected' });
    p.ingest({ type: 'turn_start' });
    p.ingest({ type: 'turn_end' });
    p.ingest({ type: 'turn_start' });

    const snap = await p.buildSnapshot(async () => []);
    expect(snap.inProgressTurn?.some((e) => e.type === 'mcp_signin_required')).toBe(false);
  });

  it('keeps a FAILED sign-in readable on a cold hydrate', async () => {
    // A person sent to a browser for a sign-in that did not take has to be able
    // to find that out, and the runtime's own transcript has never heard of it.
    const p = new SessionStateProjector('s1');
    signinTurn(p);
    p.ingest({ type: 'mcp_signin_resolved', flowId: 'flow-1', outcome: 'failed' });

    const snap = await p.buildSnapshot(async () => []);
    expect(snap.inProgressTurn?.map((e) => e.type)).toEqual([
      'mcp_signin_required',
      'mcp_signin_resolved',
    ]);
  });

  it('drops an UNRESOLVED card one turn after the conversation moved on', async () => {
    const p = new SessionStateProjector('s1');
    signinTurn(p);
    p.ingest({ type: 'turn_start' });
    expect((await p.buildSnapshot(async () => [])).inProgressTurn).toHaveLength(2);

    p.ingest({ type: 'turn_end' });
    p.ingest({ type: 'turn_start' });
    const snap = await p.buildSnapshot(async () => []);
    expect(snap.inProgressTurn?.some((e) => e.type === 'mcp_signin_required')).toBe(false);
  });

  it('gives the receipt its OWN turn of grace, not the card’s leftovers', async () => {
    // A person who takes their time: the card burns its turn while they are still
    // in the browser, and the resolution lands after. The client store mirrors
    // this exactly (`session-stream-store.test.ts`), which is what stops the two
    // projections disagreeing about what is on screen.
    const p = new SessionStateProjector('s1');
    signinTurn(p);
    p.ingest({ type: 'turn_start' });
    p.ingest({ type: 'turn_end' });
    p.ingest({ type: 'mcp_signin_resolved', flowId: 'flow-1', outcome: 'connected' });
    p.ingest({ type: 'turn_start' });

    const snap = await p.buildSnapshot(async () => []);
    expect(snap.inProgressTurn?.map((e) => e.type)).toEqual([
      'turn_start',
      'mcp_signin_required',
      'mcp_signin_resolved',
    ]);
  });

  it('ignores a resolution for a card it never saw', async () => {
    // A bare receipt has no server name and no disclosure — it would be a
    // surprise in the transcript, not a record.
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' });
    p.ingest({ type: 'mcp_signin_resolved', flowId: 'ghost', outcome: 'connected' });
    p.ingest({ type: 'turn_end' });

    expect((await p.buildSnapshot(async () => [])).inProgressTurn).toBeNull();
  });
});
