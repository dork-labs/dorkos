/**
 * The space notifications (DOR-2956): a teammate limit reached is told once per space, month and
 * limit, so a new limit can be told again; a reset of the saved limits is told once.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { COMMUNITY_NOTIFICATION_ENTRIES } from '../community-notifications.js';

describe('the teammate-limit notice', () => {
  it('is one per space, month and limit (review S4)', () => {
    const key = COMMUNITY_NOTIFICATION_ENTRIES['community.teammate-limit'].dedupeKey!;
    const base = { ref: 'remote_a', communityLabel: 'Acme', limitUsd: 5, month: '2026-10' };
    expect(key(base)).toBe(key({ ...base, communityLabel: 'Renamed' }));
    expect(key(base)).not.toBe(key({ ...base, limitUsd: 10 }));
    expect(key(base)).not.toBe(key({ ...base, month: '2026-11' }));
  });
});
