// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { setup, transportOwner } from './stream-manager.fixtures';

describe('StreamManager — pinned (PIP) session slot (gen-ui-pip)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('does NOT open a second connection when pinning the already-attached session (shared, invariant)', () => {
    // Invariant: pinned === attached share the single active connection, so the
    // pin records state without a new SSE (pinnedConnection stays null).
    const { manager, connections } = setup();
    manager.attachSession('A');
    manager.pinSession('A');
    expect(connections).toHaveLength(1);
    expect(manager.getPinnedSessionId()).toBe('A');
    expect(manager.getAttachedSessionId()).toBe('A');
  });

  it('opens a dedicated pinned connection for an off-route session and folds its events into the store', () => {
    // The pinned background session still feeds the store fold (so the widget
    // follows live), but ui_command dispatch stays gated to the attached one.
    const onSessionEvent = vi.fn();
    const onUiCommand = vi.fn();
    const { manager, connections } = setup();
    manager.setListeners({ onSessionEvent });
    manager.subscribeUiCommand(onUiCommand);
    manager.attachSession('A');
    manager.pinSession('B'); // connections[1] is the pinned B stream
    expect(connections[1]!.url).toBe('/api/sessions/B/events');
    connections[1]!.push('turn_start', { type: 'turn_start', seq: 1 });
    expect(onSessionEvent).toHaveBeenCalledWith('B', { type: 'turn_start', seq: 1 });
    // A ui_command on the background pinned session must NOT pop UI over 'A'.
    connections[1]!.push('ui_command', {
      type: 'ui_command',
      seq: 2,
      command: { action: 'close_canvas' },
    } as SessionEvent);
    expect(onUiCommand).not.toHaveBeenCalled();
  });

  // --- Transition table (one dedicated test per row) ---

  it('row 1: pinned A + attached A (shared), attachSession(B) transfers the active connection into the pinned slot (no close/reopen) and opens a fresh B', () => {
    const onSessionEvent = vi.fn();
    const onUiCommand = vi.fn();
    const { manager, connections } = setup();
    manager.setListeners({ onSessionEvent });
    manager.subscribeUiCommand(onUiCommand);
    manager.attachSession('A'); // connections[0] shared active+pin
    manager.pinSession('A');

    manager.attachSession('B'); // connections[1] fresh active B

    expect(manager.getAttachedSessionId()).toBe('B');
    expect(manager.getPinnedSessionId()).toBe('A');
    // The A connection was TRANSFERRED, never destroyed (identity preserved).
    expect(connections[0]!.destroy).not.toHaveBeenCalled();
    expect(connections).toHaveLength(2);
    expect(connections[1]!.url).toBe('/api/sessions/B/events');
    expect(connections[1]!.connect).toHaveBeenCalledTimes(1);
    // connections[0] now serves the (background) pinned A: events fold, but a
    // ui_command must not dispatch since A is no longer the attached session.
    connections[0]!.push('turn_start', { type: 'turn_start', seq: 1 });
    expect(onSessionEvent).toHaveBeenCalledWith('A', { type: 'turn_start', seq: 1 });
    connections[0]!.push('ui_command', {
      type: 'ui_command',
      seq: 2,
      command: { action: 'close_canvas' },
    } as SessionEvent);
    expect(onUiCommand).not.toHaveBeenCalled();
  });

  it('row 2: pinned A + attached B, attachSession(A) adopts the pinned connection into the active slot (no duplicate; pinnedConnection cleared)', () => {
    const onUiCommand = vi.fn();
    const { manager, connections } = setup();
    manager.subscribeUiCommand(onUiCommand);
    manager.attachSession('B'); // connections[0] active B
    manager.pinSession('A'); // connections[1] pinned A (own conn)

    manager.attachSession('A'); // adopt connections[1]

    expect(manager.getAttachedSessionId()).toBe('A');
    expect(manager.getPinnedSessionId()).toBe('A'); // shared again
    expect(connections).toHaveLength(2); // NO duplicate opened
    expect(connections[0]!.destroy).toHaveBeenCalledTimes(1); // old active B torn down
    expect(connections[1]!.destroy).not.toHaveBeenCalled(); // adopted, identity preserved
    expect(connections[1]!.connect).toHaveBeenCalledTimes(1); // only its original connect
    // connections[1] is now the ACTIVE connection for A: a ui_command dispatches.
    connections[1]!.push('ui_command', {
      type: 'ui_command',
      seq: 2,
      command: { action: 'close_canvas' },
    } as SessionEvent);
    expect(onUiCommand).toHaveBeenCalledWith({ action: 'close_canvas' }, 'A');
  });

  it('row 2 with a DIVERGENT cwd: attachSession(A, newCwd) re-opens instead of adopting the stale-URL pinned connection', () => {
    // Real failure mode: the pinned connection's URL is bound to the OLD cwd, so adopting it on a
    // cwd change would silently serve the wrong project's history — contradicting attachSession's
    // changed-cwd re-open contract.
    const { manager, connections } = setup();
    manager.attachSession('B'); // connections[0] active B
    manager.pinSession('A', '/old'); // connections[1] pinned A, URL bound to /old

    manager.attachSession('A', '/new'); // divergent cwd → no adopt

    expect(manager.getAttachedSessionId()).toBe('A');
    expect(manager.getPinnedSessionId()).toBe('A'); // pin state survives, now shared
    expect(connections[0]!.destroy).toHaveBeenCalledTimes(1); // outgoing active B torn down
    expect(connections[1]!.destroy).toHaveBeenCalledTimes(1); // stale-cwd pinned conn torn down
    expect(connections).toHaveLength(3); // fresh connection against the NEW cwd
    expect(connections[2]!.url).toBe('/api/sessions/A/events?cwd=%2Fnew');
    expect(connections[2]!.connect).toHaveBeenCalledTimes(1);
    // One-owner invariant: the pin shares the fresh active connection, so a later
    // unpin must NOT close the active stream.
    manager.unpinSession();
    expect(connections[2]!.destroy).not.toHaveBeenCalled();
    expect(manager.getAttachedSessionId()).toBe('A');
  });

  it('row 6: a transport rebuild (source switch) with attached A + differently-pinned B restores BOTH slots against the new source', () => {
    const { manager, connections } = setup();
    manager.attachSession('A', '/pa'); // connections[0] active A
    manager.pinSession('B', '/pb'); // connections[1] pinned B

    manager.useHttpSource('http://localhost:9999/api', transportOwner);

    // Both old connections torn down, both slots rebuilt against the new origin.
    expect(connections[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(connections[1]!.destroy).toHaveBeenCalledTimes(1);
    expect(manager.getAttachedSessionId()).toBe('A');
    expect(manager.getPinnedSessionId()).toBe('B'); // pin STATE survived
    const rebuilt = connections.slice(2).map((c) => c.url);
    expect(rebuilt).toContain('http://localhost:9999/api/sessions/A/events?cwd=%2Fpa');
    expect(rebuilt).toContain('http://localhost:9999/api/sessions/B/events?cwd=%2Fpb');
    for (const conn of connections.slice(2)) {
      expect(conn.connect).toHaveBeenCalledTimes(1);
    }
  });

  it('row 4a: unpinSession with an OWN pinned connection closes only the pinned connection', () => {
    const { manager, connections } = setup();
    manager.attachSession('B'); // connections[0] active B
    manager.pinSession('A'); // connections[1] pinned A

    manager.unpinSession();

    expect(manager.getPinnedSessionId()).toBeNull();
    expect(manager.getAttachedSessionId()).toBe('B'); // active untouched
    expect(connections[1]!.destroy).toHaveBeenCalledTimes(1);
    expect(connections[0]!.destroy).not.toHaveBeenCalled();
  });

  it('row 4b: unpinSession on a SHARED pin leaves the active connection connected and attached unchanged', () => {
    const { manager, connections } = setup();
    manager.attachSession('A'); // connections[0] shared active+pin
    manager.pinSession('A');

    manager.unpinSession();

    expect(manager.getPinnedSessionId()).toBeNull();
    expect(manager.getAttachedSessionId()).toBe('A');
    expect(connections).toHaveLength(1);
    expect(connections[0]!.destroy).not.toHaveBeenCalled();
  });

  it('row 5: pinned A + attached B, pinSession(C) unpins A (closing its connection) then pins C', () => {
    const { manager, connections } = setup();
    manager.attachSession('B'); // connections[0] active B
    manager.pinSession('A'); // connections[1] pinned A

    manager.pinSession('C'); // unpin A, pin C → connections[2]

    expect(manager.getAttachedSessionId()).toBe('B');
    expect(manager.getPinnedSessionId()).toBe('C');
    expect(connections).toHaveLength(3);
    expect(connections[1]!.destroy).toHaveBeenCalledTimes(1); // A's pinned conn closed
    expect(connections[2]!.url).toBe('/api/sessions/C/events');
    expect(connections[2]!.connect).toHaveBeenCalledTimes(1);
    expect(connections[0]!.destroy).not.toHaveBeenCalled(); // active B untouched
  });
});
