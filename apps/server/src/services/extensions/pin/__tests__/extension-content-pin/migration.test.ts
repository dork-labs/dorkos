import { stored, ISOLATED, IN_PROCESS, HOME, COPY_PATH, copy } from './harness.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { grantsDigestOf } from '../../extension-path-trust.js';
import { mayRunExtensionCode } from '../../../extension-load-policy.js';
import {
  bindUnsourcedApprovals,
  pinPathOnlyApprovals,
  settleLegacyApprovals,
} from '../../extension-approval-upkeep.js';

describe('pinning older path-only approvals, once (migration)', () => {
  beforeEach(() => {
    stored.extensions = {
      enabled: ['notes'],
      disabled: [],
      approvedToRun: ['notes'],
      // As the '0.126.1' config migration marks an approval that predates content pins.
      approvedSources: { notes: { path: COPY_PATH, legacyPathOnly: true } },
    };
  });

  it('never pins a digest-less approval the migration did not mark (written since)', () => {
    stored.extensions = { ...stored.extensions, approvedSources: { notes: { path: COPY_PATH } } };
    expect(pinPathOnlyApprovals([copy({ manifest: IN_PROCESS })])).toEqual([]);
    expect(mayRunExtensionCode(copy({ manifest: IN_PROCESS }), stored.extensions as never)).toBe(
      false
    );
  });

  it('pins a path-only approval to the files found, and records that it did', () => {
    expect(pinPathOnlyApprovals([copy({ manifest: IN_PROCESS })])).toEqual(['notes']);
    expect((stored.extensions.approvedSources as Record<string, unknown>).notes).toEqual({
      path: COPY_PATH,
      digest: `sha256:${'1'.repeat(64)}`,
      pinnedOnFirstUse: expect.any(String),
    });
  });

  it('is idempotent: a second scan, even after an edit, changes nothing', () => {
    pinPathOnlyApprovals([copy()]);
    const once = JSON.stringify(stored.extensions);
    expect(pinPathOnlyApprovals([copy({ currentDigest: `sha256:${'2'.repeat(64)}` })])).toEqual([]);
    expect(JSON.stringify(stored.extensions)).toBe(once);
  });

  it('gives an older approval only the first scan: a copy that appears later waits', () => {
    // First scan after start: no copy at that name, so nothing is pinned.
    expect(pinPathOnlyApprovals([])).toEqual([]);
    expect(settleLegacyApprovals()).toEqual(['notes']);
    // A later scan finds a folder at the old name: it is not adopted.
    expect(pinPathOnlyApprovals([copy({ manifest: IN_PROCESS })])).toEqual([]);
    expect((stored.extensions.approvedSources as Record<string, unknown>).notes).toEqual({
      path: COPY_PATH,
    });
    expect(mayRunExtensionCode(copy({ manifest: IN_PROCESS }), stored.extensions as never)).toBe(
      false
    );
  });

  it('keeps what the first scan pinned when it settles', () => {
    pinPathOnlyApprovals([copy({ manifest: IN_PROCESS })]);
    const pinned = JSON.stringify(stored.extensions.approvedSources);
    settleLegacyApprovals();
    expect(JSON.stringify(stored.extensions.approvedSources)).toBe(pinned);
  });

  it('never binds an unsourced older approval to a folder that appears after the first scan', () => {
    const dorkHome = '/dork-home';
    const direct = copy({
      manifest: IN_PROCESS,
      path: '/dork-home/extensions/notes',
      scope: 'global',
    });
    stored.extensions = { ...stored.extensions, approvedSources: {}, legacyUnsourced: ['notes'] };
    bindUnsourcedApprovals([], dorkHome);
    settleLegacyApprovals();
    expect(stored.extensions).not.toHaveProperty('legacyUnsourced');
    bindUnsourcedApprovals([direct], dorkHome);
    expect(stored.extensions.approvedSources).toEqual({});
    expect(mayRunExtensionCode(direct, stored.extensions as never)).toBe(false);
  });

  it('pins an isolated one too: no older approval recorded its author', () => {
    expect(pinPathOnlyApprovals([copy()])).toEqual(['notes']);
  });

  it('never touches an approval that keeps path trust, or one for another copy', () => {
    stored.extensions = {
      ...stored.extensions,
      approvedSources: {
        notes: { path: COPY_PATH, authorHome: HOME, grants: grantsDigestOf(ISOLATED) },
      },
    };
    expect(pinPathOnlyApprovals([copy()])).toEqual([]);
    stored.extensions = { ...stored.extensions, approvedSources: { notes: { path: '/other' } } };
    expect(pinPathOnlyApprovals([copy()])).toEqual([]);
  });
});
