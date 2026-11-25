// @vitest-environment jsdom
/**
 * A window reads a chat's status from its run record (spec
 * `turns-survive-restarts` §4.6, DOR-5212): the runs a snapshot or a
 * `run_update` carries, through the real store.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { ChatRun } from '@dorkos/shared/run-schemas';
import { useSessionStreamStore } from '../session-stream-store';
import { runNoticeOf } from '../chat-runs';
import { SID, STATUS, queued, queueUpdate, snapshot } from './session-stream-store.fixtures';

/** One run as the server sends it, `running` unless overridden. */
function run(overrides: Partial<ChatRun> = {}): ChatRun {
  return {
    id: '01RUNDEMO00000000000000000',
    chatSeq: 1,
    status: 'running',
    openedBy: 'caller',
    attempt: 1,
    waitReason: null,
    queueMessageId: null,
    queuePosition: null,
    waitingOnPerson: false,
    ending: null,
    notice: null,
    runtimeTurnRef: 3,
    warnings: [],
    createdAt: '2026-11-25T09:00:00.000Z',
    startedAt: '2026-11-25T09:00:01.000Z',
    endedAt: null,
    ...overrides,
  };
}

/** The run the record retired after its process died. */
const DIED = run({ status: 'ended', ending: 'process_died', notice: 'restart_stopped' });

const session = () => useSessionStreamStore.getState().sessions[SID]!;

beforeEach(() => {
  useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [], pinnedSessionId: null });
});

describe('a turn whose process died', () => {
  it('a window opened after it reads the ending, not "working"', () => {
    // The stream alone still says the turn runs: no `turn_end` ever came.
    useSessionStreamStore.getState().applySnapshot(
      SID,
      snapshot({
        status: { ...STATUS, lifecycle: 'streaming' },
        inProgressTurn: [{ type: 'turn_start', seq: 3 }],
        runs: [DIED],
      })
    );

    expect(session().status?.lifecycle).toBe('interrupted');
    expect(runNoticeOf(session().runs)).toBe('restart_stopped');
  });

  it('a window already open stops reading "working" when the record says so', () => {
    const store = useSessionStreamStore.getState();
    store.applySnapshot(SID, snapshot({ cursor: 2 }));
    store.applyEvent(SID, { type: 'turn_start', seq: 3 });
    store.applyEvent(SID, { type: 'run_update', seq: 4, runs: [run()] });
    expect(session().status?.lifecycle).toBe('streaming');

    store.applyEvent(SID, { type: 'run_update', seq: 5, runs: [DIED] });

    expect(session().status?.lifecycle).toBe('interrupted');
    expect(session().triggerPending).toBe(false);
  });

  it('never settles a turn the record does not hold, such as a scheduled run’s', () => {
    const store = useSessionStreamStore.getState();
    store.applySnapshot(SID, snapshot({ cursor: 2 }));
    store.applyEvent(SID, { type: 'turn_start', seq: 9 });

    store.applyEvent(SID, { type: 'run_update', seq: 10, runs: [DIED] });

    expect(session().status?.lifecycle).toBe('streaming');
  });

  it('drops the line once anything newer is sent', () => {
    const next = run({ id: '01RUNNEXT00000000000000000', chatSeq: 2, status: 'queued' });
    expect(runNoticeOf([DIED])).toBe('restart_stopped');
    expect(runNoticeOf([DIED, next])).toBeNull();
  });
});

describe('a restored draft', () => {
  it('is kept apart from the rows waiting in line', () => {
    const store = useSessionStreamStore.getState();
    store.applySnapshot(SID, snapshot());
    const draft = { ...queued('d1', 'handed back'), restored: true };

    store.applyEvent(SID, queueUpdate(6, [draft, queued('q1', 'in line')]));

    expect(session().queuedMessages.map((row) => row.id)).toEqual(['q1']);
    expect(session().restoredDrafts.map((row) => row.id)).toEqual(['d1']);
  });
});
