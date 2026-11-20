/**
 * What a run approval writes into `extensions` (DOR-4573): the old copy's
 * rooms and agents go when the yes is for another copy or other files, and
 * stay when it is for the same one.
 *
 * @module services/extensions/pin/__tests__/extension-approval-write
 */
import { describe, it, expect } from 'vitest';
import type { UserConfig } from '@dorkos/shared/config-schema';
import { isSameApprovedCopy, withRunApproval } from '../extension-approval-write.js';

const D1 = `sha256:${'1'.repeat(64)}`;
const D2 = `sha256:${'2'.repeat(64)}`;
const COPY = { path: '/home/sample/.dork/plugins/notes/.dork/extensions/notes', plugin: 'notes' };
const DECLARED = { runtime: 'subprocess' as const, net: [], run: [], agents: false };

function extensionsWith(source: typeof COPY & { digest?: string; devLink?: string }) {
  return {
    enabled: ['notes'],
    disabled: [],
    approvedToRun: ['notes'],
    approvedSources: { notes: source },
    approvedPermissions: {},
    dismissedApprovals: {},
    trustedSources: [],
    roomAccess: { notes: ['room-1'], other: ['room-2'] },
    forwardAgents: { notes: ['agent-1'], other: ['agent-2'] },
  } as UserConfig['extensions'];
}

describe('isSameApprovedCopy', () => {
  it('counts a first approval as the same copy, so it drops nothing', () => {
    expect(isSameApprovedCopy(undefined, { ...COPY, digest: D1 })).toBe(true);
  });

  it.each([
    ['another folder', { path: '/home/sample/other/notes' }],
    ['another plugin', { plugin: 'notes-fork' }],
    ['a dev link', { devLink: '/home/sample/src/notes' }],
    ['other files', { digest: D2 }],
  ])('tells %s apart', (_label, change) => {
    expect(isSameApprovedCopy({ ...COPY, digest: D1 }, { ...COPY, digest: D1, ...change })).toBe(
      false
    );
  });

  it('compares the copy and its files, not the grants digest beside them', () => {
    expect(isSameApprovedCopy({ ...COPY, digest: D1 }, { ...COPY, digest: D1, grants: 'g1' })).toBe(
      true
    );
  });
});

describe('withRunApproval', () => {
  it('drops only this id’s rooms and agents when another copy is approved', () => {
    const next = withRunApproval(
      extensionsWith({ ...COPY, digest: D1 }),
      'notes',
      { ...COPY, digest: D2 },
      DECLARED
    );
    expect(next.roomAccess).toEqual({ other: ['room-2'] });
    expect(next.forwardAgents).toEqual({ other: ['agent-2'] });
    expect(next.approvedSources?.notes?.digest).toBe(D2);
  });

  it('keeps them when the same copy and files are approved again', () => {
    const next = withRunApproval(
      extensionsWith({ ...COPY, digest: D1 }),
      'notes',
      { ...COPY, digest: D1, grants: 'g1' },
      DECLARED
    );
    expect(next.roomAccess).toEqual({ notes: ['room-1'], other: ['room-2'] });
    expect(next.forwardAgents).toEqual({ notes: ['agent-1'], other: ['agent-2'] });
  });

  it('answers a "Not now" for the id', () => {
    const before = {
      ...extensionsWith({ ...COPY, digest: D1 }),
      dismissedApprovals: {
        notes: { path: COPY.path, version: '1.0.0', dismissedAt: '2026-11-01T00:00:00.000Z' },
        other: { path: '/x', version: '1.0.0', dismissedAt: '2026-11-01T00:00:00.000Z' },
      },
    } as UserConfig['extensions'];
    const next = withRunApproval(before, 'notes', { ...COPY, digest: D1 }, DECLARED);
    expect(Object.keys(next.dismissedApprovals ?? {})).toEqual(['other']);
  });
});
