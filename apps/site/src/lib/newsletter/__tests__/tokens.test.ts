import { describe, expect, it } from 'vitest';

import { generateNewsletterToken, hashNewsletterToken } from '../tokens';

describe('newsletter tokens', () => {
  it('hashes the raw token to a stable 64-char hex sha256', () => {
    const { raw, hash } = generateNewsletterToken();
    expect(raw).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashNewsletterToken(raw)).toBe(hash);
  });

  it('never stores the raw token (hash differs from raw)', () => {
    const { raw, hash } = generateNewsletterToken();
    expect(hash).not.toBe(raw);
  });

  it('produces a unique token each call', () => {
    const a = generateNewsletterToken();
    const b = generateNewsletterToken();
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).not.toBe(b.hash);
  });
});
