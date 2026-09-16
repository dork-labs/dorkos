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
// A package-shipped schedule found switched off: discovery still parks it at
// `pending_approval`, but nobody asked for it to run, so it files exactly
// like an ordinary switched-off task rather than one needing approval
// (DOR-2059).
const offByDefault = task('off-by-default', { status: 'pending_approval', enabled: false });
const all = [removed, switchedOff, live, parked, offByDefault];

/** The ids the status filter keeps for one status. */
function idsFor(status: string): string[] {
  return taskFilterSchema.applyFilters(all, { status: [status] }).map((t) => t.id);
}

describe('task status filter and sort', () => {
  it('files a paused row under Paused even when its switch is still on (FB-26)', () => {
    // A schedule whose file went away keeps the person's `enabled`; only its
    // status says it is not running.
    expect(idsFor('paused')).toEqual(['removed', 'off', 'off-by-default']);
    expect(idsFor('active')).toEqual(['live']);
    expect(idsFor('pending_approval')).toEqual(['parked']);
  });

  it('files a schedule a package shipped switched off under Paused, not Pending Approval (DOR-2059)', () => {
    expect(idsFor('paused')).toEqual(['removed', 'off', 'off-by-default']);
    expect(idsFor('pending_approval')).toEqual(['parked']);
  });

  it('sorts by the same status the filter uses', () => {
    const accessor = taskSortOptions.status.accessor;
    expect(all.map((t) => accessor(t))).toEqual([
      'paused',
      'paused',
      'active',
      'pending_approval',
      'paused',
    ]);
  });
});
