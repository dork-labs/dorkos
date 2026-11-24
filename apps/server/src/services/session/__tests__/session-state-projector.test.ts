import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  SessionStateProjector,
  getOrCreateProjector,
  disposeProjector,
  rekeyProjector,
  onProjectorStatusChange,
  onProjectorInteractionChange,
  listPendingInteractionsAcrossSessions,
} from '../session-state-projector.js';
import type {
  RawSessionEvent,
  ProjectorStatusUpdate,
  InteractionChange,
} from '../session-state-projector.js';
import {
  TIMEOUT_MS,
  PARK_CEILING_MS,
} from './session-state-projector/session-state-projector.fixtures.js';

describe('SessionStateProjector — how a turn settles', () => {
  afterEach(() => {
    vi.useRealTimers();
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

  // The refusal case DOR-1320's review proved and DOR-1676 recorded as a known
  // hole here: an API refusal aborts the main turn controller, so the turn ends
  // `aborted_streaming` while DorkOS never asked for a stop — and the result
  // mapper KEEPS the error frame on purpose. Settled on shape alone, the
  // operator was told they stopped a turn they never touched and the clear that
  // follows the derivation erased the explanation.
  describe('an abort NOBODY asked for', () => {
    it.each(['aborted_streaming'])(
      'settles to error and keeps lastError when %s carried no stop request',
      async (terminalReason) => {
        const p = new SessionStateProjector('s1');
        p.ingest({ type: 'turn_start' });
        p.ingest({ type: 'error', message: 'Claude refused to continue' } as RawSessionEvent);
        p.ingest({ type: 'turn_end', terminalReason, stopWasRequested: false });

        const status = p.getStatus();
        expect(status.lifecycle).toBe('error');
        expect(status.lastError).toEqual({ message: 'Claude refused to continue' });

        // The hydrated reading of the SAME turn. Live and cold must not
        // disagree about whether a person stopped this.
        const snap = await p.buildSnapshot(async () => []);
        expect(snap.status.lifecycle).toBe('error');
        expect(snap.status.lastError).toEqual({ message: 'Claude refused to continue' });
      }
    );

    it.each(['aborted_streaming'])(
      'still settles to interrupted when %s WAS requested',
      (terminalReason) => {
        // The behavior DOR-1320 shipped, unchanged: a turn a person stopped
        // settles `interrupted` even though an error frame rode along with it.
        const p = new SessionStateProjector('s1');
        p.ingest({ type: 'turn_start' });
        p.ingest({ type: 'error', message: 'aborted mid-tool' } as RawSessionEvent);
        p.ingest({ type: 'turn_end', terminalReason, stopWasRequested: true });

        const status = p.getStatus();
        expect(status.lifecycle).toBe('interrupted');
        expect(status.lastError).toBeNull();
      }
    );

    it.each(['aborted_streaming'])(
      'still settles to interrupted when %s carried NO signal at all',
      (terminalReason) => {
        // The degradation pin. Codex and OpenCode keep no stop record, and no
        // turn recorded before the field existed carries one; reading that
        // silence as "nobody asked" would report every operator Stop on those
        // runtimes as a crash.
        const p = new SessionStateProjector('s1');
        p.ingest({ type: 'turn_start' });
        p.ingest({ type: 'error', message: 'aborted mid-tool' } as RawSessionEvent);
        p.ingest({ type: 'turn_end', terminalReason });

        expect(p.getStatus().lifecycle).toBe('interrupted');
      }
    );
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

  // Failure mode (DOR-1676): the SDK names its OWN reason on a failing result,
  // and the old rule treated only the literal `'error'` as terminal — so a turn
  // that emitted a real error frame and closed as `model_error` settled `idle`
  // AND had its failure text wiped by the clear that follows the derivation. On
  // the default runtime that is the ordinary way a turn fails, so the session
  // list, the red border, the Heads-up row and the failure notice all reported a
  // clean idle session, and the notification layer sent `turn.completed`.
  it.each(['model_error', 'max_turns'])(
    'settles to error and keeps lastError when a turn with an error frame ends with %s',
    (terminalReason) => {
      const p = new SessionStateProjector('s1');
      p.ingest({ type: 'turn_start' });
      p.ingest({ type: 'error', message: 'API Error: 500' } as RawSessionEvent);
      p.ingest({ type: 'turn_end', terminalReason });
      const status = p.getStatus();
      expect(status.lifecycle).toBe('error');
      expect(status.lastError).toEqual({ message: 'API Error: 500' });
    }
  );

  // The absolving half. These three ride the SDK's SUCCESS result: the turn
  // deferred a tool or went to the background and will be BACK (the DOR-1100
  // continuation the normalizer models as a second window), so an error it
  // reported on the way is one it recovered from. Settling them error would
  // report a turn that is still working as one that broke.
  it.each(['completed', 'tool_deferred'])(
    'stays idle and clears lastError when an error frame is excused by %s',
    (terminalReason) => {
      const p = new SessionStateProjector('s1');
      p.ingest({ type: 'turn_start' });
      p.ingest({ type: 'error', message: 'transient' } as RawSessionEvent);
      p.ingest({ type: 'turn_end', terminalReason });
      const status = p.getStatus();
      expect(status.lifecycle).toBe('idle');
      expect(status.lastError).toBeNull();
    }
  );

  // A survivable error is not the turn failing. A `hook_failure` is the
  // OPERATOR'S own script exiting non-zero — the turn then ends carrying the
  // whole answer — so the frame rule must not fail it. Without the denylist this
  // reads `error`, which escalates a working turn.
  it('stays idle when the only error frame is a non-fatal hook failure', () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start' });
    p.ingest({
      type: 'error',
      message: 'Hook "notify" failed (Stop)',
      code: 'hook_failure',
    } as RawSessionEvent);
    p.ingest({ type: 'turn_end' });
    expect(p.getStatus().lifecycle).toBe('idle');
  });
});

// The ordering gate a turn about to open waits on when the turn ahead of it had
// to be abandoned (DOR-1295). Its whole job is to be a signal that means
// something and a wait that always ends.
describe('awaitTurnSettled', () => {
  it('waits for the open turn and resolves the moment it ends', async () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start', userMessage: 'hi' });

    let settled = false;
    const waiting = p.awaitTurnSettled(TIMEOUT_MS).then(() => {
      settled = true;
    });
    // Still open: a mid-turn event must not release it.
    p.ingest({ type: 'text_delta', text: 'working' });
    await Promise.resolve();
    expect(settled).toBe(false);

    p.ingest({ type: 'turn_end' });
    await waiting;
    expect(settled).toBe(true);
  });

  it('gives up on a turn nothing will ever close, rather than waiting forever', async () => {
    vi.useFakeTimers();
    try {
      const p = new SessionStateProjector('s1');
      // The stranded shape: a turn opened by a feed whose consumer is gone, so
      // no `turn_end` is ever coming.
      p.ingest({ type: 'turn_start', userMessage: 'hi' });
      const waiting = p.awaitTurnSettled(2_000);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(waiting).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases waiters when the projector is retired mid-turn', async () => {
    const p = new SessionStateProjector('s1');
    p.ingest({ type: 'turn_start', userMessage: 'hi' });
    const waiting = p.awaitTurnSettled(TIMEOUT_MS);
    // Nothing will ever be fed to this instance again, so holding to the bound
    // would make every later turn pay a wait that cannot end well.
    p.terminate();
    await expect(waiting).resolves.toBeUndefined();
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
});

describe('onProjectorInteractionChange (the Ask, fleet-wide)', () => {
  // The seam the whole feature rides on: a prompt raised in ANY session reaches
  // the cockpit through this, and the projector still imports no fan-out. It is
  // exercised directly rather than through a runtime, because it is
  // runtime-agnostic and that is the point.
  const unsubs: Array<() => void> = [];
  const listen = (fn: (change: InteractionChange) => void) => {
    unsubs.push(onProjectorInteractionChange(fn));
  };

  // A frozen clock, like the blocks above: `remainingMs` on the announced DTO is
  // the budget minus the time since `startedAt`, so on real timers any
  // millisecond a busy runner spends between raising the prompt and reading
  // the change turns `TIMEOUT_MS` into `TIMEOUT_MS - 1` and reddens the exact
  // match below (seen on CI for #1116, green alone every time).
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000_000);
  });

  afterEach(() => {
    while (unsubs.length) unsubs.pop()?.();
    vi.useRealTimers();
  });

  /** One permission prompt, as a runtime emits it. */
  function approvalRequired(id: string, startedAt = Date.now()): RawSessionEvent {
    return {
      type: 'approval_required',
      id,
      startedAt,
      remainingMs: TIMEOUT_MS,
      timeoutMs: TIMEOUT_MS,
      toolName: 'Bash',
      input: JSON.stringify({ command: 'pnpm verify' }),
      hasSuggestions: false,
    } as unknown as RawSessionEvent;
  }

  it('announces one pending prompt, with the DTO the card is drawn from', () => {
    // Frozen clock: the DTO's `remainingMs` is recomputed at announce time, so
    // on a loaded machine a real clock ticks between raising the prompt and
    // reading it and the exact number below drifts by a millisecond.
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const projector = getOrCreateProjector('ask-1', '/work/alpha');
    const changes: InteractionChange[] = [];
    listen((change) => changes.push(change));

    projector.ingest(approvalRequired('tc-1'));

    // Filtered to THIS session: the projector registry is a module singleton,
    // so a neighbouring file's parked session is announced to every listener
    // registered while it runs — including this one.
    const mine = changes.filter(
      (change) => change.type === 'pending' && change.sessionId === 'ask-1'
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      type: 'pending',
      sessionId: 'ask-1',
      cwd: '/work/alpha',
      interaction: { type: 'approval', id: 'tc-1', toolName: 'Bash', remainingMs: TIMEOUT_MS },
    });
    disposeProjector('ask-1');
  });

  it('says a prompt was ANSWERED when a person answered it', () => {
    const projector = getOrCreateProjector('ask-2', '/work/alpha');
    projector.ingest(approvalRequired('tc-2'));
    const changes: InteractionChange[] = [];
    listen((change) => changes.push(change));

    projector.resolveInteraction('tc-2', 'approved');

    expect(changes).toEqual([
      { type: 'resolved', sessionId: 'ask-2', interactionId: 'tc-2', outcome: 'answered' },
    ]);
    disposeProjector('ask-2');
  });

  it('says EXPIRED when the clock answered, and CANCELLED when nobody was ever asked', () => {
    const projector = getOrCreateProjector('ask-3', '/work/alpha');
    projector.ingest(approvalRequired('tc-expired'));
    projector.ingest(approvalRequired('tc-cancelled'));
    const changes: InteractionChange[] = [];
    listen((change) => changes.push(change));

    projector.ingest({
      type: 'interaction_resolved',
      id: 'tc-expired',
      resolution: 'expired',
    } as unknown as RawSessionEvent);
    projector.ingest({
      type: 'interaction_resolved',
      id: 'tc-cancelled',
      resolution: 'cancelled',
    } as unknown as RawSessionEvent);

    expect(changes.map((change) => change.type === 'resolved' && change.outcome)).toEqual([
      'expired',
      'cancelled',
    ]);
    disposeProjector('ask-3');
  });

  it('cancels what a torn-down turn was parked on, because nothing will answer it', () => {
    const projector = getOrCreateProjector('ask-5', '/work/alpha');
    projector.ingest({ type: 'turn_start' });
    projector.ingest(approvalRequired('tc-5'));
    const changes: InteractionChange[] = [];
    listen((change) => changes.push(change));

    projector.markInterrupted();

    expect(changes).toEqual([
      { type: 'resolved', sessionId: 'ask-5', interactionId: 'tc-5', outcome: 'cancelled' },
    ]);
    disposeProjector('ask-5');
  });
});

describe('listPendingInteractionsAcrossSessions', () => {
  it('spans every live projector, carries a parked one, and drops what is past the ceiling', () => {
    const now = Date.now();
    const live = getOrCreateProjector('fleet-live', '/work/alpha');
    const parked = getOrCreateProjector('fleet-parked', '/work/gamma');
    const stale = getOrCreateProjector('fleet-stale', '/work/beta');
    const nameless = getOrCreateProjector('fleet-nameless');
    const raise = (projector: SessionStateProjector, id: string, startedAt: number) =>
      projector.ingest({
        type: 'approval_required',
        id,
        startedAt,
        remainingMs: TIMEOUT_MS,
        timeoutMs: TIMEOUT_MS,
        toolName: 'Bash',
        input: '{}',
        hasSuggestions: false,
      } as unknown as RawSessionEvent);

    raise(live, 'tc-live', now - 60_000);
    // Older than its own budget: the selector PARKS it, and so must this.
    raise(parked, 'tc-parked', now - TIMEOUT_MS - 60_000);
    // Older than the park ceiling: the selector drops it, and so must this.
    raise(stale, 'tc-stale', now - PARK_CEILING_MS - 1_000);
    raise(nameless, 'tc-nameless', now);

    // Scoped to the three sessions this case created. The registry is a module
    // singleton shared with every other file in this worker, so asserting over
    // the whole fleet would pass or fail on what a neighbour left behind.
    const listed = listPendingInteractionsAcrossSessions(now).filter((row) =>
      row.sessionId.startsWith('fleet-')
    );

    expect(listed.map((row) => row.interaction.id).sort()).toEqual(['tc-live', 'tc-parked']);
    const liveRow = listed.find((row) => row.interaction.id === 'tc-live');
    expect(liveRow).toMatchObject({ sessionId: 'fleet-live', cwd: '/work/alpha' });
    // And the remaining time is recomputed at read, not frozen at emit.
    expect(liveRow!.interaction.remainingMs).toBe(TIMEOUT_MS - 60_000);
    const parkedRow = listed.find((row) => row.interaction.id === 'tc-parked');
    expect(parkedRow!.interaction.parked).toBe(true);
    expect(parkedRow!.interaction.remainingMs).toBe(PARK_CEILING_MS - TIMEOUT_MS - 60_000);

    disposeProjector('fleet-live');
    disposeProjector('fleet-parked');
    disposeProjector('fleet-stale');
    disposeProjector('fleet-nameless');
  });
});
