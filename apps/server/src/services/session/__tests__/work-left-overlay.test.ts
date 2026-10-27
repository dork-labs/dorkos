/**
 * Background commands a Stop could not end (DOR-3285) come back as one lasting
 * line under the stopped turn when the conversation is reopened: recorded the
 * instant they arrive, after the turn, with each command's later end folded in.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { HistoryMessage } from '@dorkos/shared/types';
import { applyWorkLeft, overlayWorkLeftRunning } from '../overlays/work-left-overlay.js';
import { SessionEventStore } from '../session-event-store.js';
import {
  disposeProjector,
  getOrCreateProjector,
  setSessionEventStore,
  type RawSessionEvent,
} from '../session-state-projector.js';
import { toRawSessionEvent } from '../session-event-normalizer.js';

afterEach(() => {
  setSessionEventStore(undefined);
  disposeProjector('sess');
});

const LEFT = {
  type: 'work_left_running',
  tasks: [
    { taskId: 'tail', command: 'tail -f server.log' },
    { taskId: 'deploy', command: 'npm run deploy' },
  ],
} as const;

function message(
  id: string,
  role: 'user' | 'assistant',
  timestamp: string,
  content = 'text'
): HistoryMessage {
  return { id, role, content, timestamp } as HistoryMessage;
}

/** History for three turns: the middle one is the one that was stopped. */
const HISTORY = [
  message('u-0', 'user', '2026-10-26T09:00:00.000Z', 'first'),
  message('a-0', 'assistant', '2026-10-26T09:00:01.000Z'),
  message('u-1', 'user', '2026-10-26T09:10:00.000Z', 'deploy it'),
  message('a-1', 'assistant', '2026-10-26T09:10:01.000Z'),
  message('a-1b', 'assistant', '2026-10-26T09:10:02.000Z'),
  message('u-2', 'user', '2026-10-26T09:20:00.000Z', 'what now'),
  message('a-2', 'assistant', '2026-10-26T09:20:01.000Z'),
];

describe('the line a Stop leaves for work still running', () => {
  it('survives a reload and a later turn, under the turn it stopped, with ends folded in', () => {
    setSessionEventStore(new SessionEventStore(createTestDb()));
    const projector = getOrCreateProjector('sess', undefined, { persist: 'record' });
    projector.ingest({ type: 'turn_start', userMessage: 'first' } as RawSessionEvent);
    projector.ingest({ type: 'turn_end' } as RawSessionEvent);
    projector.ingest({ type: 'turn_start', userMessage: 'deploy it' } as RawSessionEvent);
    projector.ingest({ type: 'turn_end' } as RawSessionEvent);
    // After the stopped turn closed: the stop waits on each task first.
    projector.ingest(LEFT as unknown as RawSessionEvent);
    // The next turn runs, and while it does one of the commands ends.
    projector.ingest({ type: 'turn_start', userMessage: 'what now' } as RawSessionEvent);
    projector.ingest({
      type: 'work_left_ended',
      taskId: 'deploy',
      status: 'failed',
    } as RawSessionEvent);
    projector.ingest({ type: 'turn_end' } as RawSessionEvent);
    // A reload: nothing is live any more.
    disposeProjector('sess');

    const out = overlayWorkLeftRunning('sess', HISTORY);

    expect(out.map((m) => m.id)).toEqual([
      'u-0',
      'a-0',
      'u-1',
      'a-1',
      'a-1b',
      expect.stringMatching(/^work-left-running-/),
      'u-2',
      'a-2',
    ]);
    expect(out[5]!.parts).toEqual([
      {
        type: 'work_left_running',
        tasks: [
          { taskId: 'tail', command: 'tail -f server.log' },
          { taskId: 'deploy', command: 'npm run deploy', ended: 'failed' },
        ],
      },
    ]);
  });

  it('closes history out when the stopped turn is the last one', () => {
    const out = applyWorkLeft(
      HISTORY.slice(0, 5),
      [{ event: { ...LEFT, seq: 4 } as never, createdAt: '2026-10-26T09:10:09.000Z' }],
      [
        { seq: 1, userMessage: 'first' },
        { seq: 3, userMessage: 'deploy it' },
      ]
    );
    expect(out.map((m) => m.id).at(-1)).toMatch(/^work-left-running-/);
    expect(out).toHaveLength(6);
  });

  it('falls back to the last message dated before it when its turn was never recorded', () => {
    const out = applyWorkLeft(
      HISTORY,
      [{ event: { ...LEFT, seq: 9 } as never, createdAt: '2026-10-26T09:10:09.000Z' }],
      []
    );
    expect(out.map((m) => m.id).indexOf('u-2') - 1).toBe(
      out.findIndex((m) => m.id.startsWith('work-left-running-'))
    );
  });

  it('is not drawn twice while the turn that carries it is still open', () => {
    setSessionEventStore(new SessionEventStore(createTestDb()));
    const projector = getOrCreateProjector('sess', undefined, { persist: 'record' });
    projector.ingest({ type: 'turn_start', userMessage: 'deploy it' } as RawSessionEvent);
    projector.ingest(LEFT as unknown as RawSessionEvent);
    // Still open: the live stream draws it, so the overlay does not.
    expect(overlayWorkLeftRunning('sess', [])).toEqual([]);
    disposeProjector('sess');
    expect(overlayWorkLeftRunning('sess', [])).toHaveLength(1);
  });

  it('returns history by reference when there is nothing to add', () => {
    expect(applyWorkLeft(HISTORY, [])).toBe(HISTORY);
  });

  it('is forwarded from the runtime’s stream events, and dropped when it names nothing', () => {
    expect(
      toRawSessionEvent({
        type: 'work_left_running',
        // A malformed entry with no task id, as a careless runtime might send.
        data: { tasks: [{ taskId: 'tail', command: 'tail -f server.log' }, { command: 'x' }] },
      } as unknown as Parameters<typeof toRawSessionEvent>[0])
    ).toEqual({
      type: 'work_left_running',
      tasks: [{ taskId: 'tail', command: 'tail -f server.log' }],
    });
    expect(toRawSessionEvent({ type: 'work_left_running', data: { tasks: [] } })).toBeNull();
    expect(
      toRawSessionEvent({ type: 'work_left_ended', data: { taskId: 'tail', status: 'stopped' } })
    ).toEqual({ type: 'work_left_ended', taskId: 'tail', status: 'stopped' });
  });
});
