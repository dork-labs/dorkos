/**
 * The owner-replacement notification (DOR-2543): what it says, how it is deduped, and the ledger
 * that keeps it to once per request and phase for the whole life of a request, longer than the
 * notifications table keeps anything.
 */
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommunityConnectionOwnerNotice } from '@dorkos/shared/community-connections';
import { NOTIFICATION_RETENTION_DAYS } from '../notification-store.js';
import { notificationEntry } from '../notification-registry.js';
import {
  CommunityOwnerNoticeAnnouncer,
  OWNER_NOTICE_LEDGER_FILE,
  ownerNoticeKey,
  ownerNoticePayload,
} from '../emitters/community-owner-replacement.js';

const DAY = 24 * 60 * 60 * 1000;
/** What `notify` answers when it stored the row. */
const STORED: { notification: unknown; deduped: boolean } = {
  notification: { id: 'stored' },
  deduped: false,
};
/** What `notify` answers when the store failed: it never throws. */
const NOT_STORED: { notification: unknown; deduped: boolean } = {
  notification: null,
  deduped: false,
};
const open: CommunityConnectionOwnerNotice = {
  state: 'open',
  replacementId: 'replacement-1',
  requestState: 'waiting',
  requestedAt: '2026-09-20T10:00:00.000Z',
  claimableAfter: '2026-10-04T10:00:00.000Z',
  claimReissuedAt: null,
  options: { keep: true, transfer: true, delete: true, needsPassword: false },
};
const completed: CommunityConnectionOwnerNotice = {
  state: 'completed',
  replacementId: 'replacement-1',
  newOwnerDisplayName: 'Riley',
  completedAt: '2026-10-05T09:00:00.000Z',
};

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'owner-notice-ledger-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('the owner-replacement notification', () => {
  const entry = notificationEntry('community.owner-replacement');

  it('says what is happening, when, and what the owner can do', () => {
    const payload = ownerNoticePayload('remote_a', 'Night shift', open);
    expect(entry.title(payload)).toBe('Someone asked to take over Night shift');
    expect(entry.body?.(payload)).toBe(
      'Unless you keep ownership, the host can make someone else its owner on or after Sunday, October 4, 2026 (UTC). Open the space to keep it.'
    );
    expect(
      entry.body?.(
        ownerNoticePayload('remote_a', 'Night shift', { ...open, requestState: 'claimable' })
      )
    ).toContain('its owner at any time now.');
    expect(
      entry.body?.(ownerNoticePayload('remote_a', 'Night shift', { ...open, claimableAfter: null }))
    ).toContain('after a waiting period of at least 7 days.');
    const done = ownerNoticePayload('remote_a', 'Night shift', completed);
    expect(entry.title(done)).toBe('Riley is now the owner of Night shift');
    expect(entry.body?.(done)).toBe('You are still a member.');
    // It opens the community's page in the app, never anything off this machine.
    expect(entry.locate(done)).toEqual({ subjectId: 'remote_a' });
    expect(entry.relay).toBe('never');
  });

  // Purpose: one row per request and phase, and a window longer than any request can stay open
  // (180-day longest wait plus a 14-day claim window).
  it('dedupes per community, request and phase, for longer than a request can last', () => {
    const payload = ownerNoticePayload('remote_a', 'Night shift', open);
    expect(entry.dedupeKey(payload)).toBe('owner-replacement:remote_a:replacement-1:open');
    expect(entry.dedupeKey(payload)).toBe(ownerNoticeKey('remote_a', open));
    expect(entry.dedupeKey(ownerNoticePayload('remote_a', 'Night shift', completed))).toBe(
      'owner-replacement:remote_a:replacement-1:completed'
    );
    expect(entry.dedupeWindowMs).toBeGreaterThan(194 * DAY);
  });
});

describe('announcing an owner notice once', () => {
  function announcer(
    raise: (payload: unknown) => Promise<{ notification: unknown; deduped: boolean }>
  ) {
    return new CommunityOwnerNoticeAnnouncer(home, raise);
  }

  // Purpose: the ledger, not the notifications table, is what makes it once: the table keeps only
  // 30 days, and a request can stay open far longer. Fails if a restart, or a second announcer
  // over the same data, raised the same request again.
  it('raises each request and phase once, across restarts', async () => {
    expect(NOTIFICATION_RETENTION_DAYS).toBeLessThan(194);
    const raise = vi.fn(async () => STORED);
    const first = announcer(raise);
    await Promise.all([
      first.announce('remote_a', 'Night shift', open),
      first.announce('remote_a', 'Night shift', open),
    ]);
    await announcer(raise).announce('remote_a', 'Night shift', open);
    expect(raise).toHaveBeenCalledTimes(1);
    await announcer(raise).announce('remote_a', 'Night shift', completed);
    await announcer(raise).announce('remote_a', 'Night shift', { ...open, replacementId: 'r-2' });
    await announcer(raise).announce('remote_b', 'Day shift', open);
    expect(raise).toHaveBeenCalledTimes(4);
    const ledger = JSON.parse(await readFile(join(home, OWNER_NOTICE_LEDGER_FILE), 'utf-8'));
    expect(ledger).toContain('owner-replacement:remote_a:replacement-1:completed');
  });

  it('starts over from an unreadable ledger', async () => {
    const file = join(home, OWNER_NOTICE_LEDGER_FILE);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, 'not json');
    const raise = vi.fn(async () => STORED);
    await announcer(raise).announce('remote_a', 'Night shift', open);
    expect(raise).toHaveBeenCalledTimes(1);
  });

  // Purpose: notify() never throws; a store failure answers with no row. Fails if the key were
  // recorded before (or regardless of) the raise, which would lose the notice for good.
  it('tries again on the next read when the store kept nothing', async () => {
    const raise = vi.fn(async () => NOT_STORED);
    const one = announcer(raise);
    await one.announce('remote_a', 'Night shift', open);
    raise.mockResolvedValue(STORED);
    await one.announce('remote_a', 'Night shift', open);
    await announcer(raise).announce('remote_a', 'Night shift', open);
    expect(raise).toHaveBeenCalledTimes(2);
    // A repeat the store already holds counts as said.
    const deduped = vi.fn(async () => ({ notification: null, deduped: true }));
    await announcer(deduped).announce('remote_b', 'Day shift', open);
    await announcer(deduped).announce('remote_b', 'Day shift', open);
    expect(deduped).toHaveBeenCalledTimes(1);
  });

  it('never throws when the raise does', async () => {
    const raise = vi.fn(async (): Promise<typeof STORED> => {
      throw new Error('unexpected');
    });
    await expect(announcer(raise).announce('remote_a', 'Night shift', open)).resolves.toBe(
      undefined
    );
  });

  it('keeps the ledger bounded', async () => {
    const raise = vi.fn(async () => STORED);
    const one = announcer(raise);
    for (let index = 0; index < 205; index += 1)
      await one.announce('remote_a', 'Night shift', { ...open, replacementId: `r-${index}` });
    const ledger = JSON.parse(await readFile(join(home, OWNER_NOTICE_LEDGER_FILE), 'utf-8'));
    expect(ledger).toHaveLength(200);
    expect(ledger.at(-1)).toBe('owner-replacement:remote_a:r-204:open');
  });
});
