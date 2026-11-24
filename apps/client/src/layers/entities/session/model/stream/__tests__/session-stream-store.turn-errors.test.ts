// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import type { SessionEvent, SessionStatus } from '@dorkos/shared/session-stream';

import { useSessionStreamStore } from '../session-stream-store';
import { SID, STATUS, snapshot } from './session-stream-store.fixtures';

describe('useSessionStreamStore typed turn errors (status.lastError mirror)', () => {
  beforeEach(() => {
    useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [], pinnedSessionId: null });
  });

  const errorEvent: SessionEvent = {
    type: 'error',
    seq: 2,
    message: 'Model overloaded',
    code: 'overloaded_error',
    category: 'execution_error',
    details: 'HTTP 529',
  };

  it('an unreadable-prompt stand-in rides the turn but never becomes lastError (DOR-2078)', () => {
    // Real failure mode: the stand-in mirrored into lastError, so a live window
    // showed it as the turn's failure while a reloaded one (whose snapshot the
    // server built without it) did not.
    const store = useSessionStreamStore.getState();
    store.applySnapshot(SID, snapshot({ cursor: 0 }));
    store.applyEvent(SID, { type: 'turn_start', seq: 1 });
    store.applyEvent(SID, {
      type: 'error',
      seq: 2,
      message: 'The agent asked you something here, but it couldn’t be shown.',
      code: 'unreadable_entry',
    });
    const s = useSessionStreamStore.getState().getSession(SID);
    expect(s.inProgressTurn.some((e) => e.type === 'error')).toBe(true);
    expect(s.status?.lastError ?? null).toBeNull();
  });

  it('an error event rides the turn AND mirrors into status.lastError', () => {
    // Real failure mode: without the mirror, a reconnecting client (whose
    // snapshot carries only status) has no failure details to render — and
    // without the turn push, the live inline error part never folds.
    const store = useSessionStreamStore.getState();
    store.applySnapshot(SID, snapshot({ cursor: 0 }));
    store.applyEvent(SID, { type: 'turn_start', seq: 1 });
    store.applyEvent(SID, errorEvent);
    const s = useSessionStreamStore.getState().getSession(SID);
    expect(s.inProgressTurn.some((e) => e.type === 'error')).toBe(true);
    expect(s.status?.lastError).toEqual({
      message: 'Model overloaded',
      code: 'overloaded_error',
      category: 'execution_error',
      details: 'HTTP 529',
    });
    // Non-terminal: the error event itself must NOT settle the lifecycle.
    expect(s.status?.lifecycle).toBe('streaming');
  });

  it('holds a usage limit from a status_change and clears it at turn_start (projector parity)', () => {
    const limit = {
      accountId: 'work',
      window: 'seven_day',
      resetsAt: null,
      since: '2026-09-26T10:00:00.000Z',
      plan: { mode: 'ask' as const },
      scope: 'account' as const,
      state: 'limited' as const,
    };
    const store = useSessionStreamStore.getState();
    store.applySnapshot(SID, snapshot({ cursor: 0 }));
    store.applyEvent(SID, { type: 'turn_start', seq: 1 });
    store.applyEvent(SID, { type: 'status_change', seq: 2, status: { limit } });
    store.applyEvent(SID, { type: 'turn_end', seq: 3, terminalReason: 'error' });
    expect(useSessionStreamStore.getState().getSession(SID).status?.limit).toEqual(limit);
    store.applyEvent(SID, { type: 'turn_start', seq: 4 });
    expect(useSessionStreamStore.getState().getSession(SID).status?.limit).toBeNull();
  });

  it('turn_start clears the previous lastError (server-projector parity)', () => {
    const store = useSessionStreamStore.getState();
    store.applySnapshot(SID, snapshot({ cursor: 0 }));
    store.applyEvent(SID, { type: 'turn_start', seq: 1 });
    store.applyEvent(SID, errorEvent);
    store.applyEvent(SID, { type: 'turn_end', seq: 3, terminalReason: 'error' });
    store.applyEvent(SID, { type: 'turn_start', seq: 4 });
    expect(useSessionStreamStore.getState().getSession(SID).status?.lastError).toBeNull();
  });

  // DOR-1676. The gap this closes, on the client half of the mirror: the SDK
  // names its own reason on a failing result, so a turn that emitted a real
  // error frame closed as `turn_end{terminalReason:'model_error'}` — which the
  // old rule recognised as neither an error nor an abort, settling the session
  // idle AND wiping the failure text with it.
  it.each(['model_error', 'api_error', 'turn_setup_failed', 'prompt_too_long', 'max_turns'])(
    'settles to error and keeps lastError when a turn with an error frame ends with %s',
    (terminalReason) => {
      const store = useSessionStreamStore.getState();
      store.applySnapshot(SID, snapshot({ cursor: 0 }));
      store.applyEvent(SID, { type: 'turn_start', seq: 1 });
      store.applyEvent(SID, errorEvent);
      store.applyEvent(SID, { type: 'turn_end', seq: 3, terminalReason });
      const s = useSessionStreamStore.getState().getSession(SID);
      expect(s.status?.lifecycle).toBe('error');
      expect(s.status?.lastError?.message).toBe('Model overloaded');
    }
  );

  // The absolving half, and the reason it is an allowlist rather than just
  // `completed`: these three ride the SDK's success result — the turn handed
  // work off and is coming back (the DOR-1100 continuation). Failing them
  // would call a turn that is still working a turn that broke.
  it.each(['background_requested', 'tool_deferred', 'tool_deferred_unavailable'])(
    'stays idle when an error frame is excused by %s',
    (terminalReason) => {
      const store = useSessionStreamStore.getState();
      store.applySnapshot(SID, snapshot({ cursor: 0 }));
      store.applyEvent(SID, { type: 'turn_start', seq: 1 });
      store.applyEvent(SID, errorEvent);
      store.applyEvent(SID, { type: 'turn_end', seq: 3, terminalReason });
      expect(useSessionStreamStore.getState().getSession(SID).status?.lifecycle).toBe('idle');
    }
  );

  // A stop outranks the frame, and with NO stop record on the turn_end that
  // stays true whatever the frame said — the degradation pin for every runtime
  // that keeps no such record (codex, opencode) and every turn recorded before
  // the field existed.
  it('settles to interrupted, not error, when an aborted turn carried an error frame', () => {
    const store = useSessionStreamStore.getState();
    store.applySnapshot(SID, snapshot({ cursor: 0 }));
    store.applyEvent(SID, { type: 'turn_start', seq: 1 });
    store.applyEvent(SID, errorEvent);
    store.applyEvent(SID, { type: 'turn_end', seq: 3, terminalReason: 'aborted_streaming' });
    expect(useSessionStreamStore.getState().getSession(SID).status?.lifecycle).toBe('interrupted');
  });

  // The refusal case, on the client half of the mirror. An API refusal aborts
  // the main turn controller, so the turn ends `aborted_streaming` while
  // DorkOS never asked for a stop — and the mapper KEEPS the error frame on
  // purpose. Read on shape alone the composer said "you stopped this" about a
  // turn the operator never touched, and the clear that follows the derivation
  // took the refusal text with it.
  it.each(['interrupted', 'aborted_streaming', 'aborted_tools'])(
    'settles to error and keeps lastError when %s carried no stop request',
    (terminalReason) => {
      const store = useSessionStreamStore.getState();
      store.applySnapshot(SID, snapshot({ cursor: 0 }));
      store.applyEvent(SID, { type: 'turn_start', seq: 1 });
      store.applyEvent(SID, errorEvent);
      store.applyEvent(SID, {
        type: 'turn_end',
        seq: 3,
        terminalReason,
        stopWasRequested: false,
      });
      const s = useSessionStreamStore.getState().getSession(SID);
      expect(s.status?.lifecycle).toBe('error');
      expect(s.status?.lastError?.message).toBe('Model overloaded');
    }
  );

  it.each(['interrupted', 'aborted_streaming', 'aborted_tools'])(
    'still settles to interrupted when %s WAS requested',
    (terminalReason) => {
      // Unchanged behavior for the turn a person actually stopped, which is
      // the mistake that would cost most if this rule over-fired.
      const store = useSessionStreamStore.getState();
      store.applySnapshot(SID, snapshot({ cursor: 0 }));
      store.applyEvent(SID, { type: 'turn_start', seq: 1 });
      store.applyEvent(SID, errorEvent);
      store.applyEvent(SID, {
        type: 'turn_end',
        seq: 3,
        terminalReason,
        stopWasRequested: true,
      });
      const s = useSessionStreamStore.getState().getSession(SID);
      expect(s.status?.lifecycle).toBe('interrupted');
      expect(s.status?.lastError).toBeNull();
    }
  );

  // Real failure mode, and it reached main's own send tests before this guard
  // existed. `status_change.status` is `.partial()`, so a delta can carry one
  // field — and `mergeStatus` used to fall back to that delta itself when no
  // snapshot had hydrated yet ("prior is non-null in practice"), leaving a
  // held status with no `lastError` key at all. `lastError` is typed
  // `ErrorEvent | null`, so a `!== null` test LOOKED total; reading `.code`
  // off nothing THREW inside the projection, and an ordinary turn ending
  // stopped settling — the session stayed `streaming` and the composer stayed
  // locked. The root fix is that the held status is a WHOLE `SessionStatus`
  // from the first event on, so the fields the derivation reads
  // unconditionally are all there.
  //
  // Deliberately applies NO snapshot, because that is the whole reproduction.
  it('settles a turn whose held status was built by a status_change alone (no snapshot yet)', () => {
    const store = useSessionStreamStore.getState();
    store.applyEvent(SID, { type: 'turn_start', seq: 1 });
    store.applyEvent(SID, {
      type: 'status_change',
      seq: 2,
      status: { lifecycle: 'streaming', permissionMode: 'default' },
    });
    expect(useSessionStreamStore.getState().getSession(SID).status?.lastError).toBeNull();

    store.applyEvent(SID, { type: 'turn_end', seq: 3, terminalReason: 'model_error' });
    const s = useSessionStreamStore.getState().getSession(SID);
    expect(s.status?.lifecycle).toBe('idle');
    expect(s.status?.lastError).toBeNull();
    expect(s.status?.cost).toBeNull();
  });

  // The second defense, kept because the first cannot reach every source of a
  // missing key: a snapshot minted by a server that predates `lastError`
  // hydrates status WHOLESALE, so `mergeStatus` never sees it and the field is
  // structurally absent however complete the store's own base is. The
  // derivation therefore reads `lastError` truthily rather than `!== null`.
  it('settles a turn hydrated from a snapshot whose status predates lastError', () => {
    const store = useSessionStreamStore.getState();
    const { lastError: _omitted, ...withoutLastError } = STATUS;
    store.applySnapshot(SID, snapshot({ cursor: 0, status: withoutLastError as SessionStatus }));
    store.applyEvent(SID, { type: 'turn_start', seq: 1 });
    store.applyEvent(SID, { type: 'turn_end', seq: 2, terminalReason: 'model_error' });
    expect(useSessionStreamStore.getState().getSession(SID).status?.lifecycle).toBe('idle');
  });

  it('snapshot hydration carries lastError (reconnect after a failed turn)', () => {
    const held = { message: 'Sidecar crashed', category: 'execution_error' as const };
    useSessionStreamStore
      .getState()
      .applySnapshot(SID, snapshot({ status: { ...STATUS, lifecycle: 'error', lastError: held } }));
    expect(useSessionStreamStore.getState().getSession(SID).status?.lastError).toEqual(held);
  });
});
