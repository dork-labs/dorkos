// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import type { SessionEvent } from '@dorkos/shared/session-stream';

import { useSessionStreamStore } from '../session-stream-store';
import { useSessionListStore } from '../session-list-store';
import { SID, STATUS, MESSAGE, snapshot } from './session-stream-store.fixtures';

describe('useSessionListStore', () => {
  const SESSION = {
    id: SID,
    title: 'Test',
    createdAt: '2026-06-10T00:00:00.000Z',
    updatedAt: '2026-06-10T00:00:00.000Z',
    permissionMode: 'default' as const,
    runtime: 'claude-code',
  };

  beforeEach(() => {
    useSessionListStore.setState({
      sessions: {},
      statuses: {},
      statusCwds: {},
      unseen: {},
      rekeys: {},
    });
  });

  it('applyListEvent prunes the entry when the lifecycle settles (idle/interrupted)', () => {
    // Discovery only removes DEFAULT_CWD sessions, so settled statuses must
    // prune here or a long-lived client accumulates an entry per session that
    // ever transitioned (scanned per agent row).
    const store = useSessionListStore.getState();
    store.applyListEvent({
      type: 'session_status',
      sessionId: SID,
      cwd: '/work/a',
      status: { ...STATUS, lifecycle: 'streaming' },
    });
    store.applyListEvent({ type: 'session_status', sessionId: SID, status: STATUS }); // idle
    expect(useSessionListStore.getState().statuses[SID]).toBeUndefined();
    expect(useSessionListStore.getState().statusCwds[SID]).toBeUndefined();
  });

  it('applyListEvent retires the pre-rekey request UUID named by retiredSessionId', () => {
    // First-turn F2 race: transitions broadcast under the request UUID before
    // the canonical id resolves; no session_removed ever fires for it. The
    // rekey re-announce must drop it or its 'streaming' pins agent-row
    // liveness forever.
    const store = useSessionListStore.getState();
    store.applyListEvent({
      type: 'session_status',
      sessionId: 'request-uuid',
      cwd: '/work/a',
      status: { ...STATUS, lifecycle: 'streaming' },
    });
    store.markUnseen('request-uuid', '/work/a');
    store.applyListEvent({
      type: 'session_status',
      sessionId: SID,
      cwd: '/work/a',
      retiredSessionId: 'request-uuid',
      status: { ...STATUS, lifecycle: 'streaming' },
    });
    expect(useSessionListStore.getState().statuses['request-uuid']).toBeUndefined();
    expect(useSessionListStore.getState().statusCwds['request-uuid']).toBeUndefined();
    // A retired UUID can never become active, so a lingering unseen flag would
    // never clear — the retire must drop it too.
    expect(useSessionListStore.getState().unseen['request-uuid']).toBeUndefined();
    expect(useSessionListStore.getState().statuses[SID]).toBeDefined();
    // The retirement is recorded so late-bound consumers (the URL rekey, the
    // query-cache reconciler) can follow it after the fact (NF-2/NF-3).
    expect(useSessionListStore.getState().rekeys['request-uuid']).toBe(SID);
  });

  it('the retire announce also drops a metadata row held under the retired id (NF-3)', () => {
    const store = useSessionListStore.getState();
    store.applyListEvent({
      type: 'session_upserted',
      session: { ...SESSION, id: 'request-uuid', title: 'Session request-' },
    });
    store.applyListEvent({
      type: 'session_status',
      sessionId: SID,
      retiredSessionId: 'request-uuid',
      status: { ...STATUS, lifecycle: 'streaming' },
    });
    expect(useSessionListStore.getState().sessions['request-uuid']).toBeUndefined();
  });

  it('applyListEvent removes a session and its status', () => {
    const store = useSessionListStore.getState();
    store.applyListEvent({ type: 'session_upserted', session: SESSION });
    store.applyListEvent({ type: 'session_status', sessionId: SID, status: STATUS });
    store.applyListEvent({ type: 'session_removed', sessionId: SID });
    expect(useSessionListStore.getState().sessions[SID]).toBeUndefined();
    expect(useSessionListStore.getState().statuses[SID]).toBeUndefined();
  });

  it('session_removed also drops the unseen flag', () => {
    const store = useSessionListStore.getState();
    store.markUnseen(SID);
    store.applyListEvent({ type: 'session_removed', sessionId: SID });
    expect(useSessionListStore.getState().unseen[SID]).toBeUndefined();
  });
});

// DOR-1100: a background task outlives the turn that started it, so the count
// this store reports has to outlive that turn's events. The turn-end reconcile
// wipes `inProgressTurn` seconds after the turn closes, which is exactly when
// the session looks finished and is not.
describe('useSessionStreamStore — live background children', () => {
  const store = useSessionStreamStore;

  /** A `subagent_update` on the durable stream. */
  function child(seq: number, taskId: string, status: string): SessionEvent {
    return { type: 'subagent_update', seq, taskId, status } as SessionEvent;
  }

  /** The same, marked as housekeeping the runtime asked indicators to ignore. */
  function ambientChild(seq: number, taskId: string, status: string): SessionEvent {
    return { type: 'subagent_update', seq, taskId, status, ambient: true } as SessionEvent;
  }

  beforeEach(() => {
    store.setState({ sessions: {}, sessionAccessOrder: [], pinnedSessionId: null });
  });

  it('keeps the count after the turn that started the children is reloaded away', () => {
    store.getState().applySnapshot(SID, snapshot({ cursor: 0 }));
    store.getState().applyEvent(SID, { type: 'turn_start', seq: 1 });
    store.getState().applyEvent(SID, child(2, 'bt1', 'running'));
    store.getState().applyEvent(SID, child(3, 'bt2', 'running'));
    store.getState().applyEvent(SID, { type: 'turn_end', seq: 4 });
    expect(store.getState().sessions[SID]?.status?.runningSubagentCount).toBe(2);

    // What the turn-end reconcile does: canonical history replaces the turn.
    store.getState().setHistoryMessages(SID, [MESSAGE]);

    expect(store.getState().sessions[SID]?.inProgressTurn).toEqual([]);
    expect(store.getState().sessions[SID]?.status?.runningSubagentCount).toBe(2);
    expect(store.getState().sessions[SID]?.status?.lifecycle).toBe('idle');
  });

  // Spec `ambient-background-tasks`: the runtime marks work it started on its
  // own behalf, and every indicator — this count included — leaves it out.
  it('never counts a housekeeping child', () => {
    store.getState().applySnapshot(SID, snapshot({ cursor: 0 }));
    store.getState().applyEvent(SID, child(1, 'real', 'running'));
    store.getState().applyEvent(SID, ambientChild(2, 'chore', 'running'));
    expect(store.getState().sessions[SID]?.status?.runningSubagentCount).toBe(1);

    // The terminal update carries the mark too, so the ending of a child that
    // never entered the count cannot be booked against a child that did.
    store.getState().applyEvent(SID, ambientChild(3, 'chore', 'complete'));
    expect(store.getState().sessions[SID]?.status?.runningSubagentCount).toBe(1);

    store.getState().applyEvent(SID, child(4, 'real', 'complete'));
    expect(store.getState().sessions[SID]?.status?.runningSubagentCount).toBe(0);
  });

  it('does not double-count a child that keeps reporting progress', () => {
    store.getState().applySnapshot(SID, snapshot({ cursor: 0 }));
    store.getState().applyEvent(SID, child(1, 'bt1', 'running'));
    store.getState().applyEvent(SID, child(2, 'bt1', 'running'));
    store.getState().applyEvent(SID, child(3, 'bt1', 'running'));
    expect(store.getState().sessions[SID]?.status?.runningSubagentCount).toBe(1);
  });

  it('drops a child from the count when it finishes', () => {
    store.getState().applySnapshot(SID, snapshot({ cursor: 0 }));
    store.getState().applyEvent(SID, child(1, 'bt1', 'running'));
    store.getState().applyEvent(SID, child(2, 'bt2', 'running'));
    store.getState().applyEvent(SID, child(3, 'bt1', 'complete'));
    expect(store.getState().sessions[SID]?.status?.runningSubagentCount).toBe(1);
    store.getState().applyEvent(SID, child(4, 'bt2', 'error'));
    expect(store.getState().sessions[SID]?.status?.runningSubagentCount).toBe(0);
  });
});

// A turn window the RUNTIME opened (DOR-1100) — the agent waking itself up when
// a background task finished — is not the same thing as the person sending the
// next message, and the projection must not treat it as one.
describe('useSessionStreamStore — runtime-opened turn windows', () => {
  const store = useSessionStreamStore;

  beforeEach(() => {
    store.setState({ sessions: {}, sessionAccessOrder: [], pinnedSessionId: null });
  });

  // The failure this replaces: the CLI drains its queued notification within
  // milliseconds, so the reopen routinely beats the turn-end history reload.
  // Resetting the turn there blanked the reply the agent had just written.
  it('keeps the finished window’s events on screen when the agent wakes itself', () => {
    store.getState().applySnapshot(SID, snapshot({ cursor: 0 }));
    store.getState().applyEvent(SID, { type: 'turn_start', seq: 1 });
    store.getState().applyEvent(SID, { type: 'text_delta', seq: 2, text: 'here is the answer' });
    store.getState().applyEvent(SID, { type: 'turn_end', seq: 3 });
    store.getState().applyEvent(SID, { type: 'turn_start', seq: 4, origin: 'runtime' });
    store.getState().applyEvent(SID, { type: 'text_delta', seq: 5, text: 'and one more thing' });

    // `turn_end` itself is never pushed onto the turn (server parity), so the
    // preserved shape is the finished window's CONTENT followed by the new
    // window's — which is exactly what stays on screen.
    expect(store.getState().sessions[SID]?.inProgressTurn.map((e) => e.type)).toEqual([
      'turn_start',
      'text_delta',
      'turn_start',
      'text_delta',
    ]);
    expect(
      store.getState().sessions[SID]?.inProgressTurn.find((e) => e.type === 'text_delta')
    ).toMatchObject({ text: 'here is the answer' });
    expect(store.getState().sessions[SID]?.status?.lifecycle).toBe('streaming');
  });

  // A turn the PERSON sends still resets: by then the settled turn has long
  // since been reloaded into canonical history, so keeping it would double it.
  it('still resets the turn when a person sends the next message', () => {
    store.getState().applySnapshot(SID, snapshot({ cursor: 0 }));
    store.getState().applyEvent(SID, { type: 'turn_start', seq: 1 });
    store.getState().applyEvent(SID, { type: 'text_delta', seq: 2, text: 'first' });
    store.getState().applyEvent(SID, { type: 'turn_end', seq: 3 });
    store.getState().applyEvent(SID, { type: 'turn_start', seq: 4, userMessage: 'again please' });

    expect(store.getState().sessions[SID]?.inProgressTurn.map((e) => e.type)).toEqual([
      'turn_start',
    ]);
  });

  // A chain of wake-ups appends without bound if no reload lands to trim it, and
  // a long-lived tab must not grow forever. The trim takes whole finished
  // windows: half a window renders as a reply starting mid-sentence.
  it('bounds a long wake-up chain by dropping whole finished windows', () => {
    store.getState().applySnapshot(SID, snapshot({ cursor: 0 }));
    let seq = 0;
    const next = () => ++seq;
    store.getState().applyEvent(SID, { type: 'turn_start', seq: next() });
    // Ten wake-up windows of 40 deltas each — well past the 200 bound.
    for (let window = 0; window < 10; window++) {
      store.getState().applyEvent(SID, { type: 'turn_end', seq: next() });
      store.getState().applyEvent(SID, { type: 'turn_start', seq: next(), origin: 'runtime' });
      for (let i = 0; i < 40; i++) {
        store.getState().applyEvent(SID, { type: 'text_delta', seq: next(), text: `w${window}` });
      }
    }

    const turn = store.getState().sessions[SID]!.inProgressTurn;
    expect(turn.length).toBeLessThanOrEqual(200);
    // Whatever survived still begins at a window boundary, never mid-reply.
    expect(turn[0]?.type).toBe('turn_start');
    // …and the newest window is intact, which is the one on screen.
    expect(turn.filter((e) => e.type === 'text_delta').at(-1)).toMatchObject({ text: 'w9' });
  });

  // The bound's blind spot (DOR-1107): a retained sign-in card sits AHEAD of the
  // first window, so a scan that assumed the turn began at a window boundary cut
  // nothing off, and the cap stopped applying for the rest of the session.
  it('bounds a long wake-up chain that begins with a retained sign-in card', () => {
    store.getState().applySnapshot(SID, snapshot({ cursor: 0 }));
    let seq = 0;
    const next = () => ++seq;

    // A turn asks for a sign-in, ends, and its history reload lands — which
    // clears the turn down to the one thing the transcript never carries: the
    // unresolved card. That card is now the turn's first event.
    store.getState().applyEvent(SID, { type: 'turn_start', seq: next() });
    store.getState().applyEvent(SID, {
      type: 'mcp_signin_required',
      seq: next(),
      serverName: 'granola',
      agentId: '01HV7KJZZZ0000000000000000',
      flowId: 'flow-1',
      authorizeUrl: 'https://mcp.test.local/authorize',
      disclosure: 'DorkOS stores the token on this machine.',
    });
    store.getState().applyEvent(SID, { type: 'turn_end', seq: next() });
    store.getState().setHistoryMessages(SID, [MESSAGE]);
    expect(store.getState().sessions[SID]?.inProgressTurn.map((e) => e.type)).toEqual([
      'mcp_signin_required',
    ]);

    // The person is off in their browser, so nothing ages the card and no reload
    // trims the turn. A hundred wake-up windows append behind it.
    for (let window = 0; window < 100; window++) {
      store.getState().applyEvent(SID, { type: 'turn_start', seq: next(), origin: 'runtime' });
      for (let i = 0; i < 5; i++) {
        store.getState().applyEvent(SID, { type: 'text_delta', seq: next(), text: `w${window}` });
      }
      store.getState().applyEvent(SID, { type: 'turn_end', seq: next() });
    }

    const turn = store.getState().sessions[SID]!.inProgressTurn;
    expect(turn.length).toBeLessThanOrEqual(200);
    // The card is still there — bounding the turn must not cost the person the
    // link they walked away to use (DOR-1004).
    expect(turn[0]?.type).toBe('mcp_signin_required');
    // …and what survives behind it still starts at a window boundary.
    expect(turn[1]?.type).toBe('turn_start');
    expect(turn.filter((e) => e.type === 'text_delta').at(-1)).toMatchObject({ text: 'w99' });
  });
});

describe('the live-usage stamp (spec claude-account-ui §6.8)', () => {
  const usageFrame = (seq: number, utilization: number): SessionEvent => ({
    type: 'status_change',
    seq,
    status: { usage: { kind: 'subscription', utilization } },
  });
  const stamp = () => useSessionStreamStore.getState().sessions[SID]!.usageArrivedAt;

  beforeEach(() => {
    useSessionStreamStore.getState().removeSession(SID);
  });

  it('stamps a live usage frame, and never a snapshot', () => {
    const store = useSessionStreamStore.getState();
    store.applySnapshot(SID, snapshot());
    expect(stamp()).toBeNull();
    store.applyEvent(SID, usageFrame(6, 0.4));
    expect(stamp()).not.toBeNull();
  });

  it("stamps again once the turn carrying this window's own message starts", () => {
    const store = useSessionStreamStore.getState();
    store.applySnapshot(SID, snapshot());
    store.setConnectionState(SID, 'reconnecting');
    store.setConnectionState(SID, 'connected');
    store.setOptimisticUserMessage(SID, { id: 'opt-1', content: 'next please' });
    store.setTriggerPending(SID, true);
    store.applyEvent(SID, { type: 'turn_start', seq: 6, userMessage: 'next please' });
    store.applyEvent(SID, usageFrame(7, 0.5));
    expect(stamp()).not.toBeNull();
  });
});
