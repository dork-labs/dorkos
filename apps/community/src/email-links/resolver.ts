import type { Pool, PoolClient } from 'pg';
import type { CommunityConfig } from '../config.js';
import { transaction } from '../data.js';
import { accountErasureOpen, signInRefusal } from '../erasure/guards.js';
import { queueNotice } from '../mail/outbox.js';
import { hmacSecret } from '../security.js';
import { liveHoldFor } from './tokens.js';
import { EMAIL_LINK_CAPS, EMAIL_LINK_NOTICE_KIND, type EmailLinkKind } from './model.js';

/** The most requests one resolver pass decides, so one tick never runs unbounded. */
const REQUESTS_PER_PASS = 20;
/**
 * One resolver at a time across replicas, so two cannot both count an address under its cap and
 * both queue. Held only for one request's short transaction.
 */
const RESOLVER_LOCK = 77_281_710;

interface PendingRequest {
  id: string;
  kind: EmailLinkKind;
  email_hash: string;
  email: string | null;
  user_id: string | null;
  pending_link_hash: string | null;
}

/** What one request became. */
export type RequestOutcome = 'queued' | 'throttled' | 'dropped';

/**
 * The account a request is for, if it may get this link (spec §5): it exists, still has the
 * address the request named, may sign in, and is not being forgotten; a sign-in request's hold
 * is still live and this account's; a confirmation's email is still unconfirmed.
 */
async function eligibleAccount(
  client: PoolClient,
  request: PendingRequest,
  authSecret: string
): Promise<string | null> {
  const user = request.user_id
    ? await client.query<{ id: string; email: string; emailVerified: boolean }>(
        'SELECT id,email,"emailVerified" FROM "user" WHERE id=$1',
        [request.user_id]
      )
    : await client.query<{ id: string; email: string; emailVerified: boolean }>(
        'SELECT id,email,"emailVerified" FROM "user" WHERE email=$1',
        [request.email]
      );
  const account = user.rows[0];
  if (!account) return null;
  if (hmacSecret(account.email.toLowerCase(), authSecret) !== request.email_hash) return null;
  if (await signInRefusal(client, account.id)) return null;
  // A person who asked to be forgotten is not mailed (as the mail worker itself refuses).
  if (await accountErasureOpen(client, account.id)) return null;
  if (
    request.kind === 'sign_in' &&
    !(await liveHoldFor(client, request.pending_link_hash, account.id))
  )
    return null;
  if (request.kind === 'email_confirmation' && account.emailVerified) return null;
  return account.id;
}

/**
 * Whether one more mail to this address, or from this host, would pass a cap. Only requests that
 * became mail count, so requests for addresses with no account never use up anyone's allowance.
 */
async function overCap(
  client: PoolClient,
  emailHash: string,
  now: Date,
  hostPerHour: number
): Promise<boolean> {
  const address = await client.query<{ hour: number; day: number }>(
    `SELECT count(*) FILTER (WHERE resolved_at > $2::timestamptz - interval '1 hour')::int AS hour,
            count(*)::int AS day
     FROM email_link_requests
     WHERE email_hash=$1 AND state='queued' AND resolved_at > $2::timestamptz - interval '24 hours'`,
    [emailHash, now]
  );
  const { hour, day } = address.rows[0];
  if (hour >= EMAIL_LINK_CAPS.perAddressPerHour || day >= EMAIL_LINK_CAPS.perAddressPerDay)
    return true;
  const host = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM email_link_requests
     WHERE state='queued' AND resolved_at > $1::timestamptz - interval '1 hour'`,
    [now]
  );
  return host.rows[0].n >= hostPerHour;
}

/**
 * Decide the oldest pending request, in one transaction: drop it (no account, a refused or
 * erased account, an already confirmed email, a hold that is gone), throttle it (eligible, but
 * the address or the host is at its cap), or queue its mail on the notice outbox. Either way the
 * typed address is erased from the row. Returns what it became, or null when nothing was pending.
 */
export async function resolveNextEmailLinkRequest(
  pool: Pool,
  config: Pick<CommunityConfig, 'authSecret'> & {
    limits: Pick<CommunityConfig['limits'], 'emailLinksPerHour'>;
  },
  now: Date = new Date()
): Promise<RequestOutcome | null> {
  return transaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [RESOLVER_LOCK]);
    const claimed = await client.query<PendingRequest>(
      `SELECT id,kind,email_hash,email,user_id,pending_link_hash FROM email_link_requests
       WHERE state='pending' ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`
    );
    const request = claimed.rows[0];
    if (!request) return null;
    const userId = await eligibleAccount(client, request, config.authSecret);
    let outcome: RequestOutcome = 'dropped';
    let outboxId: string | null = null;
    if (userId) {
      if (await overCap(client, request.email_hash, now, config.limits.emailLinksPerHour))
        outcome = 'throttled';
      else {
        outcome = 'queued';
        outboxId = await queueNotice(
          client,
          {
            communityId: null,
            kind: EMAIL_LINK_NOTICE_KIND[request.kind],
            subjectId: request.id,
            recipientUserId: userId,
          },
          now
        );
      }
    }
    await client.query(
      `UPDATE email_link_requests SET state=$2,outbox_id=$3,resolved_at=$4,email=NULL
       WHERE id=$1`,
      [request.id, outcome, outboxId, now]
    );
    return outcome;
  });
}

/**
 * Resolve up to twenty pending requests; the mail worker runs this before each tick, only when
 * mail is on. Returns how many it decided.
 */
export async function resolveEmailLinkRequests(
  pool: Pool,
  config: Parameters<typeof resolveNextEmailLinkRequest>[1],
  now: () => Date = () => new Date()
): Promise<number> {
  let resolved = 0;
  while (resolved < REQUESTS_PER_PASS) {
    if (!(await resolveNextEmailLinkRequest(pool, config, now()))) break;
    resolved++;
  }
  return resolved;
}
