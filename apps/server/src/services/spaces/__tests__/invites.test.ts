import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { inspectInvite, issueInvite } from '../invites.js';

function config(extra: Record<string, string> = {}) {
  return parseConfig({
    COMMUNITY_DATABASE_URL: 'postgres://localhost/community',
    COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
    COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
    COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
    COMMUNITY_PUBLIC_URL: 'http://localhost:6481',
    COMMUNITY_STORAGE_PATH: '/tmp/community-test',
    ...extra,
  });
}

describe('community invite signatures', () => {
  it('binds purpose, community and expiry and permits a named prior key only during rotation', () => {
    const communityId = randomUUID();
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + 60_000);
    const old = config();
    const token = issueInvite(id, communityId, expiresAt, old);
    expect(inspectInvite(token, communityId, old)?.id).toBe(id);
    expect(inspectInvite(token, randomUUID(), old)).toBeNull();
    expect(inspectInvite(`${token}x`, communityId, old)).toBeNull();
    const rotated = config({
      COMMUNITY_INVITE_KEY_ID: 'v2',
      COMMUNITY_INVITE_SECRET: 'd'.repeat(32),
      COMMUNITY_INVITE_PREVIOUS_KEY_ID: 'v1',
      COMMUNITY_INVITE_PREVIOUS_SECRET: old.inviteSecret,
    });
    expect(inspectInvite(token, communityId, rotated)?.id).toBe(id);
    expect(
      inspectInvite(
        token,
        communityId,
        config({ COMMUNITY_INVITE_KEY_ID: 'v2', COMMUNITY_INVITE_SECRET: 'd'.repeat(32) })
      )
    ).toBeNull();
    expect(
      inspectInvite(
        issueInvite(randomUUID(), communityId, new Date(Date.now() - 1000), old),
        communityId,
        old
      )
    ).toBeNull();
  });
});
