/**
 * The three-way merge that turns a task write request into SKILL.md frontmatter.
 *
 * The case that matters is `null`. A task write says "clear this field" by
 * sending `null`, and the update route used to copy that straight into the
 * frontmatter object — producing `max-runtime: null` in the file, which
 * `TaskFrontmatterSchema` rejects. Once written, the watcher logs the file as
 * invalid and stops syncing it, and every later write skips the file entirely
 * because the route only rewrites a file that parsed. So a single cleared field
 * desynced the file from its row permanently.
 *
 * @module services/tasks/__tests__/task-frontmatter-merge
 */
import { describe, it, expect } from 'vitest';
import { mergeTaskFrontmatter } from '../task-frontmatter-merge.js';

describe('mergeTaskFrontmatter', () => {
  const base = {
    name: 'nightly-sweep',
    description: 'sweeps the backlog',
    'display-name': 'Nightly Sweep',
    cron: '0 3 * * *',
    timezone: 'UTC',
    enabled: true,
    'max-runtime': '30m',
    permissions: 'acceptEdits',
  };

  it('clears a field by REMOVING the key, never by writing null', () => {
    const merged = mergeTaskFrontmatter(base, {
      maxRuntime: null,
      displayName: null,
      cron: null,
      timezone: null,
    });

    for (const key of ['max-runtime', 'display-name', 'cron', 'timezone']) {
      expect(key in merged, `${key} should be gone, not null`).toBe(false);
    }
    // A cleared key is a key with no value at all — `null` is what breaks the file.
    expect(Object.values(merged)).not.toContain(null);
  });

  it('leaves a field the request did not mention exactly as it was', () => {
    const merged = mergeTaskFrontmatter(base, { description: 'sweeps harder' });

    expect(merged).toEqual({ ...base, description: 'sweeps harder' });
  });

  it('sets a field the request supplied', () => {
    const merged = mergeTaskFrontmatter(base, {
      name: 'renamed',
      displayName: 'Renamed',
      cron: '0 4 * * *',
      timezone: 'Europe/Berlin',
      enabled: false,
      maxRuntime: '1h',
      permissionMode: 'bypassPermissions',
    });

    expect(merged).toEqual({
      name: 'renamed',
      description: 'sweeps the backlog',
      'display-name': 'Renamed',
      cron: '0 4 * * *',
      timezone: 'Europe/Berlin',
      enabled: false,
      'max-runtime': '1h',
      permissions: 'bypassPermissions',
    });
  });

  it('sets `enabled: false` rather than treating it as "not supplied"', () => {
    // A falsy value that is not `undefined` is still a value. Pausing a task is
    // the write most likely to be dropped by a truthiness check.
    expect(mergeTaskFrontmatter(base, { enabled: false }).enabled).toBe(false);
  });

  it('does not mutate the frontmatter it was handed', () => {
    const original = { ...base };
    mergeTaskFrontmatter(base, { maxRuntime: null, cron: '0 9 * * *' });

    expect(base).toEqual(original);
  });

  it('keeps frontmatter keys it knows nothing about', () => {
    // `origin` and `shape` mark a Shape-installed task, and the route that
    // rewrites a file must not strip provenance it does not manage.
    const merged = mergeTaskFrontmatter(
      { ...base, origin: 'shape', shape: 'daily-standup' },
      { maxRuntime: null }
    );

    expect(merged.origin).toBe('shape');
    expect(merged.shape).toBe('daily-standup');
  });

  it('builds frontmatter from nothing, for the create path', () => {
    const merged = mergeTaskFrontmatter(
      { name: 'fresh', description: 'brand new' },
      { cron: '0 1 * * *', maxRuntime: undefined, displayName: undefined }
    );

    expect(merged).toEqual({ name: 'fresh', description: 'brand new', cron: '0 1 * * *' });
  });
});
