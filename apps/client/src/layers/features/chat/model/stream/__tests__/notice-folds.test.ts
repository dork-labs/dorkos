/**
 * The line a Stop leaves (DOR-3285) is drawn live, updates in place as each
 * command ends, and is never drawn twice once history has it.
 */
import { describe, it, expect } from 'vitest';
import type { HistoryMessage } from '@dorkos/shared/types';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { projectSessionMessages } from '../project-session-turn';

const LEFT = {
  type: 'work_left_running',
  seq: 5,
  tasks: [
    { taskId: 'tail', command: 'tail -f server.log' },
    { taskId: 'deploy', command: 'npm run deploy' },
  ],
} as SessionEvent;

const ended = (taskId: string, seq: number) =>
  ({ type: 'work_left_ended', seq, taskId, status: 'completed' }) as SessionEvent;

const HISTORY_LINE: HistoryMessage = {
  id: 'work-left-running-5',
  role: 'assistant',
  content: '',
  parts: [
    {
      type: 'work_left_running',
      tasks: [
        { taskId: 'tail', command: 'tail -f server.log' },
        { taskId: 'deploy', command: 'npm run deploy' },
      ],
    },
  ],
} as HistoryMessage;

/** Every `work_left_running` part in the rendered list. */
function lines(messages: ReturnType<typeof projectSessionMessages>) {
  return messages.flatMap((m) => m.parts.filter((p) => p.type === 'work_left_running'));
}

describe('the line a Stop leaves, live', () => {
  it('draws the live event as a line', () => {
    const out = projectSessionMessages([], [LEFT]);
    expect(lines(out)).toEqual([
      {
        type: 'work_left_running',
        tasks: [
          { taskId: 'tail', command: 'tail -f server.log' },
          { taskId: 'deploy', command: 'npm run deploy' },
        ],
      },
    ]);
  });

  it('marks a command ended in place when its end arrives live', () => {
    const out = projectSessionMessages([], [LEFT, ended('deploy', 6)]);
    expect(lines(out)).toHaveLength(1);
    expect(lines(out)[0]).toMatchObject({
      tasks: [{ taskId: 'tail' }, { taskId: 'deploy', ended: 'completed' }],
    });
  });

  it('folds a live end into a line that is already in history, without mutating it', () => {
    const out = projectSessionMessages([HISTORY_LINE], [ended('tail', 9)]);
    expect(lines(out)).toEqual([
      {
        type: 'work_left_running',
        tasks: [
          { taskId: 'tail', command: 'tail -f server.log', ended: 'completed' },
          { taskId: 'deploy', command: 'npm run deploy' },
        ],
      },
    ]);
    expect(HISTORY_LINE.parts![0]).not.toHaveProperty('tasks.0.ended');
  });

  it('draws the line once when history and the live turn both carry it', () => {
    const out = projectSessionMessages([HISTORY_LINE], [LEFT]);
    expect(lines(out)).toHaveLength(1);
    expect(out.find((m) => m.parts.some((p) => p.type === 'work_left_running'))!.id).toBe(
      'work-left-running-5'
    );
  });
});
