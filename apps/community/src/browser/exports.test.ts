import { describe, expect, it } from 'vitest';
import type { CommunityWireExport } from '@dorkos/shared/community-wire';
import { availableUntil, currentExport, exportInProgress, formatSize } from './exports.js';

const base: CommunityWireExport = {
  id: 'e1',
  scope: 'owner',
  state: 'ready',
  progress: { done: 1, total: 1 },
  byteSize: 10,
  failureCode: null,
  createdAt: '2026-09-24T10:00:00.000Z',
  readyAt: '2026-09-24T10:05:00.000Z',
  expiresAt: '2026-09-25T10:05:00.000Z',
};

describe('export panel helpers', () => {
  // Purpose: the size on the Download button reads as a person expects, from bytes to terabytes.
  it.each([
    [1, '1 byte'],
    [999, '999 bytes'],
    [1_000, '1 KB'],
    [812_345, '812 KB'],
    [12_400_000_000, '12.4 GB'],
    [1_500_000_000_000, '1.5 TB'],
  ])('formats %i bytes as %s', (bytes, text) => {
    expect(formatSize(bytes)).toBe(text);
  });

  // Purpose: the panel shows the newest export of its own scope and treats a cancelled or
  // expired one as history; fails if a personal export shows in the owner panel.
  it('picks the newest export of the panel’s scope, and none after cancel or expiry', () => {
    const personal = { ...base, id: 'p', scope: 'personal' as const };
    expect(currentExport([personal, base], 'owner')?.id).toBe('e1');
    expect(currentExport([personal], 'owner')).toBeNull();
    expect(currentExport([{ ...base, state: 'expired' }], 'owner')).toBeNull();
    expect(currentExport([{ ...base, state: 'cancelled' }], 'owner')).toBeNull();
    expect(currentExport([{ ...base, state: 'failed' }], 'owner')?.state).toBe('failed');
  });

  // Purpose: only a queued or building export is polled.
  it('polls only an export in progress', () => {
    expect(exportInProgress({ ...base, state: 'queued' })).toBe(true);
    expect(exportInProgress({ ...base, state: 'building' })).toBe(true);
    expect(exportInProgress(base)).toBe(false);
    expect(exportInProgress(null)).toBe(false);
  });

  it('says until when a ready export is available', () => {
    expect(availableUntil(base.expiresAt!, 'en-GB')).toMatch(/^Available until .*25.*\.$/);
  });
});
