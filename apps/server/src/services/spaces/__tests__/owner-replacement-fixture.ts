/**
 * Shared set-up for the owner-replacement route tests (specs/community-owner-replacement, task
 * 2.4): hosts with mail and the worker's notice composers, communities with an owner, requests,
 * and the real timeline to move them. Real PostgreSQL through the tenancy harness.
 */
import { randomUUID } from 'node:crypto';
import { CommunityAdminOwnerReplacementCreateResponseSchema } from '@dorkos/shared/community-admin-wire';
import { ownerReplacementComposers } from '../owner-replacement/notices.js';
import { mintObjectToken } from '../owner-replacement/object-tokens.js';
import { advanceOwnerReplacements } from '../owner-replacement/worker.js';
import { responseCookies } from './bootstrap-test-helper.js';
import type { FakeIdentity, FakeIssuer } from './fake-oidc-issuer.js';
import {
  TENANCY_PASSWORD,
  admit,
  bootstrapHost,
  claimAsNewAccount,
  createPendingCommunity,
  expectStatus,
  startTenancyHarness,
  type TenancyHarness,
  type TenancyMember,
} from './tenancy-test-harness.js';

export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;
export const PUBLIC_URL = 'http://localhost:6481';
/** The short wait; every fixture owner's address is verified, so a request gets it. */
export const NOTICE_DAYS = 7;
const SETTINGS = {
  publicUrl: PUBLIC_URL,
  ownerReplacement: { noticeDays: NOTICE_DAYS, unreachableDays: 14, objectionCooldownDays: 90 },
};
/** The mail composers `main.ts` gives the app, so requests are accepted. */
export const COMPOSERS = ownerReplacementComposers(SETTINGS);
const ENV = {
  // Mail is set up; no test here sends any, so the address is never dialled.
  COMMUNITY_SMTP_URL: 'smtp://127.0.0.1:2525',
  COMMUNITY_MAIL_FROM: 'notices@community.test',
  COMMUNITY_PUBLIC_URL: PUBLIC_URL,
  COMMUNITY_OWNER_REPLACEMENT_NOTICE_DAYS: NOTICE_DAYS,
  COMMUNITY_OWNER_REPLACEMENT_UNREACHABLE_DAYS: 14,
};

/** One clock for every host in a test file. It only moves forward. */
export class TestClock {
  ms = Date.now();
  readonly now = () => new Date(this.ms);
  advance(ms: number): Date {
    this.ms += ms;
    return this.now();
  }
}

/** A running host with mail and the worker's notice composers, its operator, and an ownership key. */
export interface ReplacementHost {
  h: TenancyHarness;
  clock: TestClock;
  operator: string;
  ownershipKey: string;
}

/** The environment a host needs for single sign-on through a fake issuer. */
export function oidcEnv(issuer: FakeIssuer, issuerUrl = issuer.issuer): Record<string, string> {
  return {
    COMMUNITY_OIDC_ISSUER_URL: issuerUrl,
    COMMUNITY_OIDC_CLIENT_ID: issuer.clientId,
    COMMUNITY_OIDC_CLIENT_SECRET: issuer.clientSecret,
    COMMUNITY_OIDC_LABEL: 'Example sign-in',
  };
}

/**
 * Start a host with mail and the worker's notice composers. With `sharesDatabaseOf` it is the same host
 * restarted with other settings: same database, operator, and key.
 */
export async function startReplacementHost(
  label: string,
  clock: TestClock,
  options: {
    env?: Record<string, unknown>;
    sharesDatabaseOf?: ReplacementHost;
  } = {}
): Promise<ReplacementHost> {
  const h = await startTenancyHarness(label, {
    now: clock.now,
    env: { ...ENV, ...options.env },
    noticeComposers: COMPOSERS,
    sharesDatabaseOf: options.sharesDatabaseOf?.h,
  });
  if (options.sharesDatabaseOf)
    return {
      h,
      clock,
      operator: options.sharesDatabaseOf.operator,
      ownershipKey: options.sharesDatabaseOf.ownershipKey,
    };
  const operator = (await bootstrapHost(h, `${label} Host`, `host-${label}@host.test`)).cookie;
  const issued = await expectStatus(
    await h.call('/api/v1/host/api-keys', {
      cookie: operator,
      body: {
        label: `${label} ownership`,
        scopes: ['communities:ownership'],
        expiresInDays: null,
        password: TENANCY_PASSWORD,
      },
    }),
    201,
    'issue ownership key'
  );
  return { h, clock, operator, ownershipKey: ((await issued.json()) as { secret: string }).secret };
}

/** A community with an owner whose email a sign-in service marked verified. */
export interface Owned {
  communityId: string;
  base: string;
  name: string;
  owner: TenancyMember;
  ownerUserId: string;
}

let counter = 0;

/** A unique suffix for names, emails, and keys. */
export function unique(): string {
  return `${++counter}-${randomUUID().slice(0, 8)}`;
}

export async function ownedCommunity(host: ReplacementHost): Promise<Owned> {
  const n = unique();
  const name = `Replacement Community ${n}`;
  const { communityId, token } = await createPendingCommunity(host.h, host.operator, name);
  const owner = await claimAsNewAccount(host.h, token, `Owner ${n}`, `owner-${n}@owner.test`);
  const user = await host.h.pool.query<{ user_id: string }>(
    'SELECT user_id FROM members WHERE id=$1',
    [owner.memberId]
  );
  const ownerUserId = user.rows[0].user_id;
  await host.h.pool.query('UPDATE "user" SET "emailVerified"=true WHERE id=$1', [ownerUserId]);
  return { communityId, base: `/api/v1/communities/${communityId}`, name, owner, ownerUserId };
}

/** Admit a new account into the community as a plain member. */
export async function member(host: ReplacementHost, c: Owned, name = `Member ${unique()}`) {
  return admit(host.h, c.communityId, c.owner.cookie, {
    name,
    email: `${name.toLowerCase().replaceAll(' ', '-')}-${unique()}@member.test`,
  });
}

export async function lifecycleVersion(host: ReplacementHost, communityId: string) {
  return (
    await host.h.pool.query<{ lifecycle_version: number }>(
      'SELECT lifecycle_version FROM communities WHERE id=$1',
      [communityId]
    )
  ).rows[0].lifecycle_version;
}

/** Ask to replace the owner with the ownership key; returns the request and its claim token. */
export async function requestReplacement(
  host: ReplacementHost,
  c: Owned,
  overrides: Record<string, unknown> = {}
): Promise<{ replacementId: string; claimToken: string }> {
  const response = await host.h.call(
    `/api/v1/host/communities/${c.communityId}/owner-replacements`,
    {
      bearer: host.ownershipKey,
      body: {
        idempotencyKey: `claim-${unique()}`,
        lifecycleVersion: await lifecycleVersion(host, c.communityId),
        reason: 'owner_unreachable',
        reference: 'CASE-2541',
        claimant: { oidcSubject: null },
        ...overrides,
      },
    }
  );
  await expectStatus(response, 201, 'request replacement');
  const created = CommunityAdminOwnerReplacementCreateResponseSchema.parse(await response.json());
  return { replacementId: created.replacement.replacementId, claimToken: created.claimToken! };
}

/** One replacement row, every column. */
export async function replacementRow(host: ReplacementHost, id: string) {
  return (
    await host.h.pool.query<Record<string, unknown>>(
      'SELECT * FROM owner_replacements WHERE id=$1',
      [id]
    )
  ).rows[0];
}

/** Run the real timeline at the clock's time. */
export function tick(host: ReplacementHost) {
  return advanceOwnerReplacements({ pool: host.h.pool, config: SETTINGS, now: host.clock.now() });
}

/**
 * The owner's mail server takes the notice now, and the timeline starts the wait. What the mail
 * worker records is written here directly; sending is covered by the timeline tests. Every
 * fixture owner's address is verified, so the wait is the short one.
 */
export async function toWaiting(host: ReplacementHost, id: string): Promise<Date> {
  // What sending the notice records: every fixture owner's address is verified.
  await host.h.pool.query('UPDATE owner_replacements SET verified_address=true WHERE id=$1', [id]);
  await host.h.pool.query(
    `UPDATE notice_outbox SET state='accepted',accepted_at=$2,next_attempt_at=NULL
     WHERE subject_id=$1 AND kind='owner_replacement.notice'`,
    [id, host.clock.now()]
  );
  await tick(host);
  const row = await replacementRow(host, id);
  if (row.state !== 'waiting') throw new Error(`Expected waiting, got ${String(row.state)}`);
  return row.claimable_after as Date;
}

/** Let the wait run out, one minute past it, and let the timeline open the claim. */
export async function toClaimable(host: ReplacementHost, id: string): Promise<void> {
  const claimableAfter = await toWaiting(host, id);
  host.clock.ms = Math.max(host.clock.ms, claimableAfter.getTime() + MINUTE);
  await tick(host);
  const row = await replacementRow(host, id);
  if (row.state !== 'claimable') throw new Error(`Expected claimable, got ${String(row.state)}`);
}

/** Mint one object-only link for a request, as the mail worker does, and return its token. */
export async function objectToken(host: ReplacementHost, c: Owned, id: string): Promise<string> {
  const link = await mintObjectToken(host.h.pool, {
    communityId: c.communityId,
    replacementId: id,
    outboxId: randomUUID(),
    publicUrl: PUBLIC_URL,
    now: host.clock.now(),
  });
  return link.split('#')[1];
}

/** Merge cookie headers, a later value replacing an earlier one of the same name. */
export function cookies(...headers: string[]): string {
  const jar = new Map<string, string>();
  for (const header of headers)
    for (const part of header.split('; ').filter(Boolean)) jar.set(part.split('=')[0], part);
  return [...jar.values()].join('; ');
}

/** Preflight a claim token; returns the response and the cookie a browser would then hold. */
export async function preflightClaim(host: ReplacementHost, token: string) {
  const response = await host.h.call('/api/v1/owner-replacements/preflight', { body: { token } });
  return { response, cookie: responseCookies(response) };
}

/** A password sign-up carrying `cookie`; returns the response and the merged cookies. */
export async function passwordSignUp(
  host: ReplacementHost,
  cookie: string,
  name = `Claimant ${unique()}`
) {
  const response = await host.h.call('/api/auth/sign-up/email', {
    cookie: cookie || undefined,
    body: {
      name,
      email: `${name.toLowerCase().replaceAll(' ', '-')}@claimant.test`,
      password: TENANCY_PASSWORD,
    },
  });
  return { response, cookie: cookies(cookie, responseCookies(response)) };
}

/** Claim with a session and the claim cookie. */
export function claim(host: ReplacementHost, cookie: string) {
  return host.h.call('/api/v1/owner-replacements/claim', { cookie, body: {} });
}

/** A request to the harness that does not follow redirects, as a browser's sign-in steps are. */
function manual(
  host: ReplacementHost,
  path: string,
  method: string,
  cookie: string,
  body?: unknown
) {
  return fetch(`${host.h.baseUrl}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      origin: PUBLIC_URL,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * Sign in (or up) through the fake issuer as `identity`, the way a browser does: start, let the
 * issuer authorize, return to the callback with the cookies the start set. Returns where the
 * callback sent the browser and the cookies it then holds.
 */
export async function oidcSignIn(
  host: ReplacementHost,
  issuer: FakeIssuer,
  identity: FakeIdentity,
  cookie = ''
): Promise<{ location: URL; cookie: string }> {
  issuer.identity = identity;
  const start = await manual(host, '/api/auth/sign-in/social', 'POST', cookie, {
    provider: 'oidc',
    callbackURL: '/signed-in',
    errorCallbackURL: '/sign-in-failed',
  });
  await expectStatus(start, 200, 'start single sign-on');
  const { url } = (await start.json()) as { url: string };
  const authorize = await fetch(url, { redirect: 'manual' });
  const back = new URL(authorize.headers.get('location')!);
  const held = cookies(cookie, responseCookies(start));
  const callback = await manual(host, `${back.pathname}${back.search}`, 'GET', held);
  if (callback.status !== 302) throw new Error(`Callback answered ${callback.status}`);
  return {
    location: new URL(callback.headers.get('location')!, PUBLIC_URL),
    cookie: cookies(held, responseCookies(callback)),
  };
}

/** An identity the fake issuer vouches for. */
export function identity(sub: string): FakeIdentity {
  const n = unique();
  return { sub, email: `${sub}-${n}@sso.test`, email_verified: true, name: `Person ${n}` };
}

/** Archive the community as its owner, or put it on hold as the host. */
export async function moveLifecycle(
  host: ReplacementHost,
  c: Owned,
  to: 'archived' | 'held'
): Promise<void> {
  const version = await lifecycleVersion(host, c.communityId);
  const response =
    to === 'archived'
      ? await host.h.call(`${c.base}/owner/lifecycle`, {
          cookie: c.owner.cookie,
          body: {
            action: 'archive',
            lifecycleVersion: version,
            password: TENANCY_PASSWORD,
            confirmName: c.name,
          },
        })
      : await host.h.call(`/api/v1/host/communities/${c.communityId}/lifecycle`, {
          method: 'PATCH',
          cookie: host.operator,
          body: { action: 'hold', lifecycleVersion: version, deletionNoticeAt: null },
        });
  await expectStatus(response, 200, to);
}

/** Make a member an admin, as the owner. */
export async function promote(host: ReplacementHost, c: Owned, memberId: string): Promise<void> {
  await expectStatus(
    await host.h.call(`${c.base}/members/${memberId}/role`, {
      method: 'PATCH',
      cookie: c.owner.cookie,
      body: { role: 'admin' },
    }),
    200,
    'make admin'
  );
}
