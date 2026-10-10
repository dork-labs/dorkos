import { describe, expect, it } from 'vitest';
import {
  activityBadge,
  connectionsBadge,
  routeTabIdentity,
  schedulesAttentionCount,
  schedulesBadge,
} from '../lib/tab-identity';

describe('schedulesBadge', () => {
  const idle = { waiting: 0, failed: 0, running: [] };

  it('says nothing when nothing is going on', () => {
    expect(schedulesBadge(idle)).toBeNull();
  });

  it.each([
    [{ waiting: 1 }, { status: 'needs-you', count: 1, sentence: '1 schedule waits for your OK' }],
    [{ waiting: 2 }, { status: 'needs-you', count: 2, sentence: '2 schedules wait for your OK' }],
    [{ failed: 1 }, { status: 'failed', count: 1, sentence: '1 schedule failed its last run' }],
    [{ failed: 3 }, { status: 'failed', count: 3, sentence: '3 schedules failed their last run' }],
    [{ running: ['Morning digest'] }, { status: 'working', sentence: 'Morning digest is running' }],
    [{ running: ['A', 'B'] }, { status: 'working', sentence: '2 schedules are running' }],
  ])('%o reads %o', (input, badge) => {
    expect(schedulesBadge({ ...idle, ...input })).toEqual(badge);
  });

  it('puts waiting for your OK ahead of a failure, and a failure ahead of running', () => {
    expect(schedulesBadge({ waiting: 1, failed: 2, running: ['A'] })?.status).toBe('needs-you');
    expect(schedulesBadge({ waiting: 0, failed: 2, running: ['A'] })?.status).toBe('failed');
  });

  it('keeps every sentence within the copy cap', () => {
    const long = 'A schedule with a name long enough to wrap';
    const badge = schedulesBadge({ waiting: 0, failed: 0, running: [long] });
    expect(badge!.sentence!.split(/\s+/).length).toBeLessThanOrEqual(15);
  });
});

describe('schedulesAttentionCount', () => {
  it('adds the waiting and the failed, never the running', () => {
    expect(schedulesAttentionCount({ waiting: 2, failed: 1, running: ['A', 'B'] })).toBe(3);
    expect(schedulesAttentionCount({ waiting: 0, failed: 0, running: ['A'] })).toBe(0);
  });
});

describe('activityBadge', () => {
  it('says nothing when nothing is new', () => {
    expect(activityBadge(0)).toBeNull();
  });

  it('counts what is new since you last looked', () => {
    expect(activityBadge(1)).toEqual({
      status: 'new',
      count: 1,
      sentence: '1 new event since you last looked',
    });
    expect(activityBadge(4)?.sentence).toBe('4 new events since you last looked');
  });
});

describe('connectionsBadge', () => {
  it('says nothing when nothing waits', () => {
    expect(connectionsBadge(0)).toBeNull();
  });

  it('counts the requests waiting for your OK', () => {
    expect(connectionsBadge(1)).toEqual({
      status: 'needs-you',
      count: 1,
      sentence: '1 request waits for your OK',
    });
    expect(connectionsBadge(3)?.sentence).toBe('3 requests wait for your OK');
  });
});

describe('a route tab wearing its badge', () => {
  it('Schedules: the count reads as urgent, and the sentence is announced', () => {
    const id = routeTabIdentity('/tasks', schedulesBadge({ waiting: 2, failed: 0, running: [] }));
    expect(id).toMatchObject({ primary: 'Schedules', count: 2, countEmphasis: true });
    expect(id.accessibleName).toBe('Schedules, Needs you: 2 schedules wait for your OK');
  });

  it('Schedules running: a dot, no count', () => {
    const id = routeTabIdentity(
      '/tasks',
      schedulesBadge({ waiting: 0, failed: 0, running: ['Morning digest'] })
    );
    expect(id).toMatchObject({ status: 'working', count: undefined });
    expect(id.accessibleName).toBe('Schedules, Working: Morning digest is running');
  });

  it('Activity: a quiet count, since nothing is waiting on you', () => {
    const id = routeTabIdentity('/activity', activityBadge(5));
    expect(id).toMatchObject({
      primary: 'Activity',
      status: 'new',
      count: 5,
      countEmphasis: false,
    });
    expect(id.accessibleName).toBe('Activity, New: 5 new events since you last looked');
  });

  it('Connections: an urgent count', () => {
    const id = routeTabIdentity('/connections', connectionsBadge(1));
    expect(id).toMatchObject({ primary: 'Connections', count: 1, countEmphasis: true });
  });
});
