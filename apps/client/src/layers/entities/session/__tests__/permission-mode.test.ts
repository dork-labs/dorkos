import { describe, it, expect } from 'vitest';
import { resolvePermissionMode } from '../lib/permission-mode';
import { sessionKeys } from '../api/query-keys';

describe('resolvePermissionMode', () => {
  it('prefers a change the person just made over the last server row', () => {
    expect(resolvePermissionMode('bypassPermissions', 'default')).toBe('bypassPermissions');
  });

  it('falls back to the server row, then to asking for everything', () => {
    expect(resolvePermissionMode(undefined, 'plan')).toBe('plan');
    expect(resolvePermissionMode(undefined, undefined)).toBe('default');
  });
});

describe('sessionKeys', () => {
  it('builds the detail key readers and writers must both use', () => {
    // `getQueryData` matches exactly. The DOR-482 defect was a reader that
    // dropped the trailing cwd segment and so matched nothing, forever.
    expect(sessionKeys.detail('s1', '/work/proj')).toEqual(['session', 's1', '/work/proj']);
    expect(sessionKeys.detail('s1', null)).toEqual(['session', 's1', null]);
  });

  it('keeps the invalidation prefix distinct from the detail key', () => {
    // Prefix matching makes this correct for `invalidateQueries` and wrong for
    // `getQueryData` — the two are not interchangeable.
    expect(sessionKeys.bySession('s1')).toEqual(['session', 's1']);
    expect(sessionKeys.bySession('s1')).not.toEqual(sessionKeys.detail('s1', null));
  });
});
