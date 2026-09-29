import type { Pool } from 'pg';
import type { CommunityConfig } from '../config.js';
import { accountErasureOpen } from '../erasure/guards.js';
import { cleanupBackoffSql } from '../storage/pending-deletions.js';
import type { ComposedMail } from './messages.js';
import type { NoticeKind } from './outbox.js';
import { createSmtpTransport, type MailTransport } from './transport.js';

/** How long one replica holds a message while it sends it. */
export const NOTICE_LEASE_MS = 5 * 60_000;
/**
 * The most one attempt (composing and sending) may take before the worker stops waiting on it
 * and schedules a retry. Shorter than the lease, so another replica never takes a message whose
 * attempt this replica is still waiting on. A send given up on this way may still finish at the
 * mail server afterwards, so a notice can, rarely, arrive twice.
 */
export const NOTICE_ATTEMPT_LIMIT_MS = 4 * 60_000;
/** A message the mail server keeps turning away for this long after it was queued fails. */
export const NOTICE_RETRY_WINDOW_MS = 72 * 60 * 60_000;
/** How often the worker looks for due messages. */
export const NOTICE_POLL_MS = 5_000;
/** At most this many messages per tick, one at a time, so one tick never runs unbounded. */
const MESSAGES_PER_TICK = 20;

/** A message the worker has claimed for one send attempt. */
export interface ClaimedNotice {
  id: string;
  communityId: string;
  kind: NoticeKind;
  subjectId: string;
  recipientUserId: string;
  /** This attempt's number, from 1. It also fences the outcome write against a stale worker. */
  attempt: number;
  createdAt: Date;
}

/**
 * Builds one kind of message for one send attempt. It runs outside any transaction, after the
 * recipient is known to be reachable and before the message is sent, once per attempt. It may
 * write what that attempt needs, such as a single-use link it mints; the worker never undoes
 * those writes when the attempt fails, because a timed-out send may still have been delivered.
 *
 * Anything a feature must know about the recipient as of the send belongs to the composer too.
 * The outbox holds no account data and its rows are deleted 30 days after they resolve, so a
 * composer that needs, say, whether the address was verified reads `"user"."emailVerified"`
 * here and records it on its own record (such as the owner replacement it notifies).
 *
 * It must return {@link ComposedMail}, which only `plainTextMail` makes, and it must finish
 * within the attempt limit, or the attempt is retried as `NOTICE_COMPOSE_FAILED`.
 */
export type NoticeComposer = (context: {
  pool: Pool;
  notice: ClaimedNotice;
  now: Date;
}) => Promise<ComposedMail>;

/** The composer for each kind of notice this server sends. */
export type NoticeComposers = Partial<Record<NoticeKind, NoticeComposer>>;

/** Everything the worker needs. */
export interface MailWorkerOptions {
  pool: Pool;
  transport: MailTransport;
  composers: NoticeComposers;
  /** The clock every due check, lease, and deadline uses; tests inject it. */
  now?: () => Date;
  /** How long one attempt may take; {@link NOTICE_ATTEMPT_LIMIT_MS} unless a test shortens it. */
  attemptLimitMs?: number;
}

const TIMED_OUT = Symbol('timed out');

/** Wait for `work` until `deadline` (a wall-clock time in ms), then give up on it. */
async function before<T>(work: Promise<T>, deadline: number): Promise<T | typeof TIMED_OUT> {
  // Work given up on may still fail later; that must not become an unhandled rejection.
  work.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** What one attempt did, for the caller and tests. The error class never holds reply text. */
export type NoticeAttempt = {
  noticeId: string;
  outcome: 'accepted' | 'failed' | 'retrying' | 'lost';
  errorClass: string | null;
};

/**
 * Claim the next due message: pending, due, and not leased by a live attempt. A lease that ran
 * out means its worker died or hung, and the message is taken again.
 */
async function claimNotice(pool: Pool, now: Date): Promise<ClaimedNotice | null> {
  const claimed = await pool.query<{
    id: string;
    community_id: string;
    kind: NoticeKind;
    subject_id: string;
    recipient_user_id: string;
    attempts: number;
    created_at: Date;
  }>(
    `UPDATE notice_outbox
     SET attempts=attempts+1,lease_until=$1::timestamptz + $2 * interval '1 millisecond'
     WHERE id=(
       SELECT id FROM notice_outbox
       WHERE state='pending' AND next_attempt_at<=$1 AND (lease_until IS NULL OR lease_until<$1)
       ORDER BY next_attempt_at,created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING id,community_id,kind,subject_id,recipient_user_id,attempts,created_at`,
    [now, NOTICE_LEASE_MS]
  );
  const row = claimed.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    communityId: row.community_id,
    kind: row.kind,
    subjectId: row.subject_id,
    recipientUserId: row.recipient_user_id,
    attempt: row.attempts,
    createdAt: row.created_at,
  };
}

/**
 * The recipient's address, read now, or null when the account is gone (an account erasure
 * finished) or an account erasure is waiting or running: a person who asked to be forgotten is
 * not mailed.
 */
async function recipientAddress(pool: Pool, userId: string): Promise<string | null> {
  const account = await pool.query<{ email: string }>('SELECT email FROM "user" WHERE id=$1', [
    userId,
  ]);
  const email = account.rows[0]?.email;
  if (!email || (await accountErasureOpen(pool, userId))) return null;
  return email;
}

/** Record a final outcome, only if this attempt still holds the message. */
async function resolve(
  pool: Pool,
  notice: ClaimedNotice,
  now: Date,
  outcome: { state: 'accepted' } | { state: 'failed'; errorClass: string }
): Promise<boolean> {
  const updated =
    outcome.state === 'accepted'
      ? await pool.query(
          `UPDATE notice_outbox SET state='accepted',accepted_at=$3,lease_until=NULL,
             next_attempt_at=NULL,last_error_class=NULL
           WHERE id=$1 AND state='pending' AND attempts=$2`,
          [notice.id, notice.attempt, now]
        )
      : await pool.query(
          `UPDATE notice_outbox SET state='failed',failed_at=$3,lease_until=NULL,
             next_attempt_at=NULL,last_error_class=$4
           WHERE id=$1 AND state='pending' AND attempts=$2`,
          [notice.id, notice.attempt, now, outcome.errorClass]
        );
  return updated.rowCount === 1;
}

/**
 * A temporary failure: try again after the shared cleanup backoff, but never past the end of
 * the 72-hour window, so the last attempt falls at its end. A failure at or after the end fails
 * the message for good.
 */
async function retryLater(
  pool: Pool,
  notice: ClaimedNotice,
  now: Date,
  errorClass: string
): Promise<NoticeAttempt> {
  const deadline = notice.createdAt.getTime() + NOTICE_RETRY_WINDOW_MS;
  if (now.getTime() >= deadline) {
    const resolved = await resolve(pool, notice, now, { state: 'failed', errorClass });
    return { noticeId: notice.id, outcome: resolved ? 'failed' : 'lost', errorClass };
  }
  const updated = await pool.query(
    `UPDATE notice_outbox SET lease_until=NULL,last_error_class=$4,
       next_attempt_at=LEAST($3::timestamptz + ${cleanupBackoffSql('attempts')},$5::timestamptz)
     WHERE id=$1 AND state='pending' AND attempts=$2`,
    [notice.id, notice.attempt, now, errorClass, new Date(deadline)]
  );
  return {
    noticeId: notice.id,
    outcome: updated.rowCount === 1 ? 'retrying' : 'lost',
    errorClass,
  };
}

/**
 * Claim one due message and make one attempt to send it. The send happens outside any
 * transaction and holds no row lock, only the message's lease. Returns what happened, or null
 * when nothing was due.
 *
 * An unreachable recipient fails at once as `RECIPIENT_UNAVAILABLE`, with nothing composed or
 * sent. An attempt that outlasts {@link NOTICE_ATTEMPT_LIMIT_MS} is abandoned and retried. A kind this server cannot compose fails as `NOTICE_KIND_UNSUPPORTED`. A composer that
 * throws is retried like a mail server that is down, as `NOTICE_COMPOSE_FAILED`.
 */
export async function deliverNextNotice(options: MailWorkerOptions): Promise<NoticeAttempt | null> {
  const clock = options.now ?? (() => new Date());
  const notice = await claimNotice(options.pool, clock());
  if (!notice) return null;
  const fail = async (errorClass: string): Promise<NoticeAttempt> => ({
    noticeId: notice.id,
    outcome: (await resolve(options.pool, notice, clock(), { state: 'failed', errorClass }))
      ? 'failed'
      : 'lost',
    errorClass,
  });
  const to = await recipientAddress(options.pool, notice.recipientUserId);
  if (!to) return fail('RECIPIENT_UNAVAILABLE');
  const compose = options.composers[notice.kind];
  if (!compose) return fail('NOTICE_KIND_UNSUPPORTED');
  // Measured on the wall clock, not the injected one: it bounds how long this replica waits.
  const deadline = Date.now() + (options.attemptLimitMs ?? NOTICE_ATTEMPT_LIMIT_MS);
  let message: ComposedMail | typeof TIMED_OUT;
  try {
    message = await before(compose({ pool: options.pool, notice, now: clock() }), deadline);
  } catch (error) {
    console.error(
      'Community notice could not be composed',
      error instanceof Error ? error.name : 'unknown'
    );
    return retryLater(options.pool, notice, clock(), 'NOTICE_COMPOSE_FAILED');
  }
  if (message === TIMED_OUT)
    return retryLater(options.pool, notice, clock(), 'NOTICE_COMPOSE_FAILED');
  const delivery = await before(options.transport.send({ to, ...message }), deadline);
  // Given up on, not failed: the mail server may still take it, so it is retried.
  if (delivery === TIMED_OUT) return retryLater(options.pool, notice, clock(), 'SMTP_UNAVAILABLE');
  if (delivery.outcome === 'accepted') {
    const resolved = await resolve(options.pool, notice, clock(), { state: 'accepted' });
    return { noticeId: notice.id, outcome: resolved ? 'accepted' : 'lost', errorClass: null };
  }
  if (delivery.outcome === 'refused') return fail(delivery.errorClass);
  return retryLater(options.pool, notice, clock(), delivery.errorClass);
}

/**
 * Send due messages in the background, one at a time on this replica, and return the timer for
 * the shutdown path. Other replicas take other messages; a message is never held by two live
 * attempts, because each claim takes a lease and skips locked and leased rows.
 */
export function startMailWorker(
  options: MailWorkerOptions & { pollMs?: number }
): ReturnType<typeof setInterval> {
  let sending = false;
  const timer = setInterval(() => {
    if (sending) return;
    sending = true;
    void (async () => {
      for (let sent = 0; sent < MESSAGES_PER_TICK; sent++) {
        const attempt = await deliverNextNotice(options);
        if (!attempt) return;
        if (attempt.errorClass)
          console.warn('Community notice not delivered', attempt.outcome, attempt.errorClass);
      }
    })()
      .catch((error: unknown) => {
        console.error(
          'Community mail worker unavailable',
          error instanceof Error ? error.name : 'unknown'
        );
      })
      .finally(() => {
        sending = false;
      });
  }, options.pollMs ?? NOTICE_POLL_MS);
  timer.unref();
  return timer;
}

/**
 * Start mail delivery when the host has configured it, and say at startup whether mail is on.
 * With mail unset nothing starts and no connection is ever opened. The log line never names the
 * server, the sender, or any credential.
 *
 * @returns The worker's timer, or null when mail is off.
 */
export function startMailDelivery(options: {
  config: Pick<CommunityConfig, 'mail'>;
  pool: Pool;
  composers: NoticeComposers;
  log?: (line: string) => void;
  pollMs?: number;
}): ReturnType<typeof setInterval> | null {
  const log = options.log ?? ((line: string) => console.info(line));
  const mail = options.config.mail;
  if (!mail) {
    log('Community mail: off. Set COMMUNITY_SMTP_URL and COMMUNITY_MAIL_FROM to send notices.');
    return null;
  }
  log('Community mail: on');
  return startMailWorker({
    pool: options.pool,
    transport: createSmtpTransport(mail),
    composers: options.composers,
    pollMs: options.pollMs,
  });
}
