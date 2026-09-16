import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';

const valid = {
  COMMUNITY_DATABASE_URL: 'postgres://postgres:pass@localhost:5432/community',
  COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
  COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
  COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
  COMMUNITY_PUBLIC_URL: 'http://localhost:6481',
  COMMUNITY_STORAGE_PATH: '/tmp/community-blobs',
};

describe('community startup config', () => {
  it('requires every deployment secret and storage setting', () => {
    expect(() => parseConfig({})).toThrow('COMMUNITY_DATABASE_URL');
    expect(() => parseConfig({ ...valid, COMMUNITY_BOOTSTRAP_SECRET: undefined })).toThrow(
      'COMMUNITY_BOOTSTRAP_SECRET'
    );
  });

  it('enforces positive quotas and hard ceilings', () => {
    expect(parseConfig(valid).limits.postsPerTenMinutes).toBe(120);
    expect(() => parseConfig({ ...valid, COMMUNITY_POSTS_PER_TEN_MINUTES: '1001' })).toThrow();
    expect(() => parseConfig({ ...valid, COMMUNITY_TEXT_BYTES: '0' })).toThrow();
  });
});
