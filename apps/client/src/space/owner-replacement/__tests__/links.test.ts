import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  completionNoticeDismissed,
  dismissCompletionNotice,
  parsePendingReplacementClaim,
  readPendingReplacementClaim,
  rememberPendingReplacementClaim,
} from '../links.js';

// What this browser remembers about an owner replacement: a claim's resume marker (never the
// token, never past the claim window) and a dismissed completion notice.
const COMMUNITY = '11111111-1111-4111-8111-111111111111';
const store = new Map<string, string>();
const memory = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
} as Storage;

beforeEach(() => {
  store.clear();
  vi.stubGlobal('sessionStorage', memory);
});
afterEach(() => vi.unstubAllGlobals());

describe('pending claim marker', () => {
  const claim = { communityId: COMMUNITY, communityName: 'Acme Ops', requiresSingleSignOn: true };

  it('lasts thirty minutes, and never past the claim window', () => {
    // Purpose: fails if a marker outlives the server's cookie or the claim itself.
    const now = Date.parse('2026-10-04T12:00:00.000Z');
    rememberPendingReplacementClaim({ ...claim, claimExpiresAt: '2026-10-18T12:00:00.000Z' }, now);
    expect(readPendingReplacementClaim(now)).toEqual({
      ...claim,
      resumeUntil: '2026-10-04T12:30:00.000Z',
    });
    rememberPendingReplacementClaim({ ...claim, claimExpiresAt: '2026-10-04T12:05:00.000Z' }, now);
    expect(readPendingReplacementClaim(Date.parse('2026-10-04T12:06:00.000Z'))).toBeNull();
    expect(store.size).toBe(0);
  });

  it('discards malformed markers', () => {
    // Purpose: fails if a tampered marker is trusted.
    const now = Date.now();
    const future = new Date(now + 60_000).toISOString();
    expect(parsePendingReplacementClaim('{', now)).toBeNull();
    expect(
      parsePendingReplacementClaim(
        JSON.stringify({ ...claim, communityId: '../x', resumeUntil: future }),
        now
      )
    ).toBeNull();
    expect(
      parsePendingReplacementClaim(
        JSON.stringify({ ...claim, requiresSingleSignOn: 'yes', resumeUntil: future }),
        now
      )
    ).toBeNull();
  });
});

describe('completion notice dismissal', () => {
  it('is remembered per community and completion', () => {
    // Purpose: fails if dismissing one completion hides another.
    dismissCompletionNotice(COMMUNITY, '2026-09-28T09:00:00.000Z', () => memory);
    expect(completionNoticeDismissed(COMMUNITY, '2026-09-28T09:00:00.000Z', () => memory)).toBe(
      true
    );
    expect(completionNoticeDismissed(COMMUNITY, '2026-09-29T09:00:00.000Z', () => memory)).toBe(
      false
    );
  });

  it('treats blocked storage as not dismissed, and never throws', () => {
    // Purpose: fails if a browser that refuses storage breaks the notice.
    const blocked = () => {
      throw new Error('blocked');
    };
    expect(() => dismissCompletionNotice(COMMUNITY, 'x', blocked)).not.toThrow();
    expect(completionNoticeDismissed(COMMUNITY, 'x', blocked)).toBe(false);
  });
});
