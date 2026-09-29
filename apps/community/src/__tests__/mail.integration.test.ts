/**
 * Optional outbound mail (spec `community-owner-replacement`, "Mail delivery"; ADR
 * `260929-012845`; DOR-2537). Real Postgres and an in-process SMTP fake on loopback; no test
 * sends real mail.
 *
 * Every test queues its own messages. `afterEach` resolves anything still pending, so one test's
 * leftovers are never claimed by the next test's worker.
 */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { sweepCommunityDeletions } from '../deletion-worker.js';
import { plainTextMail } from '../mail/messages.js';
import { NOTICE_KINDS, pruneNoticeOutbox, queueNotice, type NoticeKind } from '../mail/outbox.js';
import { createSmtpTransport, type SmtpTimeouts } from '../mail/transport.js';
import {
  deliverNextNotice,
  NOTICE_LEASE_MS,
  startMailDelivery,
  type NoticeComposer,
  type NoticeComposers,
} from '../mail/worker.js';
import { parseConfig } from '../config.js';
import { runHostKeyCommand } from '../host-keys.js';
import { startSmtpFake, type SmtpFake } from './smtp-fake.js';
import {
  TENANCY_PASSWORD,
  bootstrapHost,
  claimAsNewAccount,
  createPendingCommunity,
  expectStatus,
  startTenancyHarness,
  type TenancyHarness,
} from './tenancy-test-harness.js';

const HOUR = 60 * 60_000;
const FAST: SmtpTimeouts = { connectionMs: 2_000, greetingMs: 2_000, socketMs: 500 };
let h: TenancyHarness;
let smtp: SmtpFake;
let operatorCookie: string;
let communityId: string;

/** Every kind composes the same test message, naming the outbox row it came from. */
const composeTest: NoticeComposer = async ({ notice }) =>
  plainTextMail(`Notice ${notice.id}`, [`Attempt ${notice.attempt} of a ${notice.kind}.`]);
const composers: NoticeComposers = Object.fromEntries(
  NOTICE_KINDS.map((kind) => [kind, composeTest])
) as NoticeComposers;

/** A fresh account, with an address only this test knows. */
async function account(): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `owner-${randomUUID()}@recipient.test`;
  await h.pool.query(`INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$2,$3,true)`, [
    id,
    'Recipient',
    email,
  ]);
  return { id, email };
}

async function queue(
  recipientUserId: string,
  options: { kind?: NoticeKind; now?: Date; community?: string } = {}
): Promise<string> {
  return queueNotice(
    h.pool,
    {
      communityId: options.community ?? communityId,
      kind: options.kind ?? 'owner_replacement.notice',
      subjectId: randomUUID(),
      recipientUserId,
    },
    options.now
  );
}

async function row(id: string) {
  return (
    await h.pool.query<{
      state: string;
      attempts: number;
      next_attempt_at: Date | null;
      lease_until: Date | null;
      accepted_at: Date | null;
      failed_at: Date | null;
      last_error_class: string | null;
      created_at: Date;
    }>(
      `SELECT state,attempts,next_attempt_at,lease_until,accepted_at,failed_at,last_error_class,
              created_at FROM notice_outbox WHERE id=$1`,
      [id]
    )
  ).rows[0];
}

function deliver(options: { now?: () => Date; timeouts?: SmtpTimeouts; pool?: Pool } = {}) {
  return deliverNextNotice({
    pool: options.pool ?? h.pool,
    transport: createSmtpTransport(smtp.mail, options.timeouts ?? FAST),
    composers,
    now: options.now,
  });
}

beforeAll(async () => {
  h = await startTenancyHarness('mail');
  const first = await bootstrapHost(h, 'Mail Owner', 'mail-owner@host.test');
  operatorCookie = first.cookie;
  communityId = first.communityId;
  smtp = await startSmtpFake();
}, 60_000);

beforeEach(() => {
  smtp.behaviour = 'accept';
  smtp.replyText = 'Rejected';
  smtp.received = [];
  smtp.connections = 0;
});

afterEach(async () => {
  await h.pool.query(
    `UPDATE notice_outbox SET state='failed',failed_at=now(),next_attempt_at=NULL,
       lease_until=NULL,last_error_class='TEST_ENDED' WHERE state='pending'`
  );
});

afterAll(async () => {
  await smtp?.close();
  await h?.close();
});

it('stores no address: only the account id, and a fixed set of columns', async () => {
  // Purpose: fails if the outbox gains a column that could hold an address, or if queueing
  // writes the recipient's email anywhere in the row.
  const columns = (
    await h.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='notice_outbox' ORDER BY column_name`
    )
  ).rows.map((column) => column.column_name);
  expect(columns).toEqual([
    'accepted_at',
    'attempts',
    'community_id',
    'created_at',
    'failed_at',
    'id',
    'kind',
    'last_error_class',
    'lease_until',
    'next_attempt_at',
    'recipient_user_id',
    'state',
    'subject_id',
  ]);
  const recipient = await account();
  const id = await queue(recipient.id);
  const stored = (
    await h.pool.query<{ json: string }>(
      'SELECT to_jsonb(n)::text AS json FROM notice_outbox n WHERE id=$1',
      [id]
    )
  ).rows[0].json;
  expect(stored).toContain(recipient.id);
  expect(stored.toLowerCase()).not.toContain(recipient.email.toLowerCase());
  expect(stored).not.toContain('@');
});

it('marks a message the mail server takes with 250 as accepted, sent as plain text', async () => {
  // Purpose: fails if a 2xx answer is not recorded as accepted, or if the message goes to the
  // wrong address, from the wrong sender, or as anything but plain text.
  const recipient = await account();
  const id = await queue(recipient.id);
  const attempt = await deliver();
  expect(attempt).toEqual({ noticeId: id, outcome: 'accepted', errorClass: null });
  expect(await row(id)).toMatchObject({
    state: 'accepted',
    attempts: 1,
    next_attempt_at: null,
    lease_until: null,
    failed_at: null,
    last_error_class: null,
  });
  expect((await row(id)).accepted_at).toBeInstanceOf(Date);
  expect(smtp.received).toHaveLength(1);
  const [message] = smtp.received;
  expect(message.recipients).toEqual([recipient.email]);
  expect(message.raw).toMatch(/^From: Test Community <notices@community\.test>$/mu);
  expect(message.raw).toMatch(new RegExp(`^Subject: Notice ${id}$`, 'mu'));
  expect(message.raw).toMatch(/^Content-Type: text\/plain/mu);
  expect(message.raw).not.toMatch(/text\/html|multipart/iu);
  expect(message.raw).toContain('Attempt 1 of a owner_replacement.notice.');
  // Nothing else was due.
  expect(await deliver()).toBeNull();
});

it('fails a message the recipient server refuses with 550 at once, keeping no reply text', async () => {
  // Purpose: fails if a permanent refusal is retried, or if the server's reply text, which here
  // echoes the address and a sentinel, reaches the row or the logs.
  const recipient = await account();
  smtp.behaviour = 'reject-recipient';
  smtp.replyText = `5.1.1 <${recipient.email}> SENTINEL-REPLY-7731 no such user`;
  const logged = vi.spyOn(console, 'error');
  const warned = vi.spyOn(console, 'warn');
  try {
    const id = await queue(recipient.id);
    expect(await deliver()).toEqual({
      noticeId: id,
      outcome: 'failed',
      errorClass: 'SMTP_REJECTED',
    });
    expect(await row(id)).toMatchObject({
      state: 'failed',
      attempts: 1,
      next_attempt_at: null,
      lease_until: null,
      last_error_class: 'SMTP_REJECTED',
    });
    const stored = (await h.pool.query('SELECT to_jsonb(n)::text AS json FROM notice_outbox n'))
      .rows as Array<{ json: string }>;
    for (const { json } of stored) {
      expect(json).not.toContain('SENTINEL');
      expect(json.toLowerCase()).not.toContain(recipient.email.toLowerCase());
    }
    const output = JSON.stringify([...logged.mock.calls, ...warned.mock.calls]);
    expect(output).not.toContain('SENTINEL');
    expect(output).not.toContain(recipient.email);
    expect(smtp.received).toHaveLength(0);
  } finally {
    logged.mockRestore();
    warned.mockRestore();
  }
});

it('retries a 421 with the cleanup backoff and fails it as unavailable 72 hours after queueing', async () => {
  // Purpose: fails if a temporary refusal fails the notice early, retries without backing off,
  // or keeps retrying past 72 hours, or if the reply text is stored.
  const recipient = await account();
  smtp.behaviour = 'defer-recipient';
  smtp.replyText = 'SENTINEL-DEFER greylisted';
  const queuedAt = new Date('2026-10-01T00:00:00.000Z');
  const id = await queue(recipient.id, { now: queuedAt });
  let clock = queuedAt;
  const attemptTimes: number[] = [];
  for (let step = 0; step < 200; step++) {
    const attempt = await deliver({ now: () => clock });
    if (!attempt) {
      clock = (await row(id)).next_attempt_at!;
      continue;
    }
    attemptTimes.push(clock.getTime());
    if (attempt.outcome === 'failed') break;
    expect(attempt).toEqual({ noticeId: id, outcome: 'retrying', errorClass: 'SMTP_UNAVAILABLE' });
    expect(await row(id)).toMatchObject({
      state: 'pending',
      lease_until: null,
      last_error_class: 'SMTP_UNAVAILABLE',
    });
  }
  const final = await row(id);
  expect(final.state).toBe('failed');
  expect(final.last_error_class).toBe('SMTP_UNAVAILABLE');
  expect(final.failed_at!.getTime()).toBe(queuedAt.getTime() + 72 * HOUR);
  expect(final.attempts).toBe(attemptTimes.length);
  // One minute doubling from the first failure (2, 4, 8 minutes), capped at an hour.
  const gaps = attemptTimes.slice(1).map((time, index) => time - attemptTimes[index]);
  expect(gaps.slice(0, 3)).toEqual([2 * 60_000, 4 * 60_000, 8 * 60_000]);
  expect(Math.max(...gaps)).toBe(HOUR);
  // Every attempt before the last was before the deadline; the last fell exactly on it.
  expect(attemptTimes.at(-1)).toBe(queuedAt.getTime() + 72 * HOUR);
  expect(attemptTimes.slice(0, -1).every((time) => time < queuedAt.getTime() + 72 * HOUR)).toBe(
    true
  );
  expect(JSON.stringify(final)).not.toContain('SENTINEL');
}, 90_000);

it('retries a send that timed out after the server read the body', async () => {
  // Purpose: fails if a timeout after the body counts as delivered or as refused. The message
  // may have arrived, so it is sent again rather than given up on.
  const recipient = await account();
  smtp.behaviour = 'silent-after-body';
  const now = new Date();
  const id = await queue(recipient.id, { now });
  expect(await deliver({ now: () => now })).toEqual({
    noticeId: id,
    outcome: 'retrying',
    errorClass: 'SMTP_UNAVAILABLE',
  });
  expect(smtp.received).toHaveLength(1);
  const pending = await row(id);
  expect(pending).toMatchObject({ state: 'pending', attempts: 1, lease_until: null });
  expect(pending.next_attempt_at!.getTime()).toBe(now.getTime() + 2 * 60_000);
});

it('takes a hung send back after its lease, while the send holds no row lock', async () => {
  // Purpose: fails if a send holds a lock on the community or the message while it waits on the
  // mail server, if a live lease lets a second replica take the message, if an expired one does
  // not, or if the hung attempt's late answer overwrites the second attempt's outcome.
  const recipient = await account();
  smtp.behaviour = 'silent-once-after-body';
  const id = await queue(recipient.id);
  const hung = deliver({ timeouts: { ...FAST, socketMs: 3_000 } });
  await smtp.waitForMessages(1);

  const client = await h.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT 1 FROM communities WHERE id=$1 FOR UPDATE NOWAIT', [communityId]);
    await client.query('SELECT 1 FROM notice_outbox WHERE id=$1 FOR UPDATE NOWAIT', [id]);
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }

  expect(await deliver()).toBeNull();
  const later = new Date(Date.now() + NOTICE_LEASE_MS + 60_000);
  expect(await deliver({ now: () => later })).toEqual({
    noticeId: id,
    outcome: 'accepted',
    errorClass: null,
  });
  expect(await hung).toEqual({
    noticeId: id,
    outcome: 'lost',
    errorClass: 'SMTP_UNAVAILABLE',
  });
  expect(await row(id)).toMatchObject({ state: 'accepted', attempts: 2, last_error_class: null });
  expect(smtp.received).toHaveLength(2);
});

it('fails a notice to a deleted account or one being erased, sending and composing nothing', async () => {
  // Purpose: fails if a person whose account is gone, or who asked for it to be erased, is
  // still mailed, or if a single-use link is composed for them.
  const gone = await account();
  const erasing = await account();
  await h.pool.query(
    `INSERT INTO erasure_requests(kind,user_id,execute_after,next_attempt_at)
     VALUES('account',$1,now()+interval '3 days',now()+interval '3 days')`,
    [erasing.id]
  );
  const goneId = await queue(gone.id);
  const erasingId = await queue(erasing.id);
  await h.pool.query('DELETE FROM "user" WHERE id=$1', [gone.id]);
  const composed = vi.fn(composeTest);
  const transport = createSmtpTransport(smtp.mail, FAST);
  const all = Object.fromEntries(NOTICE_KINDS.map((kind) => [kind, composed])) as NoticeComposers;
  const outcomes = [
    await deliverNextNotice({ pool: h.pool, transport, composers: all }),
    await deliverNextNotice({ pool: h.pool, transport, composers: all }),
  ];
  expect(outcomes).toEqual(
    expect.arrayContaining([
      { noticeId: goneId, outcome: 'failed', errorClass: 'RECIPIENT_UNAVAILABLE' },
      { noticeId: erasingId, outcome: 'failed', errorClass: 'RECIPIENT_UNAVAILABLE' },
    ])
  );
  for (const id of [goneId, erasingId])
    expect(await row(id)).toMatchObject({
      state: 'failed',
      last_error_class: 'RECIPIENT_UNAVAILABLE',
    });
  expect(composed).not.toHaveBeenCalled();
  expect(smtp.connections).toBe(0);
  expect(smtp.received).toHaveLength(0);
});

it('mints fresh content per attempt and keeps what a failed attempt composed', async () => {
  // Purpose: fails if the composer hook is not run once per attempt, or if a failed attempt's
  // writes are rolled back: a timed-out send may still deliver the link it carried.
  const recipient = await account();
  smtp.behaviour = 'silent-once-after-body';
  const minted: string[] = [];
  const minting: NoticeComposer = async ({ notice }) => {
    const token = randomUUID();
    minted.push(token);
    // A stand-in for a single-use link: written before the send, never undone after it.
    await h.pool.query('INSERT INTO mail_test_links(token,notice_id) VALUES($1,$2)', [
      token,
      notice.id,
    ]);
    return plainTextMail(`Notice ${notice.id}`, [`Link ${token}`]);
  };
  await h.pool.query(
    'CREATE TABLE IF NOT EXISTS mail_test_links(token text PRIMARY KEY, notice_id uuid NOT NULL)'
  );
  const id = await queue(recipient.id);
  const start = new Date();
  const run = (now: Date) =>
    deliverNextNotice({
      pool: h.pool,
      transport: createSmtpTransport(smtp.mail, FAST),
      composers: { 'owner_replacement.notice': minting },
      now: () => now,
    });
  expect((await run(start))?.outcome).toBe('retrying');
  expect((await run(new Date(start.getTime() + 3 * 60_000)))?.outcome).toBe('accepted');
  expect(minted).toHaveLength(2);
  expect(new Set(minted).size).toBe(2);
  const kept = await h.pool.query<{ token: string }>(
    'SELECT token FROM mail_test_links WHERE notice_id=$1',
    [id]
  );
  expect(kept.rows.map((stored) => stored.token).sort()).toEqual([...minted].sort());
  expect(smtp.received.map((message) => message.raw.includes(`Link ${minted[0]}`))).toEqual([
    true,
    false,
  ]);
  expect(smtp.received[1].raw).toContain(`Link ${minted[1]}`);
  await h.pool.query('DROP TABLE mail_test_links');
});

it('sends plainly to a local relay that offers STARTTLS with a self-signed certificate', async () => {
  // Purpose: fails if a plain loopback relay is upgraded opportunistically, when its self-signed
  // certificate would fail every send and no notice would ever be delivered.
  const relay = await startSmtpFake({ offerStartTls: true });
  try {
    const recipient = await account();
    const id = await queue(recipient.id);
    expect(
      await deliverNextNotice({
        pool: h.pool,
        transport: createSmtpTransport(relay.mail, FAST),
        composers,
      })
    ).toEqual({ noticeId: id, outcome: 'accepted', errorClass: null });
    expect(relay.received).toHaveLength(1);
  } finally {
    await relay.close();
  }
});

it('sends nothing when required STARTTLS is not offered, and retries as SMTP_TLS', async () => {
  // Purpose: fails if a server (or someone in the middle) that strips STARTTLS can downgrade a
  // remote-style connection to plain text: the message must not go out unencrypted.
  const recipient = await account();
  const id = await queue(recipient.id);
  const required = { ...smtp.mail, smtp: { ...smtp.mail.smtp, requireTLS: true } };
  expect(
    await deliverNextNotice({
      pool: h.pool,
      transport: createSmtpTransport(required, FAST),
      composers,
    })
  ).toEqual({ noticeId: id, outcome: 'retrying', errorClass: 'SMTP_TLS' });
  expect(smtp.received).toHaveLength(0);
  expect(await row(id)).toMatchObject({ state: 'pending', last_error_class: 'SMTP_TLS' });
});

it('gives up on an attempt that outlasts the attempt limit, composing or sending', async () => {
  // Purpose: fails if a composer or a mail server that never answers can hold an attempt past
  // the limit, and so past the lease, where a second replica would send the same message.
  const recipient = await account();
  const stuck = await queue(recipient.id);
  const never: NoticeComposer = () => new Promise(() => undefined);
  const started = Date.now();
  expect(
    await deliverNextNotice({
      pool: h.pool,
      transport: createSmtpTransport(smtp.mail, FAST),
      composers: { 'owner_replacement.notice': never },
      attemptLimitMs: 200,
    })
  ).toEqual({ noticeId: stuck, outcome: 'retrying', errorClass: 'NOTICE_COMPOSE_FAILED' });
  expect(smtp.connections).toBe(0);

  smtp.behaviour = 'silent-after-body';
  const slow = await queue(recipient.id);
  expect(
    await deliverNextNotice({
      pool: h.pool,
      transport: createSmtpTransport(smtp.mail, { ...FAST, socketMs: 10_000 }),
      composers,
      attemptLimitMs: 300,
    })
  ).toEqual({ noticeId: slow, outcome: 'retrying', errorClass: 'SMTP_UNAVAILABLE' });
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(await row(slow)).toMatchObject({ state: 'pending', lease_until: null });
});

it('fails a kind this server cannot compose, without sending it', async () => {
  // Purpose: fails if a message with no composer is retried forever or sent empty.
  const recipient = await account();
  const id = await queue(recipient.id, { kind: 'owner_replacement.completed' });
  expect(
    await deliverNextNotice({
      pool: h.pool,
      transport: createSmtpTransport(smtp.mail, FAST),
      composers: {},
    })
  ).toEqual({ noticeId: id, outcome: 'failed', errorClass: 'NOTICE_KIND_UNSUPPORTED' });
  expect(smtp.connections).toBe(0);
});

it('delivers each message exactly once with two workers on one database', async () => {
  // Purpose: fails if two replicas can claim the same message, so the owner gets it twice, or
  // if either skips one.
  const recipient = await account();
  const ids = new Set<string>();
  for (let index = 0; index < 20; index++) ids.add(await queue(recipient.id));
  const second = new Pool({ connectionString: h.config.databaseUrl, max: 2 });
  try {
    const drain = async (pool: Pool) => {
      const done: string[] = [];
      for (;;) {
        const attempt = await deliver({ pool });
        if (!attempt) return done;
        expect(attempt.outcome).toBe('accepted');
        done.push(attempt.noticeId);
      }
    };
    // Which worker takes how many is up to scheduling; only the union and its uniqueness matter.
    const [first, other] = await Promise.all([drain(h.pool), drain(second)]);
    expect([...first, ...other].sort()).toEqual([...ids].sort());
  } finally {
    await second.end();
  }
  const subjects = smtp.received.map(
    (message) => /^Subject: Notice (\S+)$/mu.exec(message.raw)![1]
  );
  expect(subjects.sort()).toEqual([...ids].sort());
  const attempts = await h.pool.query<{ attempts: number; state: string }>(
    'SELECT attempts,state FROM notice_outbox WHERE id=ANY($1::uuid[])',
    [[...ids]]
  );
  expect(
    attempts.rows.every((stored) => stored.attempts === 1 && stored.state === 'accepted')
  ).toBe(true);
});

it('starts no mail worker and opens no connection when mail is unset, and says only on or off', async () => {
  // Purpose: fails if a host that set nothing gets a worker or an outbound connection, or if
  // the startup line names the server or a credential. The same message is delivered once mail
  // is configured, so an idle fake here means "off", not "broken".
  const recipient = await account();
  const id = await queue(recipient.id);
  const lines: string[] = [];
  expect(
    startMailDelivery({
      config: { mail: null },
      pool: h.pool,
      composers,
      log: (line) => lines.push(line),
      pollMs: 10,
    })
  ).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(smtp.connections).toBe(0);
  expect((await row(id)).state).toBe('pending');
  expect(lines).toEqual([
    'Community mail: off. Set COMMUNITY_SMTP_URL and COMMUNITY_MAIL_FROM to send notices.',
  ]);

  const { mail } = parseConfig({
    COMMUNITY_DATABASE_URL: h.config.databaseUrl,
    COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
    COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
    COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
    COMMUNITY_PUBLIC_URL: 'http://localhost:6481',
    COMMUNITY_STORAGE_PATH: '/tmp/community-mail-test',
    COMMUNITY_SMTP_URL: `smtp://mailer:hunter2-secret@127.0.0.1:${smtp.port}`,
    COMMUNITY_MAIL_FROM: 'Test Community <notices@community.test>',
  });
  const timer = startMailDelivery({
    config: { mail },
    pool: h.pool,
    composers,
    log: (line) => lines.push(line),
    pollMs: 10,
  });
  try {
    expect(timer).not.toBeNull();
    await smtp.waitForMessages(1);
    await expect.poll(async () => (await row(id)).state).toBe('accepted');
  } finally {
    clearInterval(timer!);
  }
  expect(lines.at(-1)).toBe('Community mail: on');
  expect(lines.join('\n')).not.toMatch(/hunter2|mailer|127\.0\.0\.1|notices@/u);
});

it('says whether this host has mail and single sign-on, to readers only', async () => {
  // Purpose: fails if capabilities claims mail with none configured (or misses it when it is),
  // leaks the mail settings, or answers a key without communities:read.
  const read = await runHostKeyCommand(h.pool, {
    kind: 'issue',
    label: 'reader',
    scopes: ['communities:read'],
    expiresInDays: null,
  });
  const write = await runHostKeyCommand(h.pool, {
    kind: 'issue',
    label: 'writer',
    scopes: ['communities:write'],
    expiresInDays: null,
  });
  if (read.kind !== 'issue' || write.kind !== 'issue') throw new Error('expected keys');
  const off = await expectStatus(
    await h.call('/api/v1/host/capabilities', { bearer: read.secret }),
    200,
    'capabilities without mail'
  );
  expect(await off.json()).toEqual({ mail: false, oidc: false });
  await expectStatus(
    await h.call('/api/v1/host/capabilities', { cookie: operatorCookie }),
    200,
    'capabilities for the operator'
  );
  await expectStatus(
    await h.call('/api/v1/host/capabilities', { bearer: write.secret }),
    403,
    'capabilities without read'
  );
  await expectStatus(await h.call('/api/v1/host/capabilities'), 401, 'capabilities signed out');

  const withMail = await startTenancyHarness('mail_on', {
    env: {
      COMMUNITY_SMTP_URL: `smtp://mailer:hunter2-secret@127.0.0.1:${smtp.port}`,
      COMMUNITY_MAIL_FROM: 'notices@community.test',
    },
  });
  try {
    const operator = await bootstrapHost(withMail, 'Mail Host', 'mail-host@host.test');
    const on = await expectStatus(
      await withMail.call('/api/v1/host/capabilities', { cookie: operator.cookie }),
      200,
      'capabilities with mail'
    );
    const text = await on.text();
    expect(JSON.parse(text)).toEqual({ mail: true, oidc: false });
    expect(text).not.toMatch(/hunter2|mailer|smtp|notices@/u);
  } finally {
    await withMail.close();
  }
  expect(smtp.connections).toBe(0);
});

it('deletes a community’s messages with it, and resolved messages after 30 days', async () => {
  // Purpose: fails if the tenant deletion worker leaves a deleted community's queued mail behind
  // (or cannot delete the community because of it), or if retention keeps a resolved message
  // past 30 days or deletes a pending or recent one.
  const pending = await createPendingCommunity(
    h,
    operatorCookie,
    `Mail ${randomUUID().slice(0, 8)}`
  );
  const owner = await claimAsNewAccount(
    h,
    pending.token,
    'Leaving Owner',
    `leaving-${randomUUID()}@owner.test`
  );
  const ownerUser = (
    await h.pool.query<{ user_id: string }>('SELECT user_id FROM members WHERE id=$1', [
      owner.memberId,
    ])
  ).rows[0].user_id;
  const queued = await queue(ownerUser, { community: pending.communityId });
  const version = (
    await h.pool.query<{ lifecycle_version: number; name: string }>(
      'SELECT lifecycle_version,name FROM communities WHERE id=$1',
      [pending.communityId]
    )
  ).rows[0];
  await expectStatus(
    await h.call(`/api/v1/communities/${pending.communityId}/owner/deletion`, {
      cookie: owner.cookie,
      body: {
        lifecycleVersion: version.lifecycle_version,
        password: TENANCY_PASSWORD,
        confirmName: version.name,
        confirmIdSuffix: pending.communityId.slice(-8),
      },
    }),
    200,
    'owner deletion request'
  );
  await h.pool.query(
    `UPDATE community_deletion_jobs SET delete_after=now()-interval '1 second',
       next_attempt_at=now() WHERE community_id=$1`,
    [pending.communityId]
  );
  for (let pass = 0; pass < 10; pass++) {
    await sweepCommunityDeletions(h.pool, h.blobStore, 100);
    if (
      !(await h.pool.query('SELECT 1 FROM communities WHERE id=$1', [pending.communityId])).rowCount
    )
      break;
    await h.pool.query('UPDATE community_deletion_jobs SET next_attempt_at=now()');
  }
  expect(
    (await h.pool.query('SELECT 1 FROM communities WHERE id=$1', [pending.communityId])).rowCount
  ).toBe(0);
  expect((await h.pool.query('SELECT 1 FROM notice_outbox WHERE id=$1', [queued])).rowCount).toBe(
    0
  );

  const recipient = await account();
  const now = new Date();
  const old = await queue(recipient.id);
  const recent = await queue(recipient.id);
  const waiting = await queue(recipient.id);
  await h.pool.query(
    `UPDATE notice_outbox SET state='accepted',accepted_at=$2,next_attempt_at=NULL WHERE id=$1`,
    [old, new Date(now.getTime() - 31 * 24 * HOUR)]
  );
  await h.pool.query(
    `UPDATE notice_outbox SET state='failed',failed_at=$2,next_attempt_at=NULL,
       last_error_class='SMTP_REJECTED' WHERE id=$1`,
    [recent, new Date(now.getTime() - 29 * 24 * HOUR)]
  );
  expect(await pruneNoticeOutbox(h.pool, now)).toBeGreaterThanOrEqual(1);
  expect(await row(old)).toBeUndefined();
  expect((await row(recent)).state).toBe('failed');
  expect((await row(waiting)).state).toBe('pending');
});

it('refuses a row whose state and timestamps disagree', async () => {
  // Purpose: fails if the table would hold an accepted message still due, a failure with no
  // reason, a reason with reply text in it, or an unknown kind.
  const recipient = await account();
  const id = await queue(recipient.id);
  for (const sql of [
    `UPDATE notice_outbox SET state='accepted' WHERE id=$1`,
    `UPDATE notice_outbox SET state='accepted',accepted_at=now() WHERE id=$1`,
    `UPDATE notice_outbox SET state='failed',failed_at=now(),next_attempt_at=NULL WHERE id=$1`,
    `UPDATE notice_outbox SET last_error_class='550 no such user' WHERE id=$1`,
    `UPDATE notice_outbox SET kind='marketing' WHERE id=$1`,
    `UPDATE notice_outbox SET next_attempt_at=NULL WHERE id=$1`,
  ])
    await expect(h.pool.query(sql, [id]), sql).rejects.toMatchObject({ code: '23514' });
});
