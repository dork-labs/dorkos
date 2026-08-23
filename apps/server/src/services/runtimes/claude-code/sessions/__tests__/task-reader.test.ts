import { describe, it, expect } from 'vitest';
import { parseTasks } from '../task-reader.js';

/** Build a JSONL `assistant` line with a single tool_use block. */
function toolUseLine(name: string, id: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, id, input }] },
  });
}

describe('parseTasks', () => {
  it('assigns sequential ids to TaskCreate calls and applies matching TaskUpdate', () => {
    const lines = [
      toolUseLine('TaskCreate', 'tc1', { subject: 'First task' }),
      toolUseLine('TaskCreate', 'tc2', { subject: 'Second task' }),
      toolUseLine('TaskUpdate', 'tc3', { taskId: '2', status: 'in_progress' }),
    ];

    const tasks = parseTasks(lines);
    expect(tasks).toHaveLength(2);
    expect(tasks.find((t) => t.id === '2')).toMatchObject({
      subject: 'Second task',
      status: 'in_progress',
    });
  });

  /**
   * DOR-1441: a TaskUpdate can carry an SDK task id that does not match this
   * reader's own creation-order counter (the two id spaces usually agree but
   * are not guaranteed to). Without a fallback, the update silently no-ops
   * against the wrong (or no) row and a refetch never repairs the drift,
   * because the reader always regenerates the same mismatched ids from the
   * same transcript.
   */
  it('resolves a TaskUpdate whose SDK id diverges from the creation-order counter via subject fallback', () => {
    const lines = [
      toolUseLine('TaskCreate', 'tc1', { subject: 'First task' }),
      toolUseLine('TaskCreate', 'tc2', { subject: 'Second task' }),
      // Non-sequential SDK id ("9") for the second task, carrying its subject
      // so the fallback can locate it despite the id mismatch.
      toolUseLine('TaskUpdate', 'tc3', {
        taskId: '9',
        subject: 'Second task',
        status: 'completed',
      }),
    ];

    const tasks = parseTasks(lines);
    expect(tasks).toHaveLength(2);
    const moved = tasks.find((t) => t.subject === 'Second task');
    expect(moved).toMatchObject({ id: '9', status: 'completed' });

    // The row is re-keyed under the SDK's real id — a later id-only update
    // (the common case; no subject) now resolves directly.
    const followUp = parseTasks([
      ...lines,
      toolUseLine('TaskUpdate', 'tc4', { taskId: '9', status: 'in_progress' }),
    ]);
    expect(followUp.find((t) => t.subject === 'Second task')).toMatchObject({
      id: '9',
      status: 'in_progress',
    });
  });

  it('does not fall back when the update carries no subject and the id is unknown', () => {
    const lines = [
      toolUseLine('TaskCreate', 'tc1', { subject: 'Only task' }),
      toolUseLine('TaskUpdate', 'tc2', { taskId: '9', status: 'completed' }),
    ];

    const tasks = parseTasks(lines);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: '1', subject: 'Only task', status: 'pending' });
  });
});
