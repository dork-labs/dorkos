import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  forgetPendingOwnerClaim,
  ownerClaimLink,
  parseOwnerClaimInput,
  parsePendingOwnerClaim,
  readPendingOwnerClaim,
  rememberPendingOwnerClaim,
} from './owner-claim.js';

const communityId = '11111111-1111-4111-8111-111111111111';
const token = 'Zm9vYmFyLWJhel9xdXV4LTEyMzQ1Njc4OTAtYWJjZGVm';

describe('ownerClaimLink', () => {
  it('keeps the secret in the fragment of the host-level claim route', () => {
    const link = new URL(ownerClaimLink('https://community.example', token));
    expect(link.pathname).toBe('/claim');
    expect(link.search).toBe('');
    expect(link.hash).toBe(`#claim=${token}`);
  });
});

describe('parseOwnerClaimInput', () => {
  it('reads the secret from a pasted link', () => {
    expect(parseOwnerClaimInput(` ${ownerClaimLink('https://h.example', token)}\n`)).toBe(token);
  });

  it('accepts a bare secret', () => {
    expect(parseOwnerClaimInput(token)).toBe(token);
  });

  it('refuses empty input, links without a claim, and text that cannot be a secret', () => {
    expect(parseOwnerClaimInput('   ')).toBeNull();
    expect(parseOwnerClaimInput('https://h.example/claim')).toBeNull();
    expect(parseOwnerClaimInput('https://h.example/claim#invite=abc')).toBeNull();
    expect(parseOwnerClaimInput('not a claim')).toBeNull();
  });
});

describe('pending owner claim marker', () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal('sessionStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('stores only the community ID and a resume deadline, never the secret', () => {
    const now = Date.parse('2026-09-23T12:00:00.000Z');
    rememberPendingOwnerClaim(communityId, '2026-09-24T12:00:00.000Z', now);
    const stored = [...store.values()].join('');
    expect(stored).not.toContain(token);
    expect(readPendingOwnerClaim(now)).toEqual({
      communityId,
      resumeUntil: '2026-09-23T12:30:00.000Z',
    });
  });

  it('never resumes past the claim expiry', () => {
    const now = Date.parse('2026-09-23T12:00:00.000Z');
    rememberPendingOwnerClaim(communityId, '2026-09-23T12:05:00.000Z', now);
    expect(readPendingOwnerClaim(now)?.resumeUntil).toBe('2026-09-23T12:05:00.000Z');
    expect(readPendingOwnerClaim(Date.parse('2026-09-23T12:06:00.000Z'))).toBeNull();
    expect(store.size).toBe(0);
  });

  it('discards malformed markers', () => {
    const now = Date.now();
    expect(parsePendingOwnerClaim('{', now)).toBeNull();
    expect(
      parsePendingOwnerClaim(JSON.stringify({ communityId: '../x', resumeUntil: '9999' }), now)
    ).toBeNull();
  });

  it('forgets the marker once the claim finishes', () => {
    rememberPendingOwnerClaim(communityId, new Date(Date.now() + 60_000).toISOString());
    forgetPendingOwnerClaim();
    expect(readPendingOwnerClaim()).toBeNull();
  });

  it('keeps working when the browser refuses storage', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(() => rememberPendingOwnerClaim(communityId, new Date().toISOString())).not.toThrow();
    expect(readPendingOwnerClaim()).toBeNull();
    expect(() => forgetPendingOwnerClaim()).not.toThrow();
  });
});
