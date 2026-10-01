/**
 * The owner-replacement timeline, its notices, and everything that ends a request
 * (specs/community-owner-replacement, task 2.3: AC-4, AC-9 host and owner-action half, AC-11
 * timeline half, AC-13 for these transitions, AC-15, AC-16, AC-19 token half). Real
 * PostgreSQL through the tenancy harness and an in-process SMTP fake; no test sends real mail.
 *
 * One clock drives the request routes, the mail worker, and the timeline, and it only moves
 * forward, so a test never sees another test's due work go backwards. Every test works in its
 * own community and reads only its own owner's mail.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommunityAdminOwnerReplacementCreateResponseSchema } from '@dorkos/shared/community-admin-wire';
import { queueNotice } from '../mail/outbox.js';
import { createSmtpTransport, type SmtpTimeouts } from '../mail/transport.js';
import { deliverNextNotice, type NoticeAttempt, type NoticeComposers } from '../mail/worker.js';
import { endOwnerReplacement } from '../owner-replacement/end.js';
import { ownerReplacementComposers } from '../owner-replacement/notices.js';
import { formatReplacementDate } from '../owner-replacement/dates.js';
import { mintObjectToken, objectWithToken } from '../owner-replacement/object-tokens.js';
import { advanceOwnerReplacements } from '../owner-replacement/worker.js';
import { hashSecret } from '../security.js';
import { startSmtpFake, type SmtpFake } from './smtp-fake.js';
import {
  TENANCY_PASSWORD,
  admit,
  bootstrapHost,
  claimAsNewAccount,
  createPendingCommunity,
  expectStatus,
  holdingLock,
  startTenancyHarness,
  waitForBlockedBy,
  type TenancyHarness,
} from './tenancy-test-harness.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const N_DAYS = 14;
const U_DAYS = 30;
const FAST: SmtpTimeouts = { connectionMs: 2_000, greetingMs: 2_000, socketMs: 500 };
const PUBLIC_URL = 'http://localhost:6481';
const SETTINGS = {
  publicUrl: PUBLIC_URL,
  ownerReplacement: { noticeDays: N_DAYS, unreachableDays: U_DAYS, objectionCooldownDays: 90 },
};
const COMPOSERS = ownerReplacementComposers(SETTINGS);
const REFERENCE = 'CASE-7731';
const DAY_NAME =
  /(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{1,2} [A-Z][a-z]+ \d{4} \(UTC\)/u;

let h: TenancyHarness;
/** A host whose worker can write every notice but the claim-reissued one. */
let partial: TenancyHarness;
/** A host with every composer, as main.ts has, but owner replacements not yet switched on. */
let closed: TenancyHarness;
let closedOperator = '';
let closedOwnership = '';
let smtp: SmtpFake;
let clockMs = Date.now();
const clock = () => new Date(clockMs);
let operator = '';
let partialOperator = '';
let ownership = '';
let partialOwnership = '';
let counter = 0;

interface Owned {
  communityId: string;
  name: string;
  ownerCookie: string;
  ownerMemberId: string;
  ownerUserId: string;
  ownerEmail: string;
}

/** Move the one clock forward. */
function advance(ms: number): Date {
  clockMs += ms;
  return clock();
}

async function ownedCommunity(
  harness = h,
  cookie = operator,
  options: { verified?: boolean } = {}
): Promise<Owned> {
  const n = ++counter;
  const name = `Timeline Community ${n}`;
  const { communityId, token } = await createPendingCommunity(harness, cookie, name);
  const ownerEmail = `owner-${n}-${randomUUID()}@owner.test`;
  const owner = await claimAsNewAccount(harness, token, `Timeline Owner ${n}`, ownerEmail);
  const user = await harness.pool.query<{ user_id: string }>(
    'SELECT user_id FROM members WHERE id=$1',
    [owner.memberId]
  );
  // A sign-in service can mark an address verified; the Community never does it itself.
  await harness.pool.query('UPDATE "user" SET "emailVerified"=$2 WHERE id=$1', [
    user.rows[0].user_id,
    options.verified ?? true,
  ]);
  return {
    communityId,
    name,
    ownerCookie: owner.cookie,
    ownerMemberId: owner.memberId,
    ownerUserId: user.rows[0].user_id,
    ownerEmail,
  };
}

async function lifecycleVersion(communityId: string, harness = h): Promise<number> {
  return (
    await harness.pool.query<{ lifecycle_version: number }>(
      'SELECT lifecycle_version FROM communities WHERE id=$1',
      [communityId]
    )
  ).rows[0].lifecycle_version;
}

async function requestReplacement(
  c: Owned,
  overrides: Record<string, unknown> = {},
  harness = h,
  bearer = ownership
) {
  const response = await harness.call(
    `/api/v1/host/communities/${c.communityId}/owner-replacements`,
    {
      bearer,
      body: {
        idempotencyKey: `timeline-${++counter}`,
        lifecycleVersion: await lifecycleVersion(c.communityId, harness),
        reason: 'owner_unreachable',
        reference: REFERENCE,
        claimant: { oidcSubject: null },
        ...overrides,
      },
    }
  );
  await expectStatus(response, 201, 'request replacement');
  return CommunityAdminOwnerReplacementCreateResponseSchema.parse(await response.json());
}

/** Send every due message at `at`, through the fake, with the real composers. */
async function send(at: Date, composers: NoticeComposers = COMPOSERS): Promise<NoticeAttempt[]> {
  const transport = createSmtpTransport(smtp.mail, FAST);
  const attempts: NoticeAttempt[] = [];
  for (;;) {
    const attempt = await deliverNextNotice({ pool: h.pool, transport, composers, now: () => at });
    if (!attempt) return attempts;
    attempts.push(attempt);
  }
}

function tick(at: Date) {
  return advanceOwnerReplacements({ pool: h.pool, config: SETTINGS, now: at });
}

async function row(id: string) {
  return (
    await h.pool.query<Record<string, unknown>>('SELECT * FROM owner_replacements WHERE id=$1', [
      id,
    ])
  ).rows[0];
}

/** One delivered message, decoded. */
interface Mail {
  subject: string;
  text: string;
  raw: string;
}

function decode(raw: string): Mail {
  const split = raw.indexOf('\r\n\r\n');
  const headers = raw.slice(0, split);
  let body = raw.slice(split + 4);
  if (/^Content-Transfer-Encoding: quoted-printable$/imu.test(headers)) {
    const bytes = body
      .replace(/=\r\n/gu, '')
      .replace(/=([0-9A-F]{2})/gu, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    body = Buffer.from(bytes, 'latin1').toString('utf8');
  }
  return {
    subject: /^Subject: (.*)$/mu.exec(headers)?.[1] ?? '',
    text: body.replace(/\r\n/gu, '\n'),
    raw,
  };
}

function mailsTo(email: string): Mail[] {
  return smtp.received
    .filter((message) => message.recipients.includes(email))
    .map((message) => decode(message.raw));
}

/** The date an owner-replacement email names, as written in it. */
function dateIn(text: string): string | null {
  return (
    /(?:on or after|is still) ((?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), [^.]*\(UTC\))\./u.exec(
      text
    )?.[1] ?? null
  );
}

function objectToken(mail: Mail): string | null {
  return /\/keep-ownership#([A-Za-z0-9_-]+)/u.exec(mail.text)?.[1] ?? null;
}

async function queued(id: string) {
  return (
    await h.pool.query<{ kind: string; state: string }>(
      'SELECT kind,state FROM notice_outbox WHERE subject_id=$1 ORDER BY created_at,kind',
      [id]
    )
  ).rows.map((message) => message.kind);
}

async function hostAudits(communityId: string) {
  return (
    await h.pool.query<{ action: string; actor_kind: string }>(
      `SELECT action,actor_kind FROM host_audit_events
       WHERE community_id=$1 AND action LIKE 'owner_replacement%' ORDER BY created_at,id`,
      [communityId]
    )
  ).rows;
}

async function tenantAudits(communityId: string) {
  return (
    await h.pool.query<{
      action: string;
      actor_kind: string;
      actor_member_id: string | null;
      changed_fields: string[];
    }>(
      `SELECT action,actor_kind,actor_member_id,changed_fields FROM audit_events
       WHERE community_id=$1 AND action LIKE 'owner.replacement.%' ORDER BY created_at,id`,
      [communityId]
    )
  ).rows;
}

/** Put an open replacement straight into `waiting` or `claimable`, as the timeline would. */
async function moveTo(id: string, state: 'notifying' | 'waiting' | 'claimable') {
  if (state === 'notifying') return;
  const at = clock();
  await h.pool.query(
    `UPDATE owner_replacements SET state=$2,notice_state='accepted',notice_resolved_at=$3,
       verified_address=true,claimable_after=$4,claim_expires_at=$5 WHERE id=$1`,
    state === 'waiting'
      ? [id, state, new Date(at.getTime() - DAY), new Date(at.getTime() + 13 * DAY), null]
      : [
          id,
          state,
          new Date(at.getTime() - 15 * DAY),
          new Date(at.getTime() - DAY),
          new Date(at.getTime() + 13 * DAY),
        ]
  );
}

beforeAll(async () => {
  smtp = await startSmtpFake();
  // Mail is set up (the address is never dialled: tests send through the fake themselves), and
  // the app is given the real composers, as main.ts gives it the worker's set.
  const env = {
    COMMUNITY_SMTP_URL: 'smtp://127.0.0.1:2525',
    COMMUNITY_MAIL_FROM: 'notices@community.test',
    COMMUNITY_PUBLIC_URL: PUBLIC_URL,
  };
  h = await startTenancyHarness('owner_timeline', {
    now: clock,
    env,
    noticeComposers: COMPOSERS,
    ownerReplacementOpen: true,
  });
  closed = await startTenancyHarness('owner_timeline_closed', { env, noticeComposers: COMPOSERS });
  const { 'owner_replacement.claim_reissued': _missing, ...withoutReissue } = COMPOSERS;
  partial = await startTenancyHarness('owner_timeline_partial', {
    env,
    noticeComposers: withoutReissue,
    ownerReplacementOpen: true,
  });
  operator = (await bootstrapHost(h, 'Tia Host', 'tia@host.test')).cookie;
  partialOperator = (await bootstrapHost(partial, 'Pat Host', 'pat@host.test')).cookie;
  closedOperator = (await bootstrapHost(closed, 'Cy Host', 'cy@host.test')).cookie;
  const issue = async (harness: TenancyHarness, cookie: string) => {
    const issued = await harness.call('/api/v1/host/api-keys', {
      cookie,
      body: {
        label: `Ownership ${++counter}`,
        scopes: ['communities:ownership'],
        expiresInDays: null,
        password: TENANCY_PASSWORD,
      },
    });
    await expectStatus(issued, 201, 'issue key');
    return ((await issued.json()) as { secret: string }).secret;
  };
  ownership = await issue(h, operator);
  partialOwnership = await issue(partial, partialOperator);
  closedOwnership = await issue(closed, closedOperator);
}, 120_000);

afterAll(async () => {
  await h?.close();
  await partial?.close();
  await closed?.close();
  await smtp?.close();
});

describe('which wait applies (AC-4)', () => {
  async function waitFor(options: {
    verified?: boolean;
    reason?: string;
    behaviour?: SmtpFake['behaviour'];
    prepare?: (c: Owned) => Promise<void>;
  }) {
    const c = await ownedCommunity(h, operator, { verified: options.verified });
    await options.prepare?.(c);
    const created = await requestReplacement(c, options.reason ? { reason: options.reason } : {});
    const id = created.replacement.replacementId;
    smtp.behaviour = options.behaviour ?? 'accept';
    // The mail server answers an hour after the request: the wait counts from then.
    const answered = advance(HOUR);
    await send(answered);
    smtp.behaviour = 'accept';
    await tick(answered);
    return { c, id, answered, stored: await row(id) };
  }

  const expectWait = (stored: Record<string, unknown>, from: Date, days: number) =>
    expect((stored.claimable_after as Date).getTime()).toBe(from.getTime() + days * DAY);

  it('gives the short wait, from acceptance, only to accepted mail at a verified address', async () => {
    // Purpose: fails if the wait counts from the request instead of the acceptance, or if a
    // verified, accepted notice for an unreachable owner gets anything but N.
    const { stored, answered } = await waitFor({});
    expect(stored).toMatchObject({
      state: 'waiting',
      notice_state: 'accepted',
      verified_address: true,
    });
    expect(stored.notice_resolved_at).toEqual(answered);
    expectWait(stored, answered, N_DAYS);
  });

  it('gives the long wait to an address no sign-in service verified', async () => {
    // Purpose: fails if a password account, whose address was never confirmed, gets N.
    const { stored, answered } = await waitFor({ verified: false });
    expect(stored).toMatchObject({ notice_state: 'accepted', verified_address: false });
    expectWait(stored, answered, U_DAYS);
  });

  it('gives the long wait at once when the mail server refuses the address', async () => {
    // Purpose: fails if a 550 is retried or waits anything but U.
    const { stored, answered } = await waitFor({ behaviour: 'reject-recipient' });
    expect(stored).toMatchObject({ state: 'waiting', notice_state: 'failed' });
    expectWait(stored, answered, U_DAYS);
  });

  it('gives the long wait after 72 hours of a busy mail server', async () => {
    // Purpose: fails if a deferred notice resolves early, or resolves to anything but U.
    const c = await ownedCommunity();
    const created = await requestReplacement(c);
    const id = created.replacement.replacementId;
    const requested = clock();
    smtp.behaviour = 'defer-recipient';
    await send(advance(MINUTE));
    await tick(clock());
    expect(await row(id)).toMatchObject({ state: 'notifying', notice_state: 'pending' });
    const gaveUp = new Date(requested.getTime() + 72 * HOUR + MINUTE);
    clockMs = gaveUp.getTime();
    await send(gaveUp);
    smtp.behaviour = 'accept';
    await tick(gaveUp);
    const stored = await row(id);
    expect(stored).toMatchObject({ state: 'waiting', notice_state: 'failed' });
    expectWait(stored, gaveUp, U_DAYS);
  });

  it('gives the long wait to a request after an objection, even to a verified accepted address', async () => {
    // Purpose: fails if an owner who already said no gets the short wait next time.
    const { stored, answered } = await waitFor({
      prepare: async (c) => {
        const first = await requestReplacement(c);
        const client = await h.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('SELECT 1 FROM communities WHERE id=$1 FOR UPDATE', [c.communityId]);
          await endOwnerReplacement(client, {
            communityId: c.communityId,
            ending: { state: 'objected', viaLink: true },
            now: clock(),
          });
          await client.query('COMMIT');
        } finally {
          client.release();
        }
        await h.pool.query('UPDATE owner_replacements SET ended_at=$2 WHERE id=$1', [
          first.replacement.replacementId,
          new Date(clockMs - 91 * DAY),
        ]);
      },
    });
    expect(stored).toMatchObject({ after_objection: true, verified_address: true });
    expectWait(stored, answered, U_DAYS);
  });

  it.each([
    [29, U_DAYS],
    [31, N_DAYS],
  ])('after a withdrawal %i days before, gives a %i-day wait', async (daysBefore, expected) => {
    // Purpose: fails if cancel-and-ask-again dodges the long wait, or an old withdrawal
    // lengthens every later wait forever.
    const { stored, answered } = await waitFor({
      prepare: async (c) => {
        const first = await requestReplacement(c);
        await expectStatus(
          await h.call(
            `/api/v1/host/communities/${c.communityId}/owner-replacements/${first.replacement.replacementId}/cancel`,
            { bearer: ownership, body: {} }
          ),
          200,
          'cancel'
        );
        await h.pool.query('UPDATE owner_replacements SET ended_at=$2 WHERE id=$1', [
          first.replacement.replacementId,
          new Date(clockMs - daysBefore * DAY),
        ]);
      },
    });
    expectWait(stored, answered, expected);
  });

  it('gives the long wait to every request saying the owner left the group', async () => {
    // Purpose: fails if `owner_left_group`, the owner most likely to have a dead address, gets N.
    const { stored, answered } = await waitFor({ reason: 'owner_left_group' });
    expect(stored).toMatchObject({ notice_state: 'accepted', verified_address: true });
    expectWait(stored, answered, U_DAYS);
  });
});

describe('the reminder, the claim window, and expiry (AC-16)', () => {
  it('reminds once 48 hours before, opens the claim, and expires it, telling the owner', async () => {
    // Purpose: fails if the reminder is early, repeated, or moves the date; if the claim opens
    // at the wrong time or writes an audit row; or if an expiry leaves a live token or is not
    // told to the owner.
    const c = await ownedCommunity();
    const created = await requestReplacement(c);
    const id = created.replacement.replacementId;
    const accepted = advance(MINUTE);
    await send(accepted);
    await tick(accepted);
    const claimableAfter = (await row(id)).claimable_after as Date;
    expect(claimableAfter.getTime()).toBe(accepted.getTime() + N_DAYS * DAY);
    const auditsBefore = [await hostAudits(c.communityId), await tenantAudits(c.communityId)];

    clockMs = claimableAfter.getTime() - 48 * HOUR - MINUTE;
    await tick(clock());
    expect(await queued(id)).toEqual(['owner_replacement.notice']);

    clockMs = claimableAfter.getTime() - 48 * HOUR;
    await tick(clock());
    await tick(advance(HOUR));
    expect(await queued(id)).toEqual(['owner_replacement.notice', 'owner_replacement.reminder']);
    expect(await row(id)).toMatchObject({ state: 'waiting', claimable_after: claimableAfter });
    await send(clock());
    const reminder = mailsTo(c.ownerEmail)[1];
    expect(reminder.text).toContain('If you do nothing, that can happen in 2 days, on or after');

    clockMs = claimableAfter.getTime() - MINUTE;
    await tick(clock());
    expect((await row(id)).state).toBe('waiting');
    clockMs = claimableAfter.getTime();
    await tick(clock());
    const open = await row(id);
    expect(open).toMatchObject({ state: 'claimable', claimable_after: claimableAfter });
    expect((open.claim_expires_at as Date).getTime()).toBe(claimableAfter.getTime() + 14 * DAY);
    expect([await hostAudits(c.communityId), await tenantAudits(c.communityId)]).toEqual(
      auditsBefore
    );

    const liveToken = objectToken(reminder)!;
    clockMs = (open.claim_expires_at as Date).getTime() - MINUTE;
    await tick(clock());
    expect((await row(id)).state).toBe('claimable');
    clockMs = (open.claim_expires_at as Date).getTime();
    await tick(clock());
    expect(await row(id)).toMatchObject({ state: 'expired', claim_token_hash: null });
    expect(await objectWithToken(h.pool, liveToken, clock())).toEqual({ outcome: 'ended' });
    expect(await hostAudits(c.communityId)).toEqual([
      { action: 'owner_replacement.request', actor_kind: 'api_key' },
      { action: 'owner_replacement.expired', actor_kind: 'system' },
    ]);
    expect((await tenantAudits(c.communityId)).at(-1)).toMatchObject({
      action: 'owner.replacement.expired',
      actor_kind: 'system',
      actor_member_id: null,
    });
    await send(clock());
    const ended = mailsTo(c.ownerEmail).at(-1)!;
    expect(ended.text).toContain('The request expired. Nothing changed.');
  });

  it('does nothing when an objection wins the race for the community lock', async () => {
    // Purpose: fails if a transition trusts the row it found due instead of re-reading it under
    // the community lock, and so reopens or moves a request the owner just ended.
    const c = await ownedCommunity();
    const created = await requestReplacement(c);
    const id = created.replacement.replacementId;
    await moveTo(id, 'waiting');
    await h.pool.query('UPDATE owner_replacements SET claimable_after=$2 WHERE id=$1', [
      id,
      new Date(clockMs - MINUTE),
    ]);
    const moved = await holdingLock(
      h,
      'SELECT 1 FROM communities WHERE id=$1 FOR UPDATE',
      [c.communityId],
      async (release, holderPid) => {
        const ticking = tick(clock());
        await waitForBlockedBy(h, holderPid, 1);
        // The owner keeps ownership while the timeline waits on the community.
        const ender = await h.pool.connect();
        try {
          await ender.query('BEGIN');
          await ender.query(
            "UPDATE owner_replacements SET state='objected',ended_at=$2,claim_token_hash=NULL WHERE id=$1",
            [id, clock()]
          );
          await release();
          await ender.query('COMMIT');
        } finally {
          ender.release();
        }
        return ticking;
      }
    );
    expect(moved.claimable).toBe(0);
    expect(await row(id)).toMatchObject({ state: 'objected', claim_expires_at: null });
  });
});

describe('everything that ends an open request (AC-9, AC-13)', () => {
  type Ender = {
    name: string;
    prepare?: (c: Owned) => Promise<void>;
    act: (c: Owned, id: string) => Promise<Response>;
    status: number;
    expect: {
      state: string;
      cause: string | null;
      host: { action: string; actor_kind: string };
      tenant: { action: string; actor_kind: string; owner: boolean };
      told: boolean;
    };
  };
  const hold = async (c: Owned) => {
    await expectStatus(
      await h.call(`/api/v1/host/communities/${c.communityId}/lifecycle`, {
        method: 'PATCH',
        cookie: operator,
        body: {
          action: 'hold',
          lifecycleVersion: await lifecycleVersion(c.communityId),
          deletionNoticeAt: new Date(clockMs + 15 * DAY).toISOString(),
        },
      }),
      200,
      'hold'
    );
  };
  const enders: Ender[] = [
    {
      name: 'the host cancels',
      act: (c, id) =>
        h.call(`/api/v1/host/communities/${c.communityId}/owner-replacements/${id}/cancel`, {
          bearer: ownership,
          body: {},
        }),
      status: 200,
      expect: {
        state: 'withdrawn',
        cause: 'cancelled',
        host: { action: 'owner_replacement.cancel', actor_kind: 'api_key' },
        tenant: { action: 'owner.replacement.withdrawn', actor_kind: 'host', owner: false },
        told: true,
      },
    },
    {
      name: 'the owner hands the community on',
      act: async (c) => {
        const successor = await admit(h, c.communityId, c.ownerCookie, {
          name: `Successor ${++counter}`,
          email: `successor-${randomUUID()}@owner.test`,
        });
        return h.call(`/api/v1/communities/${c.communityId}/owner/transfer`, {
          cookie: c.ownerCookie,
          body: {
            successorMemberId: successor.memberId,
            password: TENANCY_PASSWORD,
            lifecycleVersion: await lifecycleVersion(c.communityId),
          },
        });
      },
      status: 200,
      expect: {
        state: 'superseded',
        cause: null,
        host: { action: 'owner_replacement.superseded', actor_kind: 'system' },
        tenant: { action: 'owner.replacement.superseded', actor_kind: 'member', owner: true },
        told: false,
      },
    },
    {
      name: 'the owner asks to delete the community',
      act: async (c) =>
        h.call(`/api/v1/communities/${c.communityId}/owner/deletion`, {
          cookie: c.ownerCookie,
          body: {
            lifecycleVersion: await lifecycleVersion(c.communityId),
            password: TENANCY_PASSWORD,
            confirmName: c.name,
            confirmIdSuffix: c.communityId.slice(-8),
          },
        }),
      status: 200,
      expect: {
        state: 'superseded',
        cause: null,
        host: { action: 'owner_replacement.superseded', actor_kind: 'system' },
        tenant: { action: 'owner.replacement.superseded', actor_kind: 'member', owner: true },
        told: false,
      },
    },
    {
      name: 'the host suspends the community',
      act: async (c) =>
        h.call(`/api/v1/host/communities/${c.communityId}/lifecycle`, {
          method: 'PATCH',
          cookie: operator,
          body: { action: 'suspend', lifecycleVersion: await lifecycleVersion(c.communityId) },
        }),
      status: 200,
      expect: {
        state: 'withdrawn',
        cause: 'suspended',
        host: { action: 'owner_replacement.withdrawn', actor_kind: 'system' },
        tenant: { action: 'owner.replacement.withdrawn', actor_kind: 'host', owner: false },
        told: true,
      },
    },
    {
      name: 'the host deletes the held community',
      prepare: hold,
      act: async (c) => {
        await h.pool.query('UPDATE communities SET deletion_notice_at=$2 WHERE id=$1', [
          c.communityId,
          new Date(clockMs - MINUTE),
        ]);
        return h.call(`/api/v1/host/communities/${c.communityId}/deletion`, {
          cookie: operator,
          body: {
            lifecycleVersion: await lifecycleVersion(c.communityId),
            confirmIdSuffix: c.communityId.slice(-8),
          },
        });
      },
      status: 200,
      expect: {
        state: 'withdrawn',
        cause: 'deletion',
        host: { action: 'owner_replacement.withdrawn', actor_kind: 'system' },
        tenant: { action: 'owner.replacement.withdrawn', actor_kind: 'host', owner: false },
        told: true,
      },
    },
    {
      name: 'the host takes the whole community down, without telling the owner',
      act: async (c) =>
        h.call(`/api/v1/host/communities/${c.communityId}/takedowns`, {
          cookie: operator,
          body: {
            idempotencyKey: `takedown-${++counter}`,
            target: {
              kind: 'community',
              lifecycleVersion: await lifecycleVersion(c.communityId),
              confirmIdSuffix: c.communityId.slice(-8),
            },
            category: 'legal_order',
            reference: null,
            notify: false,
            password: TENANCY_PASSWORD,
          },
        }),
      status: 201,
      expect: {
        state: 'withdrawn',
        cause: 'deletion',
        host: { action: 'owner_replacement.withdrawn', actor_kind: 'system' },
        tenant: { action: 'owner.replacement.withdrawn', actor_kind: 'host', owner: false },
        told: false,
      },
    },
  ];

  const cases = enders.flatMap((ender) =>
    (['notifying', 'waiting', 'claimable'] as const).map((state) => ({ ender, state }))
  );

  it.each(cases.map((entry) => [entry.ender.name, entry.state, entry] as const))(
    '%s, in %s',
    async (_name, _state, { ender, state }) => {
      // Purpose: fails if any of these leaves the request open, a claim token or object-only
      // link alive, writes the wrong audit row or actor, or tells (or fails to tell) the owner.
      const c = await ownedCommunity();
      await ender.prepare?.(c);
      const created = await requestReplacement(c);
      const id = created.replacement.replacementId;
      await moveTo(id, state);
      const link = await mintObjectToken(h.pool, {
        communityId: c.communityId,
        replacementId: id,
        outboxId: randomUUID(),
        publicUrl: PUBLIC_URL,
        now: clock(),
      });
      await expectStatus(await ender.act(c, id), ender.status, ender.name);
      const ended = await row(id);
      expect(ended).toMatchObject({
        state: ender.expect.state,
        withdrawn_cause: ender.expect.cause,
        claim_token_hash: null,
        claimant_oidc_issuer: null,
        claimant_oidc_subject: null,
      });
      expect(ended.ended_at).toBeInstanceOf(Date);
      expect(await objectWithToken(h.pool, link.split('#')[1], clock())).toEqual({
        outcome: 'ended',
      });
      expect(await hostAudits(c.communityId)).toEqual([
        { action: 'owner_replacement.request', actor_kind: 'api_key' },
        ender.expect.host,
      ]);
      const tenant = await tenantAudits(c.communityId);
      expect(tenant).toHaveLength(2);
      expect(tenant[1]).toMatchObject({
        action: ender.expect.tenant.action,
        actor_kind: ender.expect.tenant.actor_kind,
        actor_member_id: ender.expect.tenant.owner ? c.ownerMemberId : null,
      });
      expect((await queued(id)).includes('owner_replacement.ended')).toBe(ender.expect.told);
    }
  );

  it('leaves an open request alone through a hold, a release, archive, restore, limits, a web address, and a legal hold', async () => {
    // Purpose: fails if any change the spec says does not end a request (AC-11's legal hold
    // among them) closes it or touches its row.
    const c = await ownedCommunity();
    const created = await requestReplacement(c);
    const id = created.replacement.replacementId;
    await moveTo(id, 'waiting');
    const before = await row(id);
    const base = `/api/v1/host/communities/${c.communityId}`;
    const steps: [string, () => Promise<Response>][] = [
      [
        'legal hold',
        () =>
          h.call(`${base}/legal-hold`, {
            method: 'PUT',
            cookie: operator,
            body: { reference: null },
          }),
      ],
      [
        'limits',
        () =>
          h.call(`${base}/limits`, {
            method: 'PUT',
            cookie: operator,
            body: { limitsVersion: 1, maxActiveMembers: 1000, maxStorageBytes: null },
          }),
      ],
      [
        'web address',
        () =>
          h.call(`${base}/short-name`, {
            method: 'PUT',
            cookie: operator,
            body: { shortName: `timeline-${counter}-${Date.now().toString(36)}` },
          }),
      ],
      [
        'archive',
        async () =>
          h.call(`/api/v1/communities/${c.communityId}/owner/lifecycle`, {
            cookie: c.ownerCookie,
            body: {
              action: 'archive',
              lifecycleVersion: await lifecycleVersion(c.communityId),
              password: TENANCY_PASSWORD,
              confirmName: c.name,
            },
          }),
      ],
      [
        'restore',
        async () =>
          h.call(`/api/v1/communities/${c.communityId}/owner/lifecycle`, {
            cookie: c.ownerCookie,
            body: {
              action: 'restore',
              lifecycleVersion: await lifecycleVersion(c.communityId),
              password: TENANCY_PASSWORD,
            },
          }),
      ],
      [
        'hold',
        async () =>
          h.call(`${base}/lifecycle`, {
            method: 'PATCH',
            cookie: operator,
            body: {
              action: 'hold',
              lifecycleVersion: await lifecycleVersion(c.communityId),
              deletionNoticeAt: null,
            },
          }),
      ],
      [
        'release',
        async () =>
          h.call(`${base}/lifecycle`, {
            method: 'PATCH',
            cookie: operator,
            body: { action: 'release', lifecycleVersion: await lifecycleVersion(c.communityId) },
          }),
      ],
    ];
    for (const [label, step] of steps) {
      await expectStatus(await step(), 200, label);
      expect(await row(id), label).toEqual(before);
    }
    // Under the legal hold, the timeline still runs as it would without one.
    clockMs = (before.claimable_after as Date).getTime();
    await tick(clock());
    expect((await row(id)).state).toBe('claimable');
  });
});

describe('what the owner is sent (AC-15)', () => {
  const sentences = {
    transfer:
      'If you can sign in, you can also hand the community to someone yourself from its Settings:',
    delete: 'If you can sign in, you can also delete the community from its Settings.',
    password: 'To hand it to someone or delete it, add a password to your account first.',
    deletePassword: 'To delete it, add a password to your account first.',
  };

  function expectPlain(mail: Mail, c: Owned) {
    expect(mail.raw).toMatch(/^Content-Type: text\/plain/mu);
    expect(mail.raw).not.toMatch(/text\/html|multipart|<img|<a /iu);
    // Named in the subject line or the text.
    expect(`${mail.subject}\n${mail.text}`).toContain(c.name);
    expect(mail.text).toContain(`${PUBLIC_URL}/c/${c.communityId}`);
    for (const forbidden of [
      REFERENCE,
      'owner_unreachable',
      'owner_left_group',
      "couldn't reach you",
      'legal',
      '/owner-replacement#',
    ])
      expect(mail.text.toLowerCase()).not.toContain(forbidden.toLowerCase());
  }

  it('sends the notice, the reminder, and the reissue each with its own live link, and no claim token', async () => {
    // Purpose: fails if a message carries the claim token, the reason or reference, a date
    // without its day, or reuses one object-only link; or if a token is stored in the clear.
    const c = await ownedCommunity();
    const created = await requestReplacement(c);
    const id = created.replacement.replacementId;
    await send(advance(MINUTE));
    await tick(clock());
    const reissued = await h.call(
      `/api/v1/host/communities/${c.communityId}/owner-replacements/${id}/claim-token`,
      { bearer: ownership, body: {} }
    );
    await expectStatus(reissued, 200, 'reissue');
    const newClaimToken = ((await reissued.json()) as { claimToken: string }).claimToken;
    await send(clock());
    clockMs = ((await row(id)).claimable_after as Date).getTime() - 47 * HOUR;
    await tick(clock());
    await send(clock());

    const [notice, again, reminder] = mailsTo(c.ownerEmail);
    expect(notice.subject).toBe(`Someone asked to take over ${c.name}`);
    expect(notice.text).toContain(
      `The host of ${c.name} has been asked to make someone else its owner.`
    );
    expect(notice.text).toMatch(
      new RegExp(`If you do nothing, that can happen on or after ${DAY_NAME.source}\\.`, 'u')
    );
    expect(notice.text).toContain(
      "To keep ownership, open this link and press Keep ownership. You don't need to sign in: "
    );
    expect(again.text).toMatch(
      new RegExp(
        `The host sent the link for the new owner again\\. Nothing else changed\\. The earliest date is still ${DAY_NAME.source}\\.`,
        'u'
      )
    );
    expect(reminder.text).toContain('If you do nothing, that can happen in 2 days, on or after');
    const tokens = [notice, again, reminder].map(objectToken);
    expect(tokens.every(Boolean)).toBe(true);
    expect(new Set(tokens).size).toBe(3);
    for (const mail of [notice, again, reminder]) {
      expectPlain(mail, c);
      expect(mail.text).not.toContain(created.claimToken!);
      expect(mail.text).not.toContain(newClaimToken);
    }
    // Stored only as hashes, one per message, all live while the request is open.
    const stored = await h.pool.query<{ token_hash: string; used_at: Date | null }>(
      'SELECT token_hash,used_at FROM owner_replacement_object_tokens WHERE replacement_id=$1',
      [id]
    );
    expect(stored.rows.map((token) => token.token_hash).sort()).toEqual(
      tokens.map((token) => hashSecret(token!)).sort()
    );
    const dump = JSON.stringify(
      (
        await h.pool.query(
          'SELECT * FROM owner_replacement_object_tokens WHERE replacement_id=$1',
          [id]
        )
      ).rows
    );
    for (const token of tokens) expect(dump).not.toContain(token!);
  });

  it.each([
    ['active', true, { transfer: true, delete: true, password: null }],
    ['archived', true, { transfer: false, delete: true, password: null }],
    ['held', true, { transfer: false, delete: true, password: null }],
    ['active', false, { transfer: false, delete: false, password: 'password' }],
    // Only an active community can be handed on, so a password would open deletion alone.
    ['held', false, { transfer: false, delete: false, password: 'deletePassword' }],
    ['archived', false, { transfer: false, delete: false, password: 'deletePassword' }],
  ] as const)(
    'offers an owner of a %s community (password: %s) only what they can do',
    async (lifecycle, hasPassword, offered) => {
      // Purpose: fails if the notice offers a transfer outside `active` or without a password,
      // a deletion without a password, leaves a password-less owner without the way forward,
      // or promises them a transfer that adding a password would not give them.
      const c = await ownedCommunity();
      if (lifecycle !== 'active')
        await h.pool.query(
          `UPDATE communities SET lifecycle=$2,
             held_from_state=CASE WHEN $2='held' THEN 'active' END,
             held_at=CASE WHEN $2='held' THEN now() END,
             archived_at=CASE WHEN $2='archived' THEN now() END WHERE id=$1`,
          [c.communityId, lifecycle]
        );
      if (!hasPassword)
        await h.pool.query(`DELETE FROM account WHERE "userId"=$1 AND "providerId"='credential'`, [
          c.ownerUserId,
        ]);
      await requestReplacement(c);
      await send(advance(MINUTE));
      const [notice] = mailsTo(c.ownerEmail);
      expectPlain(notice, c);
      expect(notice.text.includes(sentences.transfer)).toBe(offered.transfer);
      expect(notice.text.includes(sentences.delete)).toBe(offered.delete);
      expect(notice.text.includes(sentences.password)).toBe(offered.password === 'password');
      expect(notice.text.includes(sentences.deletePassword)).toBe(
        offered.password === 'deletePassword'
      );
    }
  );

  it('tells the owner a request was withdrawn, and a completed one names the new owner', async () => {
    // Purpose: fails if an ending carries a link to object, or the completion message loses the
    // new owner's name or the fact that the old owner stays a member.
    const c = await ownedCommunity();
    const withdrawn = await requestReplacement(c);
    await expectStatus(
      await h.call(
        `/api/v1/host/communities/${c.communityId}/owner-replacements/${withdrawn.replacement.replacementId}/cancel`,
        { bearer: ownership, body: {} }
      ),
      200,
      'cancel'
    );
    // A completion, as the claim (task 2.4) will record it.
    const completed = await requestReplacement(c);
    const successor = await admit(h, c.communityId, c.ownerCookie, {
      name: 'Nia New Owner',
      email: `nia-${randomUUID()}@owner.test`,
    });
    await h.pool.query(
      `UPDATE owner_replacements SET state='completed',notice_state='accepted',
         notice_resolved_at=$2,claimable_after=$2,claim_expires_at=$3,ended_at=$3,
         claim_token_hash=NULL,new_owner_member_id=$4 WHERE id=$1`,
      [completed.replacement.replacementId, clock(), advance(MINUTE), successor.memberId]
    );
    await queueNotice(
      h.pool,
      {
        communityId: c.communityId,
        kind: 'owner_replacement.completed',
        subjectId: completed.replacement.replacementId,
        recipientUserId: c.ownerUserId,
      },
      clock()
    );
    const attempts = await send(clock());
    // The withdrawn request's notice is no longer true, so it is dropped unsent.
    expect(attempts.map((attempt) => attempt.errorClass)).toContain('NOTICE_OBSOLETE');
    const mails = mailsTo(c.ownerEmail);
    const ended = mails.find((mail) => mail.text.includes('The host withdrew its request.'))!;
    expect(ended.subject).toBe(`The request to take over ${c.name} has ended`);
    expect(ended.text).toContain('The host withdrew its request. Nothing changed.');
    const done = mails.find((mail) => mail.subject === `${c.name} has a new owner`)!;
    expect(done.text).toContain(
      `Nia New Owner is now the owner of ${c.name}. You are still a member.`
    );
    for (const mail of [ended, done]) {
      expectPlain(mail, c);
      expect(objectToken(mail)).toBeNull();
    }
  });
});

describe('object-only links through a lost reply (AC-19)', () => {
  it('delivers a second link after a send times out, and both still keep ownership', async () => {
    // Purpose: fails if the token minted for a timed-out attempt is deleted (that message may
    // have arrived), if the second link does not work, or if a second use writes a second
    // audit row.
    const c = await ownedCommunity();
    // Earlier tests' messages go first, so the lost reply is this owner's.
    await send(advance(MINUTE));
    const created = await requestReplacement(c);
    const id = created.replacement.replacementId;
    smtp.behaviour = 'silent-once-after-body';
    const first = await send(advance(MINUTE));
    expect(first.map((attempt) => attempt.outcome)).toContain('retrying');
    await send(advance(10 * MINUTE));
    const [lost, delivered] = mailsTo(c.ownerEmail);
    const tokens = [objectToken(lost)!, objectToken(delivered)!];
    expect(new Set(tokens).size).toBe(2);

    expect(await objectWithToken(h.pool, tokens[0], clock())).toEqual({
      outcome: 'objected',
      communityId: c.communityId,
      replacementId: id,
    });
    expect(await objectWithToken(h.pool, tokens[1], clock())).toEqual({
      outcome: 'already_objected',
      communityId: c.communityId,
      replacementId: id,
    });
    expect(await objectWithToken(h.pool, tokens[0], clock())).toMatchObject({
      outcome: 'already_objected',
    });
    expect(await objectWithToken(h.pool, 'not-a-token', clock())).toEqual({ outcome: 'unknown' });
    expect(await row(id)).toMatchObject({ state: 'objected', claim_token_hash: null });
    expect(await hostAudits(c.communityId)).toEqual([
      { action: 'owner_replacement.request', actor_kind: 'api_key' },
      { action: 'owner_replacement.objected', actor_kind: 'system' },
    ]);
    expect((await tenantAudits(c.communityId)).slice(1)).toEqual([
      {
        action: 'owner.replacement.objected',
        actor_kind: 'system',
        actor_member_id: null,
        changed_fields: ['via_link'],
      },
    ]);
    // The owner acted, so they are not told their own answer.
    expect(await queued(id)).toEqual(['owner_replacement.notice']);
  });
});

describe('owner replacements not yet switched on', () => {
  it('refuses a request on a host with every composer until main.ts turns them on', async () => {
    // Purpose: fails if the request gate opens as soon as the notices can be written, before
    // the owner's "Keep ownership" link leads anywhere (tasks 2.4 and 3.1). The other hosts in
    // this file prove the harness can turn it on.
    const c = await ownedCommunity(closed, closedOperator);
    const refused = await closed.call(
      `/api/v1/host/communities/${c.communityId}/owner-replacements`,
      {
        bearer: closedOwnership,
        body: {
          idempotencyKey: `closed-${++counter}`,
          lifecycleVersion: await lifecycleVersion(c.communityId, closed),
          reason: 'owner_unreachable',
          reference: null,
          claimant: { oidcSubject: null },
        },
      }
    );
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      code: 'NOTICE_DELIVERY_UNAVAILABLE',
      message: "This server can't send the owner's notice yet, so it can't replace an owner.",
    });
    const written = await closed.pool.query(
      'SELECT 1 FROM owner_replacements UNION ALL SELECT 1 FROM notice_outbox'
    );
    expect(written.rowCount).toBe(0);
  });
});

describe('review probes (Q1, Q2)', () => {
  it('queues one reminder when three ticks run at once', async () => {
    // Purpose: fails if the reminder step trusts the row it found due instead of re-checking
    // `reminder_queued_at` under the community lock, so concurrent replicas each queue one.
    const c = await ownedCommunity();
    const created = await requestReplacement(c);
    const id = created.replacement.replacementId;
    const accepted = advance(MINUTE);
    await send(accepted);
    await tick(accepted);
    const claimableAfter = (await row(id)).claimable_after as Date;
    clockMs = claimableAfter.getTime() - 47 * HOUR;
    await Promise.all([tick(clock()), tick(clock()), tick(clock())]);
    expect(await queued(id)).toEqual(['owner_replacement.notice', 'owner_replacement.reminder']);
  });

  it('tells the owner, in the notice, exactly the date that is then stored', async () => {
    // Purpose: fails if the notice promises a date later than the stored one (the new owner
    // could then take over before the date the owner was told) or earlier by a day or more.
    const c = await ownedCommunity();
    const created = await requestReplacement(c);
    const id = created.replacement.replacementId;
    const sentAt = advance(HOUR);
    await send(sentAt);
    await tick(sentAt);
    const stored = (await row(id)).claimable_after as Date;
    const [notice] = mailsTo(c.ownerEmail);
    expect(notice.text).toContain(`on or after ${formatReplacementDate(stored)}.`);
  });
});

describe('a promise the settings cannot take back', () => {
  it('keeps the date the notice promised when the host lowers the wait before the answer', async () => {
    // Purpose: fails if the stored date is counted only from the settings in force when the
    // mail server answered, so lowering them after the notice was written lets the new owner
    // take over before the date the owner was told.
    const c = await ownedCommunity();
    const created = await requestReplacement(c);
    const id = created.replacement.replacementId;
    const sentAt = advance(HOUR);
    await send(sentAt);
    const promised = (await row(id)).notice_promised_at as Date;
    expect(promised.getTime()).toBe(sentAt.getTime() + N_DAYS * DAY);
    // The host lowers the short wait to 7 days before the timeline resolves the notice.
    await advanceOwnerReplacements({
      pool: h.pool,
      config: { ownerReplacement: { ...SETTINGS.ownerReplacement, noticeDays: 7 } },
      now: sentAt,
    });
    const stored = await row(id);
    expect(stored.state).toBe('waiting');
    expect(stored.claimable_after).toEqual(promised);
    const [notice] = mailsTo(c.ownerEmail);
    expect(notice.text).toContain(`on or after ${formatReplacementDate(promised)}.`);
  });

  it('uses the longer counted date when the settings were raised instead', async () => {
    // Purpose: fails if the promise replaces the counted date rather than bounding it.
    const c = await ownedCommunity();
    const created = await requestReplacement(c);
    const id = created.replacement.replacementId;
    const sentAt = advance(HOUR);
    await send(sentAt);
    await advanceOwnerReplacements({
      pool: h.pool,
      config: { ownerReplacement: { ...SETTINGS.ownerReplacement, noticeDays: 20 } },
      now: sentAt,
    });
    expect(((await row(id)).claimable_after as Date).getTime()).toBe(sentAt.getTime() + 20 * DAY);
  });
});

describe('review probes (R1, R2)', () => {
  it('repeats the promised date when the claim link is sent again before the notice resolves', async () => {
    // Purpose: fails if a claim-reissued email written while the request is still `notifying`
    // counts a fresh date from its own send time, so it can name a later day than the one
    // stored (review probe R1: accepted at 23:30 UTC, reissued at 00:30 the next day).
    const c = await ownedCommunity();
    // Put the clock at 23:30 UTC, so an hour later is the next calendar day.
    const late = new Date(clockMs + 2 * DAY);
    late.setUTCHours(23, 30, 0, 0);
    clockMs = late.getTime();
    const created = await requestReplacement(c);
    const id = created.replacement.replacementId;
    await send(clock());
    // The timeline has not ticked yet: the request is still notifying.
    advance(HOUR);
    await expectStatus(
      await h.call(
        `/api/v1/host/communities/${c.communityId}/owner-replacements/${id}/claim-token`,
        {
          bearer: ownership,
          body: {},
        }
      ),
      200,
      'reissue'
    );
    await send(clock());
    await tick(clock());
    const stored = (await row(id)).claimable_after as Date;
    const [notice, again] = mailsTo(c.ownerEmail);
    expect(again.text).toContain('The host sent the link for the new owner again.');
    expect(again.text).toContain(`The earliest date is still ${formatReplacementDate(stored)}.`);
    // Both emails name one date: the reissue repeats the notice's, not a day counted from now.
    expect(dateIn(notice.text)).toBe(formatReplacementDate(stored));
    expect(dateIn(again.text)).toBe(dateIn(notice.text));
  });

  it('keeps the longer date a lost first send promised after the address is confirmed', async () => {
    // Purpose: fails if a retried notice replaces the promise instead of raising it, so a first
    // send that reached the owner (reply lost, long wait for an unconfirmed address) is undercut
    // once a sign-in service confirms the address and the retry counts the short wait (R2).
    await send(advance(MINUTE));
    const c = await ownedCommunity(h, operator, { verified: false });
    const created = await requestReplacement(c);
    const id = created.replacement.replacementId;
    smtp.behaviour = 'silent-once-after-body';
    await send(advance(MINUTE));
    const [first] = mailsTo(c.ownerEmail);
    await h.pool.query('UPDATE "user" SET "emailVerified"=true WHERE id=$1', [c.ownerUserId]);
    await send(advance(10 * MINUTE));
    await tick(clock());
    const stored = (await row(id)).claimable_after as Date;
    expect(mailsTo(c.ownerEmail)).toHaveLength(2);
    expect(first.text).toContain(`on or after ${formatReplacementDate(stored)}.`);
  });
});

describe('one date in every email (R3, R4)', () => {
  it('names the long date a claim link promised first, after the address is confirmed', async () => {
    // Purpose: fails if the notice names its own short date when a claim link sent before it,
    // while the address was unconfirmed, already promised the long one (review probe R3).
    await send(advance(MINUTE));
    const c = await ownedCommunity(h, operator, { verified: false });
    const created = await requestReplacement(c);
    const id = created.replacement.replacementId;
    await expectStatus(
      await h.call(
        `/api/v1/host/communities/${c.communityId}/owner-replacements/${id}/claim-token`,
        {
          bearer: ownership,
          body: {},
        }
      ),
      200,
      'reissue'
    );
    // The claim link's email goes first: the notice waits two hours.
    await h.pool.query(
      `UPDATE notice_outbox SET next_attempt_at=$2
       WHERE subject_id=$1 AND kind='owner_replacement.notice'`,
      [id, new Date(clockMs + 2 * HOUR)]
    );
    await send(advance(MINUTE));
    await h.pool.query('UPDATE "user" SET "emailVerified"=true WHERE id=$1', [c.ownerUserId]);
    await send(advance(3 * HOUR));
    await tick(clock());
    const stored = (await row(id)).claimable_after as Date;
    const mails = mailsTo(c.ownerEmail);
    expect(mails).toHaveLength(2);
    for (const mail of mails) expect(dateIn(mail.text)).toBe(formatReplacementDate(stored));
  });

  it('keeps the wait the notice decided when a claim link is sent before it resolves', async () => {
    // Purpose: fails if a claim-reissued email records the address's verified flag, so an
    // address confirmed after the notice turns the notice's long wait into the short one.
    await send(advance(MINUTE));
    const c = await ownedCommunity(h, operator, { verified: false });
    const created = await requestReplacement(c);
    const id = created.replacement.replacementId;
    await send(advance(MINUTE));
    await h.pool.query('UPDATE "user" SET "emailVerified"=true WHERE id=$1', [c.ownerUserId]);
    await expectStatus(
      await h.call(
        `/api/v1/host/communities/${c.communityId}/owner-replacements/${id}/claim-token`,
        {
          bearer: ownership,
          body: {},
        }
      ),
      200,
      'reissue'
    );
    await send(advance(MINUTE));
    expect((await row(id)).state).toBe('notifying');
    await tick(clock());
    const listed = await h.call(`/api/v1/host/communities/${c.communityId}/owner-replacements`, {
      bearer: ownership,
    });
    const { replacements } = (await listed.json()) as {
      replacements: { replacementId: string; wait: string; notice: { verifiedAddress: boolean } }[];
    };
    expect(replacements.find((entry) => entry.replacementId === id)).toMatchObject({
      wait: 'long',
      notice: { verifiedAddress: false },
    });
  });

  it('repeats the stored date after the notice resolved, and records nothing', async () => {
    // Purpose: fails if a claim link sent after the notice resolved names a new date or moves
    // the promise (review probe R4).
    await send(advance(MINUTE));
    const c = await ownedCommunity();
    const created = await requestReplacement(c);
    const id = created.replacement.replacementId;
    await send(advance(MINUTE));
    await tick(clock());
    const before = await row(id);
    advance(5 * DAY);
    await expectStatus(
      await h.call(
        `/api/v1/host/communities/${c.communityId}/owner-replacements/${id}/claim-token`,
        {
          bearer: ownership,
          body: {},
        }
      ),
      200,
      'reissue'
    );
    await send(clock());
    const after = await row(id);
    const again = mailsTo(c.ownerEmail)[1];
    expect(again.text).toContain(
      `The earliest date is still ${formatReplacementDate(before.claimable_after as Date)}.`
    );
    expect(after.notice_promised_at).toEqual(before.notice_promised_at);
    expect(after.claimable_after).toEqual(before.claimable_after);
  });
});

describe('the reminder, sent late', () => {
  it.each([
    [47, 'If you do nothing, that can happen in 2 days, on or after'],
    [20, 'If you do nothing, that can happen on or after'],
    [-3, 'If you do nothing, that can happen at any time now.'],
  ])('%i hours before the date says only what is still true', async (hoursLeft, sentence) => {
    // Purpose: fails if a reminder a busy mail server held back still says "in 2 days".
    const c = await ownedCommunity();
    const created = await requestReplacement(c);
    const id = created.replacement.replacementId;
    await send(advance(MINUTE));
    await tick(clock());
    const claimableAfter = (await row(id)).claimable_after as Date;
    clockMs = claimableAfter.getTime() - 47 * HOUR;
    await tick(clock());
    expect(await queued(id)).toContain('owner_replacement.reminder');
    // The mail server held the reminder until now.
    clockMs = claimableAfter.getTime() - hoursLeft * HOUR;
    await send(clock());
    const reminder = mailsTo(c.ownerEmail)[1];
    expect(reminder.text).toContain(sentence);
    if (hoursLeft < 36) expect(reminder.text).not.toContain('in 2 days');
  });
});

describe('a server that cannot write one kind of notice', () => {
  it('starts requests but refuses to reissue a claim it cannot announce', async () => {
    // Purpose: fails if the gate checks mail alone, or only the notice kind, so a reissue is
    // queued that the worker would fail as unsupported and the owner never hears of.
    const c = await ownedCommunity(partial, partialOperator);
    const created = await requestReplacement(c, {}, partial, partialOwnership);
    const id = created.replacement.replacementId;
    const refused = await partial.call(
      `/api/v1/host/communities/${c.communityId}/owner-replacements/${id}/claim-token`,
      { bearer: partialOwnership, body: {} }
    );
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'NOTICE_DELIVERY_UNAVAILABLE' });
    const stored = await partial.pool.query<{
      claim_token_hash: string;
      claim_reissued_at: Date | null;
    }>('SELECT claim_token_hash,claim_reissued_at FROM owner_replacements WHERE id=$1', [id]);
    expect(stored.rows[0]).toEqual({
      claim_token_hash: hashSecret(created.claimToken!),
      claim_reissued_at: null,
    });
    const kinds = await partial.pool.query<{ kind: string }>(
      'SELECT kind FROM notice_outbox WHERE subject_id=$1',
      [id]
    );
    expect(kinds.rows).toEqual([{ kind: 'owner_replacement.notice' }]);
  });
});
