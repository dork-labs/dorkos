/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import type { Task } from '@dorkos/shared/types';
import { taskFilterSchema, taskSortOptions } from '../lib/task-filter-schema';

/** A task with only the fields the status column reads. */
const task = (id: string, overrides: Pick<Task, 'status' | 'enabled'>): Task =>
  ({ id, name: id, prompt: 'p', description: '', ...overrides }) as Task;

const removed = task('removed', { status: 'paused', enabled: true });
const switchedOff = task('off', { status: 'active', enabled: false });
const live = task('live', { status: 'active', enabled: true });
const parked = task('parked', { status: 'pending_approval', enabled: true });
const all = [removed, switchedOff, live, parked];

/** The ids the status filter keeps for one status. */
function idsFor(status: string): string[] {
  return taskFilterSchema.applyFilters(all, { status: [status] }).map((t) => t.id);
}

describe('task status filter and sort', () => {
  it('files a paused row under Paused even when its switch is still on (FB-26)', () => {
    // A schedule whose file went away keeps the person's `enabled`; only its
    // status says it is not running.
    expect(idsFor('paused')).toEqual(['removed', 'off']);
    expect(idsFor('active')).toEqual(['live']);
    expect(idsFor('pending_approval')).toEqual(['parked']);
  });

  it('sorts by the same status the filter uses', () => {
    const accessor = taskSortOptions.status.accessor;
    expect(all.map((t) => accessor(t))).toEqual(['paused', 'paused', 'active', 'pending_approval']);
  });
});
