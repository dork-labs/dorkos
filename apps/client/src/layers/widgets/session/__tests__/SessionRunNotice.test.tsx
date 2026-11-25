// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChatRun } from '@dorkos/shared/run-schemas';
import type { SessionSnapshot } from '@dorkos/shared/session-stream';
import { useSessionStreamStore } from '@/layers/entities/session';
import { SessionRunNotice } from '../ui/SessionRunNotice';
import { RestoredDraftNotice } from '../ui/RestoredDraftNotice';

const SID = 'chat-1';

/** The run the record retired after its process died. */
const DIED: ChatRun = {
  id: '01RUNDEMO00000000000000000',
  chatSeq: 1,
  status: 'ended',
  openedBy: 'caller',
  attempt: 1,
  waitReason: null,
  queueMessageId: null,
  queuePosition: null,
  waitingOnPerson: false,
  ending: 'process_died',
  notice: 'restart_stopped',
  runtimeTurnRef: 3,
  warnings: [],
  createdAt: '2026-11-25T09:00:00.000Z',
  startedAt: '2026-11-25T09:00:01.000Z',
  endedAt: '2026-11-25T09:02:00.000Z',
};

/** A snapshot carrying these runs. */
function snapshotWith(runs: ChatRun[]): SessionSnapshot {
  return {
    messages: [],
    inProgressTurn: null,
    status: {
      contextUsage: null,
      cost: null,
      usage: null,
      cacheStats: null,
      model: null,
      permissionMode: 'default',
      todoCounts: null,
      runningSubagentCount: 0,
      lifecycle: 'idle',
      lastError: null,
      limit: null,
      accountUsage: null,
    },
    pendingInteractions: [],
    queuedMessages: [],
    canvas: [],
    runs,
    cursor: 2,
  };
}

afterEach(() => {
  cleanup();
  useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [], pinnedSessionId: null });
});

describe('the line about how the last run ended', () => {
  it('says DorkOS restarted, from the run record, and goes once a newer run is sent', () => {
    act(() => useSessionStreamStore.getState().applySnapshot(SID, snapshotWith([DIED])));
    render(<SessionRunNotice sessionId={SID} />);

    expect(screen.getByRole('status').textContent).toBe(
      'DorkOS restarted during this reply, so it stopped. Send a message to continue.'
    );

    act(() =>
      useSessionStreamStore.getState().applyEvent(SID, {
        type: 'run_update',
        seq: 3,
        runs: [
          DIED,
          {
            ...DIED,
            id: '01RUNNEXT00000000000000000',
            chatSeq: 2,
            status: 'queued',
            ending: null,
            notice: null,
          },
        ],
      })
    );
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('a restored draft’s line', () => {
  it('says the message may not have been seen, and offers Discard', async () => {
    const onDiscard = vi.fn();
    render(<RestoredDraftNotice onDiscard={onDiscard} />);

    expect(screen.getByRole('status').textContent).toContain(
      'DorkOS restarted. This message may not have been seen.'
    );
    await userEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });
});
