/**
 * Administration role matrix (DOR-2178).
 *
 * The administration specification (`specs/community-administration-contract/02-specification.md`,
 * "Verification matrix") asks for a passing and a refused API test for every role on every
 * administration action, including a host operator who is not a member. This file is that
 * matrix: one table of actions, run against every role over real HTTP and PostgreSQL.
 *
 * - An allowed cell must return the success status and its effect must be visible.
 * - A refused cell must return the exact refusal status and leave every table unchanged.
 * - The table must name every administration route the app registers, and every other route
 *   must be listed as outside administration with a reason, so a new route fails this file
 *   until someone classifies it.
 * - A community whose admission is closed admits no one: creating, previewing, starting,
 *   binding and redeeming an invitation are refused for every role, and the close is raced
 *   against an invitation and a join in both orders.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { Pool } from 'pg';
import { createCommunityApp } from '../app.js';
import { createCommunityAuth } from '../auth.js';
import { parseConfig, type CommunityConfig } from '../config.js';
import { migrate } from '../migrate.js';
import { registerAdministrationRoutes } from '../routes/administration.js';
import { registerHostRoutes } from '../routes/host.js';
import { registerMembershipRoutes } from '../routes/memberships.js';
import { registerHostLimitRoutes } from '../routes/host-limits.js';
import { registerHostLifecycleRoutes } from '../routes/host-lifecycle.js';
import { registerShortNameRoutes } from '../routes/short-names.js';
import { registerOwnerClaimRoutes } from '../routes/owner-claims.js';
import { registerHostKeyRoutes } from '../routes/host-keys.js';
import { registerHostTakedownRoutes } from '../routes/host-takedowns.js';
import { createHostAuthority } from '../host/authority.js';
import { issueHostApiKey } from '../host/key-store.js';
import { hashSecret, randomToken } from '../security.js';
import { FileSystemBlobStore } from '../storage/index.js';
import {
  bootstrapFirstHost,
  responseCookies,
  seedCredentialAccount,
} from './bootstrap-test-helper.js';

const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('COMMUNITY_TEST_DATABASE_URL is required for administration tests');
const admin = new Pool({ connectionString: adminUrl });
const dbName = `community_admin_roles_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
const origin = 'http://localhost:6481';
const password = 'password1234';
const wrongPassword = 'not-the-password-1234';

/** Every role the specification's verification matrix names. */
const ROLES = [
  'owner',
  'admin',
  'member',
  'removedMember',
  'signedOut',
  'hostOnly',
  'hostMember',
  'otherOwner',
  'agent',
] as const;
type Role = (typeof ROLES)[number];

/**
 * - owner, admin, member: roles in community A; none of them is a host operator.
 * - removedMember: was a member of A and was removed; the browser session still works.
 * - signedOut: no session at all.
 * - hostOnly: a host operator with no membership anywhere.
 * - hostMember: the first-install host operator, who owns another community and is a plain
 *   member of A.
 * - otherOwner: owns community B only.
 * - agent: a live agent credential enrolled by A's owner, sent as a bearer token.
 */
const sessions = {} as Record<Exclude<Role, 'signedOut' | 'agent'>, string>;
const userIds = {} as Record<Exclude<Role, 'signedOut' | 'agent'>, string>;
let agentToken = '';

let server: ReturnType<typeof serve>;
let app: ReturnType<typeof createCommunityApp>;
let config: CommunityConfig;
let pool: Pool;
let baseUrl = '';
let storagePath = '';
let alphaId = '';
let betaId = '';
let ownerMemberId = '';
let spareMemberId = '';
let spareCookie = '';
let moderationChannelId = '';
let pendingSequence = 0;

interface Call {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  bytes?: Buffer;
  headers?: Record<string, string>;
  cookie?: string;
}

interface Action<T> {
  /** One line naming the spec row or existing rule this action proves. */
  rule: string;
  /** The registered route, as `METHOD /path` with the community prefix removed. */
  route: string;
  /** A short distinguishing label when several actions share a route. */
  variant?: string;
  allowed: readonly Role[];
  status: number;
  /** Refusal status per role; unlisted refused roles get 401 when signed out, else 403. */
  refused?: Partial<Record<Role, number>>;
  /** Owner-only actions that also require the current password. */
  reauth?: boolean;
  prepare?: (role: Role) => Promise<T>;
  call: (prepared: T, secret: string) => Call;
  effect?: (body: Buffer, role: Role, prepared: T) => Promise<void>;
}

function define<T>(action: Action<T>): Action<unknown> {
  return action as unknown as Action<unknown>;
}

function scoped(path: string): string {
  return `/api/v1/communities/${alphaId}${path}`;
}

async function send(
  call: Call,
  role: Role | 'founder' | 'spare',
  extraHeaders: Record<string, string> = {}
): Promise<Response> {
  const headers: Record<string, string> = { origin, ...call.headers, ...extraHeaders };
  const cookies: string[] = [];
  if (role === 'agent') headers.authorization = `Bearer ${agentToken}`;
  else if (role === 'founder') cookies.push(sessions.hostMember);
  else if (role === 'spare') cookies.push(spareCookie);
  else if (role !== 'signedOut') cookies.push(sessions[role]);
  if (call.cookie) cookies.push(call.cookie);
  if (cookies.length) headers.cookie = cookies.join('; ');
  let body: BodyInit | undefined;
  if (call.bytes) body = new Uint8Array(call.bytes);
  else if (call.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(call.body);
  }
  return fetch(`${baseUrl}${call.path}`, {
    method: call.method,
    headers,
    body,
    signal: AbortSignal.timeout(10_000),
  });
}

async function expectStatus(response: Response, status: number, label: string): Promise<Buffer> {
  const body = Buffer.from(await response.arrayBuffer());
  expect(response.status, `${label}: ${body.toString('utf8').slice(0, 300)}`).toBe(status);
  return body;
}

async function ok(call: Call, role: Role | 'founder' | 'spare', status = 200): Promise<unknown> {
  const body = await expectStatus(await send(call, role), status, `${call.method} ${call.path}`);
  return body.length ? JSON.parse(body.toString('utf8')) : null;
}

interface AlphaRow {
  name: string;
  description: string | null;
  admission_policy: string;
  icon_blob_key: string | null;
  settings_version: number;
  lifecycle: string;
  lifecycle_version: number;
}

async function alpha(): Promise<AlphaRow> {
  return (
    await pool.query<AlphaRow>(
      `SELECT name,description,admission_policy,icon_blob_key,settings_version,lifecycle,
              lifecycle_version FROM communities WHERE id=$1`,
      [alphaId]
    )
  ).rows[0];
}

async function roleOf(memberId: string): Promise<{ role: string; active: boolean }> {
  return (
    await pool.query<{ role: string; active: boolean }>(
      'SELECT role,active FROM members WHERE id=$1',
      [memberId]
    )
  ).rows[0];
}

/**
 * Every row of every table, for the refused-cell comparison. Last-used times are left out:
 * the app records them by design whenever a grant or credential authenticates a request.
 */
async function snapshot(): Promise<Record<string, unknown>> {
  const tables = (
    await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`
    )
  ).rows.map((row) => row.table_name);
  // An empty catalogue read would make two snapshots vacuously equal.
  expect(tables).toEqual(expect.arrayContaining(['communities', 'members', 'session', 'user']));
  const result: Record<string, unknown> = {};
  for (const table of tables) {
    const quoted = '"' + table.replaceAll('"', '""') + '"';
    const rows = (
      await pool.query<{ row: Record<string, unknown> }>(
        `SELECT to_jsonb(t) AS row FROM ${quoted} t ORDER BY to_jsonb(t)::text`
      )
    ).rows.map(({ row }) => {
      const { last_used_at: _lastUsed, ...rest } = row;
      return rest;
    });
    result[table] = rows;
  }
  return result;
}

async function signIn(email: string): Promise<string> {
  const response = await send(
    { method: 'POST', path: '/api/auth/sign-in/email', body: { email, password } },
    'signedOut'
  );
  await expectStatus(response, 200, `sign in ${email}`);
  return responseCookies(response);
}

async function account(name: string): Promise<{ userId: string; cookie: string }> {
  const email = `${name.toLowerCase().replaceAll(' ', '-')}@roles.test`;
  const userId = await seedCredentialAccount(pool, { name, email, password });
  return { userId, cookie: await signIn(email) };
}

let shortNameSequence = 0;
/** A short name no earlier matrix cell has used. */
function freshName(): string {
  shortNameSequence += 1;
  return `roles-name-${shortNameSequence}`;
}

async function setAlphaName(name: string): Promise<void> {
  await ok(
    {
      method: 'PUT',
      path: `/api/v1/host/communities/${alphaId}/short-name`,
      body: { shortName: name },
    },
    'founder',
    200
  );
}

/** Give A a fresh current short name and return it. */
async function nameAlpha(): Promise<string> {
  const name = freshName();
  await setAlphaName(name);
  return name;
}

/** Give A a name, then rename it, and return the name that is now retired. */
async function retiredAlphaName(): Promise<{ name: string }> {
  const name = await nameAlpha();
  await nameAlpha();
  return { name };
}

/** Issue a live key straight into the database, as the offline command would. */
async function offlineKey(): Promise<{ id: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const issued = await issueHostApiKey(client, {
      label: 'Matrix fixture',
      scopes: ['communities:read'],
      expiresAt: null,
      issuer: { kind: 'offline' },
      now: new Date(),
    });
    await client.query('COMMIT');
    return { id: issued.key.id };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * A claimed community already held by its host with a notice date in the past, so a host may
 * delete it. Built in SQL: the matrix proves the deletion route's roles, not the hold's steps.
 */
async function heldPastNotice(): Promise<{ id: string; version: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userId = `held-owner-${randomUUID()}`;
    await client.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [
      userId,
      'Held Owner',
      `${userId}@roles.test`,
    ]);
    const community = await client.query<{ id: string }>(
      "INSERT INTO communities(name,lifecycle) VALUES('Held for deletion','pending_owner') RETURNING id"
    );
    const id = community.rows[0].id;
    await client.query(
      `INSERT INTO members(community_id,user_id,display_name,handle,role)
       VALUES($1,$2,'Held Owner',$3,'owner')`,
      [id, userId, `held-${id.slice(0, 8)}`]
    );
    const held = await client.query<{ lifecycle_version: number }>(
      `UPDATE communities SET lifecycle='held',activated_at=now(),held_from_state='active',
         held_at=now()-interval '30 days',deletion_notice_at=now()-interval '1 day',
         lifecycle_version=3 WHERE id=$1 RETURNING lifecycle_version`,
      [id]
    );
    await client.query('COMMIT');
    return { id, version: held.rows[0].lifecycle_version };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Create a pending community as the first-install host operator and return its claim. */
async function createPending(): Promise<{ id: string; token: string; grantId: string }> {
  pendingSequence += 1;
  const created = (await ok(
    {
      method: 'POST',
      path: '/api/v1/host/communities',
      body: {
        idempotencyKey: `roles-pending-${pendingSequence}`,
        name: `Pending ${pendingSequence}`,
      },
    },
    'founder',
    201
  )) as { community: { id: string }; ownerClaimToken: string; ownerClaimGrantId: string };
  return {
    id: created.community.id,
    token: created.ownerClaimToken,
    grantId: created.ownerClaimGrantId,
  };
}

async function claimCookie(token: string): Promise<string> {
  const response = await send(
    { method: 'POST', path: '/api/v1/owner-claims/preflight', body: { token } },
    'signedOut'
  );
  await expectStatus(response, 200, 'owner claim preflight');
  return responseCookies(response);
}

/** Admit a signed-in account to community A through the real invitation flow. */
async function admit(cookie: string): Promise<string> {
  const { token } = (await ok(
    { method: 'POST', path: scoped('/invites'), body: { seats: 1 } },
    'owner',
    201
  )) as { token: string };
  const preflight = await send(
    { method: 'POST', path: scoped('/invites/preflight'), body: { token } },
    'signedOut'
  );
  await expectStatus(preflight, 200, 'invite preflight');
  const admission = responseCookies(preflight);
  const both = `${cookie}; ${admission}`;
  await expectStatus(
    await send(
      { method: 'POST', path: scoped('/invites/bind'), body: {}, cookie: both },
      'signedOut'
    ),
    200,
    'invite bind'
  );
  const redeemed = await send(
    { method: 'POST', path: scoped('/invites/redeem'), body: {}, cookie: both },
    'signedOut'
  );
  const body = await expectStatus(redeemed, 200, 'invite redeem');
  return (JSON.parse(body.toString('utf8')) as { memberId: string }).memberId;
}

async function freshMember(): Promise<string> {
  const { cookie } = await account(`Target ${randomUUID().slice(0, 8)}`);
  return admit(cookie);
}

/**
 * Enroll an agent for one member of A through the real enrollment route. The personal grant
 * that authorizes enrollment is seeded directly, as the admission tests do, because pairing
 * is not what this file is about.
 */
async function mintAgent(memberId: string): Promise<{ agentId: string; token: string }> {
  const grant = randomToken();
  await pool.query(
    `INSERT INTO connection_grants(community_id,member_id,token_hash,scopes,install_name)
     VALUES($1,$2,$3,'{read,post,enroll-agent}','Role matrix install')`,
    [alphaId, memberId, hashSecret(grant)]
  );
  const response = await fetch(`${baseUrl}${scoped('/agents')}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${grant}`, 'content-type': 'application/json' },
    body: JSON.stringify({ localAgentId: randomUUID(), displayName: 'Matrix agent' }),
  });
  const body = await expectStatus(response, 201, 'agent enrollment');
  const parsed = JSON.parse(body.toString('utf8')) as {
    token: string;
    agent: { memberId: string };
  };
  return { agentId: parsed.agent.memberId, token: parsed.token };
}

/** Keep the agent role backed by a live credential while A is active. */
async function ensureAgentCredential(): Promise<void> {
  if ((await alpha()).lifecycle !== 'active') return;
  const live = await pool.query(
    `SELECT 1 FROM agent_credentials c JOIN agents a ON a.id=c.agent_id
     WHERE c.token_hash=$1 AND c.revoked_at IS NULL AND a.active`,
    [hashSecret(agentToken)]
  );
  if (!live.rowCount) agentToken = (await mintAgent(ownerMemberId)).token;
}

async function ownerLifecycle(action: 'archive' | 'restore'): Promise<void> {
  const current = await alpha();
  await ok(
    {
      method: 'POST',
      path: scoped('/owner/lifecycle'),
      body: {
        action,
        lifecycleVersion: current.lifecycle_version,
        password,
        confirmName: current.name,
      },
    },
    'owner'
  );
}

async function requestDeletion(): Promise<void> {
  const current = await alpha();
  await ok(
    {
      method: 'POST',
      path: scoped('/owner/deletion'),
      body: {
        lifecycleVersion: current.lifecycle_version,
        password,
        confirmName: current.name,
        confirmIdSuffix: alphaId.slice(-8),
      },
    },
    'owner'
  );
}

async function hostLifecycle(action: 'suspend' | 'resume'): Promise<void> {
  await ok(
    {
      method: 'PATCH',
      path: `/api/v1/host/communities/${alphaId}/lifecycle`,
      body: { action, lifecycleVersion: (await alpha()).lifecycle_version },
    },
    'founder'
  );
}

/**
 * Return A to its baseline after every cell: active, owned by the owner, invite-only, and the
 * spare member back to a plain member. Every step uses the public API as the right actor.
 */
async function restoreBaseline(): Promise<void> {
  let current = await alpha();
  if (current.lifecycle === 'suspended') await hostLifecycle('resume');
  current = await alpha();
  if (current.lifecycle === 'deletion_pending') {
    await ok(
      {
        method: 'POST',
        path: scoped('/owner/deletion/cancel'),
        body: { lifecycleVersion: current.lifecycle_version, password },
      },
      'owner'
    );
  }
  if ((await alpha()).lifecycle === 'archived') await ownerLifecycle('restore');
  if ((await roleOf(ownerMemberId)).role !== 'owner') {
    await ok(
      {
        method: 'POST',
        path: scoped('/owner/transfer'),
        body: {
          successorMemberId: ownerMemberId,
          password,
          lifecycleVersion: (await alpha()).lifecycle_version,
        },
      },
      'spare'
    );
  }
  if ((await roleOf(spareMemberId)).role !== 'member') {
    await ok(
      { method: 'PATCH', path: scoped(`/members/${spareMemberId}/role`), body: { role: 'member' } },
      'owner'
    );
  }
  current = await alpha();
  if (current.admission_policy !== 'invite_only') {
    await ok(
      {
        method: 'PATCH',
        path: scoped('/settings'),
        body: { admissionPolicy: 'invite_only' },
        headers: { 'if-match': `"${current.settings_version}"` },
      },
      'owner'
    );
  }
  current = await alpha();
  expect(current.lifecycle).toBe('active');
  expect((await roleOf(ownerMemberId)).role).toBe('owner');
}

const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('matrix-icon')]);

/** Post one message in A as its owner, for a takedown to name. */
async function ownerEntry(): Promise<string> {
  const posted = (await ok(
    {
      method: 'POST',
      path: scoped(`/channels/${moderationChannelId}/entries`),
      body: { text: 'matrix takedown target', idempotencyKey: randomUUID() },
    },
    'owner',
    201
  )) as { entry: { id: string } };
  return posted.entry.id;
}

/** Take down one of A's messages as the host, and return the takedown's id. */
async function hostTakedown(
  category: 'terms_violation' | 'child_safety' = 'terms_violation'
): Promise<{ id: string }> {
  const created = (await ok(
    {
      method: 'POST',
      path: `/api/v1/host/communities/${alphaId}/takedowns`,
      body: {
        idempotencyKey: randomUUID(),
        target: { kind: 'entry', entryId: await ownerEntry() },
        category,
        reference: null,
        password,
      },
    },
    'hostOnly',
    201
  )) as { takedown: { id: string } };
  return { id: created.takedown.id };
}

async function ensureIcon(): Promise<void> {
  const current = await alpha();
  if (current.icon_blob_key) return;
  await ok(
    {
      method: 'PUT',
      path: scoped('/settings/icon'),
      bytes: png,
      headers: { 'if-match': `"${current.settings_version}"`, 'content-type': 'image/png' },
    },
    'owner'
  );
}

const HOST_ROLES = ['hostOnly', 'hostMember'] as const;
const SESSION_ROLES = ROLES.filter((role) => role !== 'signedOut' && role !== 'agent');
const MEMBERS_OF_A = ['owner', 'admin', 'member', 'hostMember'] as const;
const MODERATORS = ['owner', 'admin'] as const;
const OWNER = ['owner'] as const;
// A role that reaches the route's own lookup, rather than failing membership, sees 404 for an
// object it cannot address; the other refusals are role checks.
const notRequester = { admin: 404, member: 404, hostMember: 404 } as const;
// A closed community refuses every new admission with 409, whoever asks.
const closedToEveryone = Object.fromEntries(SESSION_ROLES.map((role) => [role, 409]));

async function closeAdmission(): Promise<void> {
  await ok(
    {
      method: 'PATCH',
      path: scoped('/settings'),
      body: { admissionPolicy: 'closed' },
      headers: { 'if-match': `"${(await alpha()).settings_version}"` },
    },
    'owner'
  );
}

async function createInvite(): Promise<string> {
  const { token } = (await ok(
    { method: 'POST', path: scoped('/invites'), body: { seats: 1 } },
    'owner',
    201
  )) as { token: string };
  return token;
}

async function startJoining(token: string): Promise<string> {
  const preflight = await send(
    { method: 'POST', path: scoped('/invites/preflight'), body: { token } },
    'signedOut'
  );
  await expectStatus(preflight, 200, 'invite preflight');
  return responseCookies(preflight);
}

/**
 * Close admission without the close's own revocation, leaving a live invitation or admission
 * behind. Closing through the API revokes both, so this is the defence-in-depth case: an
 * invitation that somehow survived must still admit no one.
 */
async function closeLeavingInvitations(): Promise<void> {
  await pool.query("UPDATE communities SET admission_policy='closed' WHERE id=$1", [alphaId]);
}

const actions: Action<unknown>[] = [
  // ── Host plane ─────────────────────────────────────────────────────────────
  define({
    rule: 'List host community metadata/state: host operator yes, community roles no',
    route: 'GET /host/communities',
    allowed: HOST_ROLES,
    status: 200,
    call: () => ({ method: 'GET', path: '/api/v1/host/communities' }),
    effect: async (body) => {
      const { communities } = JSON.parse(body.toString('utf8')) as {
        communities: Record<string, unknown>[];
      };
      expect(communities.map((row) => row.id)).toEqual(expect.arrayContaining([alphaId, betaId]));
      for (const row of communities) {
        // Metadata only: no member directory, content counts, or messages.
        expect(Object.keys(row).sort()).toEqual([
          'createdAt',
          'deletionNoticeAt',
          'deletionRequestedBy',
          'deletionState',
          'description',
          'id',
          'lifecycle',
          'lifecycleVersion',
          'name',
          'ownerPresent',
          'settingsVersion',
          'shortName',
        ]);
      }
    },
  }),
  define({
    rule: 'List host community metadata/state: every account sees its own memberships only',
    route: 'GET /memberships',
    allowed: SESSION_ROLES,
    status: 200,
    call: () => ({ method: 'GET', path: '/api/v1/memberships' }),
    effect: async (body, role) => {
      const { memberships } = JSON.parse(body.toString('utf8')) as {
        memberships: { communityId: string }[];
      };
      const own = await pool.query<{ community_id: string }>(
        'SELECT community_id FROM members WHERE user_id=$1 AND active ORDER BY community_id',
        [userIds[role as keyof typeof userIds]]
      );
      expect(memberships.map((row) => row.communityId).sort()).toEqual(
        own.rows.map((row) => row.community_id)
      );
      const inAlpha = (MEMBERS_OF_A as readonly Role[]).includes(role);
      expect(memberships.some((row) => row.communityId === alphaId)).toBe(inAlpha);
    },
  }),
  define({
    rule: 'Read one host community record: host operator yes, community roles no',
    route: 'GET /host/communities/:id',
    allowed: HOST_ROLES,
    status: 200,
    call: () => ({ method: 'GET', path: `/api/v1/host/communities/${alphaId}` }),
    effect: async (body) => {
      const row = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      expect(row.id).toBe(alphaId);
      // The same metadata-only projection as the list.
      expect(Object.keys(row).sort()).toEqual([
        'createdAt',
        'deletionNoticeAt',
        'deletionRequestedBy',
        'deletionState',
        'description',
        'id',
        'lifecycle',
        'lifecycleVersion',
        'name',
        'ownerPresent',
        'settingsVersion',
        'shortName',
      ]);
    },
  }),
  define({
    rule: 'List host API keys: host operator session only; a bearer never manages keys',
    route: 'GET /host/api-keys',
    allowed: HOST_ROLES,
    status: 200,
    refused: { agent: 403 },
    call: () => ({ method: 'GET', path: '/api/v1/host/api-keys' }),
    effect: async (body) => {
      expect(Array.isArray(JSON.parse(body.toString('utf8')).keys)).toBe(true);
    },
  }),
  define({
    rule: 'Issue a host API key: host operator session and password; a bearer never issues keys',
    route: 'POST /host/api-keys',
    allowed: HOST_ROLES,
    status: 201,
    refused: { agent: 403 },
    call: (_prepared, secret) => ({
      method: 'POST',
      path: '/api/v1/host/api-keys',
      body: {
        label: 'Matrix key',
        scopes: ['communities:read'],
        expiresInDays: 30,
        password: secret,
      },
    }),
    effect: async (body, role) => {
      const issued = JSON.parse(body.toString('utf8')) as { key: { id: string }; secret: string };
      const stored = await pool.query(
        'SELECT secret_hash,issued_by_user_id FROM host_api_keys WHERE id=$1',
        [issued.key.id]
      );
      expect(stored.rows).toEqual([
        {
          secret_hash: hashSecret(issued.secret),
          issued_by_user_id: userIds[role as keyof typeof userIds],
        },
      ]);
    },
  }),
  define<{ id: string }>({
    rule: 'Rotate a host API key: host operator session and password; a bearer never rotates keys',
    route: 'POST /host/api-keys/:id/rotate',
    allowed: HOST_ROLES,
    status: 201,
    refused: { agent: 403 },
    prepare: offlineKey,
    call: ({ id }, secret) => ({
      method: 'POST',
      path: `/api/v1/host/api-keys/${id}/rotate`,
      body: { overlapMinutes: 5, password: secret },
    }),
    effect: async (body, _role, { id }) => {
      const rotated = JSON.parse(body.toString('utf8')) as { key: { id: string } };
      expect(rotated.key.id).not.toBe(id);
      const old = await pool.query('SELECT expires_at FROM host_api_keys WHERE id=$1', [id]);
      expect(old.rows[0].expires_at).not.toBeNull();
    },
  }),
  define<{ id: string }>({
    rule: 'Revoke a host API key: any host operator session; a bearer never revokes keys',
    route: 'POST /host/api-keys/:id/revoke',
    allowed: HOST_ROLES,
    status: 200,
    refused: { agent: 403 },
    prepare: offlineKey,
    call: ({ id }) => ({ method: 'POST', path: `/api/v1/host/api-keys/${id}/revoke`, body: {} }),
    effect: async (_body, _role, { id }) => {
      const key = await pool.query('SELECT revoked_at FROM host_api_keys WHERE id=$1', [id]);
      expect(key.rows[0].revoked_at).not.toBeNull();
    },
  }),
  define<{ entryId: string }>({
    rule: 'Take down a message: host operator with their password; no community role',
    route: 'POST /host/communities/:id/takedowns',
    allowed: HOST_ROLES,
    status: 201,
    prepare: async () => ({ entryId: await ownerEntry() }),
    call: ({ entryId }, secret) => ({
      method: 'POST',
      path: `/api/v1/host/communities/${alphaId}/takedowns`,
      body: {
        idempotencyKey: randomUUID(),
        target: { kind: 'entry', entryId },
        category: 'terms_violation',
        reference: null,
        password: secret,
      },
    }),
    effect: async (_body, _role, { entryId }) => {
      const entry = await pool.query('SELECT removed_by FROM entries WHERE id=$1', [entryId]);
      expect(entry.rows).toEqual([{ removed_by: 'host' }]);
    },
  }),
  define({
    rule: 'List takedowns: host operator yes, community roles no',
    route: 'GET /host/takedowns',
    allowed: HOST_ROLES,
    status: 200,
    call: () => ({ method: 'GET', path: '/api/v1/host/takedowns' }),
  }),
  define<{ id: string }>({
    rule: 'Read one takedown: host operator yes, community roles no',
    route: 'GET /host/takedowns/:takedownId',
    allowed: HOST_ROLES,
    status: 200,
    prepare: () => hostTakedown(),
    call: ({ id }) => ({ method: 'GET', path: `/api/v1/host/takedowns/${id}` }),
  }),
  define<{ id: string }>({
    rule: 'Reverse a takedown: only the host reaches it, and a removed message cannot come back',
    route: 'POST /host/takedowns/:takedownId/reverse',
    allowed: HOST_ROLES,
    status: 409,
    prepare: () => hostTakedown(),
    call: ({ id }, secret) => ({
      method: 'POST',
      path: `/api/v1/host/takedowns/${id}/reverse`,
      body: { lifecycleVersion: 1, password: secret },
    }),
  }),
  define<{ id: string }>({
    rule: 'Retry an evidence copy: only the host reaches it, and a host with no store is told so',
    route: 'POST /host/takedowns/:takedownId/evidence/retry',
    allowed: HOST_ROLES,
    status: 409,
    prepare: () => hostTakedown('child_safety'),
    call: ({ id }) => ({
      method: 'POST',
      path: `/api/v1/host/takedowns/${id}/evidence/retry`,
      body: {},
    }),
  }),
  define<{ id: string }>({
    rule: 'Release held content: host operator with their password; no community role',
    route: 'POST /host/takedowns/:takedownId/release-held',
    allowed: HOST_ROLES,
    status: 200,
    prepare: () => hostTakedown('child_safety'),
    call: ({ id }, secret) => ({
      method: 'POST',
      path: `/api/v1/host/takedowns/${id}/release-held`,
      body: { password: secret },
    }),
    effect: async (_body, _role, { id }) => {
      const row = await pool.query('SELECT evidence_state FROM community_takedowns WHERE id=$1', [
        id,
      ]);
      expect(row.rows).toEqual([{ evidence_state: 'not_configured' }]);
    },
  }),
  define<{ version: number }>({
    rule: 'Set community limits: host operator yes, community roles no',
    route: 'PUT /host/communities/:id/limits',
    allowed: HOST_ROLES,
    status: 200,
    prepare: async () => {
      const row = await pool.query<{ limits_version: number }>(
        'SELECT limits_version FROM community_limits WHERE community_id=$1',
        [alphaId]
      );
      return { version: row.rows[0]?.limits_version ?? 1 };
    },
    call: ({ version }) => ({
      method: 'PUT',
      path: `/api/v1/host/communities/${alphaId}/limits`,
      body: { limitsVersion: version, maxActiveMembers: 1_000_000, maxStorageBytes: null },
    }),
    effect: async (_body, _role, { version }) => {
      const row = await pool.query(
        'SELECT max_active_members,limits_version FROM community_limits WHERE community_id=$1',
        [alphaId]
      );
      expect(row.rows).toEqual([{ max_active_members: 1_000_000, limits_version: version + 1 }]);
    },
  }),
  define({
    rule: "Set one member's agent limit: host operator yes, and only the override comes back",
    route: 'PUT /host/communities/:id/members/:memberId/limits',
    allowed: HOST_ROLES,
    status: 200,
    call: () => ({
      method: 'PUT',
      path: `/api/v1/host/communities/${alphaId}/members/${ownerMemberId}/limits`,
      body: { agentsPerMember: 100 },
    }),
    effect: async (body) => {
      const override = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      expect(Object.keys(override).sort()).toEqual([
        'agentsPerMember',
        'communityId',
        'effectiveAgentsPerMember',
        'memberId',
      ]);
    },
  }),
  define({
    rule: 'Read one community usage: host operator yes, community roles no',
    route: 'GET /host/communities/:id/usage',
    allowed: HOST_ROLES,
    status: 200,
    call: () => ({ method: 'GET', path: `/api/v1/host/communities/${alphaId}/usage` }),
    effect: async (body) => {
      expect(JSON.parse(body.toString('utf8')).communityId).toBe(alphaId);
    },
  }),
  define({
    rule: 'Page through every community usage: host operator yes, community roles no',
    route: 'GET /host/usage',
    allowed: HOST_ROLES,
    status: 200,
    call: () => ({ method: 'GET', path: '/api/v1/host/usage?limit=100' }),
    effect: async (body) => {
      const page = JSON.parse(body.toString('utf8')) as { items: { communityId: string }[] };
      expect(page.items.map((item) => item.communityId)).toContain(alphaId);
    },
  }),
  define<{ id: string; version: number }>({
    rule: 'Delete a held community after its notice date: host operator only',
    route: 'POST /host/communities/:id/deletion',
    allowed: HOST_ROLES,
    status: 200,
    prepare: heldPastNotice,
    call: ({ id, version }) => ({
      method: 'POST',
      path: `/api/v1/host/communities/${id}/deletion`,
      body: { lifecycleVersion: version, confirmIdSuffix: id.slice(-8) },
    }),
    effect: async (_body, _role, { id }) => {
      const row = await pool.query(
        'SELECT lifecycle,delete_requested_by_host_actor IS NOT NULL AS host FROM communities WHERE id=$1',
        [id]
      );
      expect(row.rows).toEqual([{ lifecycle: 'deletion_pending', host: true }]);
    },
  }),
  define<{ id: string }>({
    rule: 'Cancel a host-started deletion: host operator only',
    route: 'DELETE /host/communities/:id/deletion',
    allowed: HOST_ROLES,
    status: 200,
    prepare: async () => {
      const held = await heldPastNotice();
      await ok(
        {
          method: 'POST',
          path: `/api/v1/host/communities/${held.id}/deletion`,
          body: { lifecycleVersion: held.version, confirmIdSuffix: held.id.slice(-8) },
        },
        'founder',
        200
      );
      return { id: held.id };
    },
    call: ({ id }) => ({ method: 'DELETE', path: `/api/v1/host/communities/${id}/deletion` }),
    effect: async (_body, _role, { id }) => {
      const row = await pool.query('SELECT lifecycle FROM communities WHERE id=$1', [id]);
      expect(row.rows).toEqual([{ lifecycle: 'held' }]);
    },
  }),
  define<{ name: string }>({
    rule: 'Look up a community by its short name: anyone, signed in or not',
    route: 'GET /community-names/:name',
    allowed: ROLES,
    status: 200,
    prepare: async () => ({ name: await nameAlpha() }),
    call: ({ name }) => ({ method: 'GET', path: `/api/v1/community-names/${name}` }),
    effect: async (body) => {
      expect(JSON.parse(body.toString('utf8')).communityId).toBe(alphaId);
    },
  }),
  define({
    rule: 'Check whether a short name is free: host operator only',
    route: 'GET /host/short-names/:name',
    allowed: HOST_ROLES,
    status: 200,
    call: () => ({ method: 'GET', path: '/api/v1/host/short-names/free-name' }),
    effect: async (body) => {
      expect(JSON.parse(body.toString('utf8')).availability).toBe('available');
    },
  }),
  define({
    rule: "Read a community's short names: host operator only",
    route: 'GET /host/communities/:id/short-names',
    allowed: HOST_ROLES,
    status: 200,
    call: () => ({ method: 'GET', path: `/api/v1/host/communities/${alphaId}/short-names` }),
    effect: async (body) => {
      expect(JSON.parse(body.toString('utf8')).communityId).toBe(alphaId);
    },
  }),
  define<{ name: string }>({
    rule: "Set a community's short name: host operator only",
    route: 'PUT /host/communities/:id/short-name',
    allowed: HOST_ROLES,
    status: 200,
    prepare: async () => ({ name: freshName() }),
    call: ({ name }) => ({
      method: 'PUT',
      path: `/api/v1/host/communities/${alphaId}/short-name`,
      body: { shortName: name },
    }),
    effect: async (body, _role, { name }) => {
      expect(JSON.parse(body.toString('utf8')).shortName).toBe(name);
    },
  }),
  define<{ name: string }>({
    rule: 'Release a retired short name: host operator only',
    route: 'DELETE /host/communities/:id/short-names/:name',
    allowed: HOST_ROLES,
    status: 204,
    prepare: retiredAlphaName,
    call: ({ name }) => ({
      method: 'DELETE',
      path: `/api/v1/host/communities/${alphaId}/short-names/${name}`,
    }),
    effect: async (_body, _role, { name }) => {
      expect(
        (await pool.query('SELECT 1 FROM community_short_names WHERE short_name=$1', [name]))
          .rowCount
      ).toBe(0);
    },
  }),
  define<{ name: string }>({
    rule: 'Lift the cool-off on a released short name: host operator only',
    route: 'DELETE /host/short-name-holds/:name',
    allowed: HOST_ROLES,
    status: 204,
    prepare: async () => {
      const { name } = await retiredAlphaName();
      await ok(
        { method: 'DELETE', path: `/api/v1/host/communities/${alphaId}/short-names/${name}` },
        'founder',
        204
      );
      return { name };
    },
    call: ({ name }) => ({ method: 'DELETE', path: `/api/v1/host/short-name-holds/${name}` }),
  }),
  define<{ key: string }>({
    rule: 'Create a pending_owner community: host operator yes, owner only if also host operator',
    route: 'POST /host/communities',
    allowed: HOST_ROLES,
    status: 201,
    prepare: async () => ({ key: `roles-create-${randomUUID()}` }),
    call: ({ key }) => ({
      method: 'POST',
      path: '/api/v1/host/communities',
      body: { idempotencyKey: key, name: 'Created by matrix' },
    }),
    effect: async (body, _role, { key }) => {
      const created = JSON.parse(body.toString('utf8')) as { community: { id: string } };
      const receipt = await pool.query(
        `SELECT c.lifecycle FROM community_creation_receipts r JOIN communities c ON c.id=r.community_id
         WHERE r.idempotency_key=$1 AND c.id=$2`,
        [key, created.community.id]
      );
      expect(receipt.rows).toEqual([{ lifecycle: 'pending_owner' }]);
    },
  }),
  define<{ id: string; grantId: string }>({
    rule: 'Issue a pending-owner claim: host operator only',
    route: 'POST /host/communities/:id/owner-claims/reissue',
    allowed: HOST_ROLES,
    status: 200,
    prepare: createPending,
    call: ({ id }) => ({
      method: 'POST',
      path: `/api/v1/host/communities/${id}/owner-claims/reissue`,
      body: {},
    }),
    effect: async (_body, _role, { id, grantId }) => {
      const grants = await pool.query<{ id: string; revoked: boolean }>(
        `SELECT id,revoked_at IS NOT NULL AS revoked FROM bootstrap_grants
         WHERE community_id=$1 AND purpose='owner_claim'`,
        [id]
      );
      expect(grants.rows).toHaveLength(2);
      expect(grants.rows.find((row) => row.id === grantId)?.revoked).toBe(true);
    },
  }),
  define<{ id: string; grantId: string }>({
    rule: 'Revoke a pending-owner claim: host operator only',
    route: 'POST /host/communities/:id/owner-claims/:grantId/revoke',
    allowed: HOST_ROLES,
    status: 204,
    prepare: createPending,
    call: ({ id, grantId }) => ({
      method: 'POST',
      path: `/api/v1/host/communities/${id}/owner-claims/${grantId}/revoke`,
      body: {},
    }),
    effect: async (_body, _role, { grantId }) => {
      const grant = await pool.query('SELECT revoked_at FROM bootstrap_grants WHERE id=$1', [
        grantId,
      ]);
      expect(grant.rows[0].revoked_at).not.toBeNull();
    },
  }),
  define<{ id: string }>({
    rule: 'Delete an unclaimed pending_owner community: host operator only',
    route: 'DELETE /host/communities/:id',
    allowed: HOST_ROLES,
    status: 204,
    prepare: async () => {
      const pending = await createPending();
      await ok(
        {
          method: 'POST',
          path: `/api/v1/host/communities/${pending.id}/owner-claims/${pending.grantId}/revoke`,
          body: {},
        },
        'founder',
        204
      );
      return pending;
    },
    call: ({ id }) => ({ method: 'DELETE', path: `/api/v1/host/communities/${id}` }),
    effect: async (_body, _role, { id }) => {
      expect((await pool.query('SELECT 1 FROM communities WHERE id=$1', [id])).rowCount).toBe(0);
    },
  }),
  define<{ version: number }>({
    rule: 'Suspend: host operator only; owner and admin cannot',
    route: 'PATCH /host/communities/:id/lifecycle',
    variant: 'suspend',
    allowed: HOST_ROLES,
    status: 200,
    prepare: async () => ({ version: (await alpha()).lifecycle_version }),
    call: ({ version }) => ({
      method: 'PATCH',
      path: `/api/v1/host/communities/${alphaId}/lifecycle`,
      body: { action: 'suspend', lifecycleVersion: version },
    }),
    effect: async () => {
      expect((await alpha()).lifecycle).toBe('suspended');
    },
  }),
  define<{ version: number }>({
    rule: 'Resume: host operator only; owner and admin cannot',
    route: 'PATCH /host/communities/:id/lifecycle',
    variant: 'resume',
    allowed: HOST_ROLES,
    status: 200,
    prepare: async () => {
      await hostLifecycle('suspend');
      return { version: (await alpha()).lifecycle_version };
    },
    call: ({ version }) => ({
      method: 'PATCH',
      path: `/api/v1/host/communities/${alphaId}/lifecycle`,
      body: { action: 'resume', lifecycleVersion: version },
    }),
    effect: async () => {
      expect((await alpha()).lifecycle).toBe('active');
    },
  }),
  define<{ token: string }>({
    rule: 'Open an owner claim: the one-time claim token is the authority, whoever sends it',
    route: 'POST /owner-claims/preflight',
    allowed: ROLES,
    status: 200,
    prepare: async () => ({ token: (await createPending()).token }),
    call: ({ token }) => ({
      method: 'POST',
      path: '/api/v1/owner-claims/preflight',
      body: { token },
    }),
    effect: async (body) => {
      expect(JSON.parse(body.toString('utf8'))).toMatchObject({ granted: true });
    },
  }),
  define<{ id: string; cookie: string }>({
    rule: 'Redeem an owner claim: any signed-in host account holding the claim',
    route: 'POST /owner-claims/claim',
    allowed: SESSION_ROLES,
    status: 200,
    prepare: async () => {
      const pending = await createPending();
      return { id: pending.id, cookie: await claimCookie(pending.token) };
    },
    call: ({ cookie }) => ({
      method: 'POST',
      path: '/api/v1/owner-claims/claim',
      body: {},
      cookie,
    }),
    effect: async (_body, role, { id }) => {
      const owner = await pool.query(
        `SELECT m.user_id,c.lifecycle FROM members m JOIN communities c ON c.id=m.community_id
         WHERE m.community_id=$1 AND m.role='owner' AND m.active`,
        [id]
      );
      expect(owner.rows).toEqual([
        { user_id: userIds[role as keyof typeof userIds], lifecycle: 'active' },
      ]);
    },
  }),
  define({
    rule: 'Icon download: a visible membership or host metadata permission',
    route: 'GET /icon',
    allowed: [...MEMBERS_OF_A, 'hostOnly'],
    status: 200,
    prepare: ensureIcon,
    call: () => ({ method: 'GET', path: scoped('/icon') }),
    effect: async (body) => {
      expect(body.equals(png)).toBe(true);
    },
  }),

  // ── Community settings ─────────────────────────────────────────────────────
  define({
    rule: 'Read the settings projection: members by existing rules, never by host role alone',
    route: 'GET /settings',
    allowed: MEMBERS_OF_A,
    status: 200,
    call: () => ({ method: 'GET', path: scoped('/settings') }),
    effect: async (body) => {
      expect(JSON.parse(body.toString('utf8'))).toMatchObject({ communityId: alphaId });
    },
  }),
  define<{ version: number; name: string }>({
    rule: 'Edit name: owner only',
    route: 'PATCH /settings',
    variant: 'name',
    allowed: OWNER,
    status: 200,
    prepare: async () => ({
      version: (await alpha()).settings_version,
      name: `Alpha ${randomUUID().slice(0, 6)}`,
    }),
    call: ({ version, name }) => ({
      method: 'PATCH',
      path: scoped('/settings'),
      body: { name },
      headers: { 'if-match': `"${version}"` },
    }),
    effect: async (_body, _role, { name }) => {
      expect((await alpha()).name).toBe(name);
    },
  }),
  define<{ version: number }>({
    rule: 'Edit admission policy: owner only',
    route: 'PATCH /settings',
    variant: 'admission policy',
    allowed: OWNER,
    status: 200,
    prepare: async () => ({ version: (await alpha()).settings_version }),
    call: ({ version }) => ({
      method: 'PATCH',
      path: scoped('/settings'),
      body: { admissionPolicy: 'closed' },
      headers: { 'if-match': `"${version}"` },
    }),
    effect: async () => {
      expect((await alpha()).admission_policy).toBe('closed');
    },
  }),
  define<{ version: number; description: string }>({
    rule: 'Edit description: owner and admin',
    route: 'PATCH /settings',
    variant: 'description',
    allowed: MODERATORS,
    status: 200,
    prepare: async () => ({
      version: (await alpha()).settings_version,
      description: `Described ${randomUUID()}`,
    }),
    call: ({ version, description }) => ({
      method: 'PATCH',
      path: scoped('/settings'),
      body: { description },
      headers: { 'if-match': `"${version}"` },
    }),
    effect: async (_body, _role, { description }) => {
      expect((await alpha()).description).toBe(description);
    },
  }),
  define<{ version: number; before: string | null }>({
    rule: 'Replace the icon: owner and admin',
    route: 'PUT /settings/icon',
    allowed: MODERATORS,
    status: 200,
    prepare: async () => {
      const current = await alpha();
      return { version: current.settings_version, before: current.icon_blob_key };
    },
    call: ({ version }) => ({
      method: 'PUT',
      path: scoped('/settings/icon'),
      bytes: png,
      headers: { 'if-match': `"${version}"`, 'content-type': 'image/png' },
    }),
    effect: async (_body, _role, { before }) => {
      const after = (await alpha()).icon_blob_key;
      expect(after).not.toBeNull();
      expect(after).not.toBe(before);
    },
  }),
  define<{ version: number }>({
    rule: 'Clear the icon: owner and admin',
    route: 'DELETE /settings/icon',
    allowed: MODERATORS,
    status: 200,
    prepare: async () => {
      await ensureIcon();
      return { version: (await alpha()).settings_version };
    },
    call: ({ version }) => ({
      method: 'DELETE',
      path: scoped('/settings/icon'),
      headers: { 'if-match': `"${version}"` },
    }),
    effect: async () => {
      expect((await alpha()).icon_blob_key).toBeNull();
    },
  }),

  // ── Owner lifecycle ────────────────────────────────────────────────────────
  define<{ version: number }>({
    rule: 'Transfer ownership: owner only, with reauthentication',
    route: 'POST /owner/transfer',
    allowed: OWNER,
    status: 200,
    reauth: true,
    prepare: async () => ({ version: (await alpha()).lifecycle_version }),
    call: ({ version }, secret) => ({
      method: 'POST',
      path: scoped('/owner/transfer'),
      body: { successorMemberId: spareMemberId, password: secret, lifecycleVersion: version },
    }),
    effect: async () => {
      expect((await roleOf(spareMemberId)).role).toBe('owner');
      expect((await roleOf(ownerMemberId)).role).toBe('member');
    },
  }),
  define<{ version: number; name: string }>({
    rule: 'Archive: owner only, with reauthentication',
    route: 'POST /owner/lifecycle',
    variant: 'archive',
    allowed: OWNER,
    status: 200,
    reauth: true,
    prepare: async () => {
      const current = await alpha();
      return { version: current.lifecycle_version, name: current.name };
    },
    call: ({ version, name }, secret) => ({
      method: 'POST',
      path: scoped('/owner/lifecycle'),
      body: { action: 'archive', lifecycleVersion: version, password: secret, confirmName: name },
    }),
    effect: async () => {
      expect((await alpha()).lifecycle).toBe('archived');
    },
  }),
  define<{ version: number }>({
    rule: 'Restore: owner only, with reauthentication',
    route: 'POST /owner/lifecycle',
    variant: 'restore',
    allowed: OWNER,
    status: 200,
    reauth: true,
    prepare: async () => {
      await ownerLifecycle('archive');
      return { version: (await alpha()).lifecycle_version };
    },
    call: ({ version }, secret) => ({
      method: 'POST',
      path: scoped('/owner/lifecycle'),
      body: { action: 'restore', lifecycleVersion: version, password: secret },
    }),
    effect: async () => {
      expect((await alpha()).lifecycle).toBe('active');
    },
  }),
  define({
    rule: 'Read deletion status: owner only',
    route: 'GET /owner/deletion',
    allowed: OWNER,
    status: 200,
    call: () => ({ method: 'GET', path: scoped('/owner/deletion') }),
    effect: async (body) => {
      expect(JSON.parse(body.toString('utf8'))).toMatchObject({
        communityId: alphaId,
        lifecycle: 'active',
      });
    },
  }),
  define<{ version: number; name: string }>({
    rule: 'Request permanent deletion: owner only, with reauthentication',
    route: 'POST /owner/deletion',
    allowed: OWNER,
    status: 200,
    reauth: true,
    prepare: async () => {
      const current = await alpha();
      return { version: current.lifecycle_version, name: current.name };
    },
    call: ({ version, name }, secret) => ({
      method: 'POST',
      path: scoped('/owner/deletion'),
      body: {
        lifecycleVersion: version,
        password: secret,
        confirmName: name,
        confirmIdSuffix: alphaId.slice(-8),
      },
    }),
    effect: async () => {
      expect((await alpha()).lifecycle).toBe('deletion_pending');
      const job = await pool.query(
        'SELECT state FROM community_deletion_jobs WHERE community_id=$1',
        [alphaId]
      );
      expect(job.rows).toEqual([{ state: 'waiting' }]);
    },
  }),
  define<{ version: number }>({
    rule: 'Cancel permanent deletion: the requesting owner only, with reauthentication',
    route: 'POST /owner/deletion/cancel',
    allowed: OWNER,
    status: 200,
    reauth: true,
    prepare: async () => {
      await requestDeletion();
      return { version: (await alpha()).lifecycle_version };
    },
    call: ({ version }, secret) => ({
      method: 'POST',
      path: scoped('/owner/deletion/cancel'),
      body: { lifecycleVersion: version, password: secret },
    }),
    effect: async () => {
      expect((await alpha()).lifecycle).toBe('archived');
      const job = await pool.query('SELECT 1 FROM community_deletion_jobs WHERE community_id=$1', [
        alphaId,
      ]);
      expect(job.rowCount).toBe(0);
    },
  }),
  define({
    rule: 'Owner export: owner only, with reauthentication',
    route: 'POST /owner/export',
    allowed: OWNER,
    status: 201,
    reauth: true,
    call: (_prepared, secret) => ({
      method: 'POST',
      path: scoped('/owner/export'),
      body: { password: secret },
    }),
    effect: async (body) => {
      const { archiveId } = JSON.parse(body.toString('utf8')) as { archiveId: string };
      const archive = await pool.query(
        'SELECT scope,community_id FROM export_archives WHERE id=$1',
        [archiveId]
      );
      expect(archive.rows).toEqual([{ scope: 'owner', community_id: alphaId }]);
    },
  }),
  define<{ archiveId: string }>({
    rule: 'Download an owner export: its owner requester only',
    route: 'GET /exports/:id',
    allowed: OWNER,
    status: 200,
    refused: notRequester,
    prepare: async () => {
      const existing = await pool.query<{ id: string }>(
        `SELECT id FROM export_archives WHERE community_id=$1 AND scope='owner'
           AND requester_member_id=$2 AND deleted_at IS NULL AND expires_at>now()
         ORDER BY created_at LIMIT 1`,
        [alphaId, ownerMemberId]
      );
      if (existing.rows[0]) return { archiveId: existing.rows[0].id };
      const created = (await ok(
        { method: 'POST', path: scoped('/owner/export'), body: { password } },
        'owner',
        201
      )) as { archiveId: string };
      return { archiveId: created.archiveId };
    },
    call: ({ archiveId }) => ({ method: 'GET', path: scoped(`/exports/${archiveId}`) }),
    effect: async (body) => {
      // A zip archive starts with the local file header signature.
      expect(body.subarray(0, 4).toString('hex')).toBe('504b0304');
    },
  }),

  // ── Member, invitation, agent and channel duties (existing rules) ─────────
  define({
    rule: 'Member directory: owner and admin by existing rules',
    route: 'GET /members',
    allowed: MODERATORS,
    status: 200,
    call: () => ({ method: 'GET', path: scoped('/members') }),
    effect: async (body) => {
      const { members } = JSON.parse(body.toString('utf8')) as { members: { memberId: string }[] };
      expect(members.map((row) => row.memberId)).toContain(ownerMemberId);
    },
  }),
  define({
    rule: 'Change a member role: owner only',
    route: 'PATCH /members/:id/role',
    allowed: OWNER,
    status: 200,
    call: () => ({
      method: 'PATCH',
      path: scoped(`/members/${spareMemberId}/role`),
      body: { role: 'admin' },
    }),
    effect: async () => {
      expect((await roleOf(spareMemberId)).role).toBe('admin');
    },
  }),
  define<{ target: string }>({
    rule: 'Remove a member: owner and admin (admin only plain members)',
    route: 'DELETE /members/:id',
    allowed: MODERATORS,
    status: 204,
    prepare: async () => ({ target: await freshMember() }),
    call: ({ target }) => ({ method: 'DELETE', path: scoped(`/members/${target}`) }),
    effect: async (_body, _role, { target }) => {
      expect((await roleOf(target)).active).toBe(false);
    },
  }),
  define({
    rule: 'Create an invitation: owner and admin',
    route: 'POST /invites',
    allowed: MODERATORS,
    status: 201,
    call: () => ({ method: 'POST', path: scoped('/invites'), body: { seats: 1 } }),
    effect: async (body) => {
      const { invite } = JSON.parse(body.toString('utf8')) as { invite: { id: string } };
      const row = await pool.query('SELECT community_id FROM invites WHERE id=$1', [invite.id]);
      expect(row.rows).toEqual([{ community_id: alphaId }]);
    },
  }),
  define({
    rule: 'List invitations: owner and admin',
    route: 'GET /invites',
    allowed: MODERATORS,
    status: 200,
    call: () => ({ method: 'GET', path: scoped('/invites') }),
    effect: async (body) => {
      const { invites } = JSON.parse(body.toString('utf8')) as { invites: unknown[] };
      expect(invites.length).toBeGreaterThan(0);
    },
  }),
  define<{ inviteId: string }>({
    rule: 'Revoke an invitation: owner and admin',
    route: 'DELETE /invites/:id',
    allowed: MODERATORS,
    status: 204,
    prepare: async () => {
      const created = (await ok(
        { method: 'POST', path: scoped('/invites'), body: { seats: 1 } },
        'owner',
        201
      )) as { invite: { id: string } };
      return { inviteId: created.invite.id };
    },
    call: ({ inviteId }) => ({ method: 'DELETE', path: scoped(`/invites/${inviteId}`) }),
    effect: async (_body, _role, { inviteId }) => {
      const row = await pool.query('SELECT revoked_at FROM invites WHERE id=$1', [inviteId]);
      expect(row.rows[0].revoked_at).not.toBeNull();
    },
  }),
  define<{ agentId: string }>({
    rule: "Remove another member's agent: owner and admin",
    route: 'DELETE /agents/:id',
    allowed: MODERATORS,
    status: 204,
    prepare: async () => ({ agentId: (await mintAgent(spareMemberId)).agentId }),
    call: ({ agentId }) => ({ method: 'DELETE', path: scoped(`/agents/${agentId}`) }),
    effect: async (_body, _role, { agentId }) => {
      const row = await pool.query('SELECT active FROM agents WHERE id=$1', [agentId]);
      expect(row.rows).toEqual([{ active: false }]);
    },
  }),
  define<{ agentId: string }>({
    rule: "Place another member's agent in a channel: owner and admin",
    route: 'POST /channels/:id/agents',
    allowed: MODERATORS,
    status: 200,
    prepare: async () => ({ agentId: (await mintAgent(spareMemberId)).agentId }),
    call: ({ agentId }) => ({
      method: 'POST',
      path: scoped(`/channels/${moderationChannelId}/agents`),
      body: { agentId },
    }),
    effect: async (_body, _role, { agentId }) => {
      const row = await pool.query(
        'SELECT 1 FROM agent_channel_members WHERE channel_id=$1 AND agent_id=$2',
        [moderationChannelId, agentId]
      );
      expect(row.rowCount).toBe(1);
    },
  }),
  define<{ agentId: string }>({
    rule: "Remove another member's agent from a channel: owner and admin",
    route: 'DELETE /channels/:id/agents/:agentId',
    allowed: MODERATORS,
    status: 204,
    prepare: async () => {
      const { agentId } = await mintAgent(spareMemberId);
      await ok(
        {
          method: 'POST',
          path: scoped(`/channels/${moderationChannelId}/agents`),
          body: { agentId },
        },
        'owner'
      );
      return { agentId };
    },
    call: ({ agentId }) => ({
      method: 'DELETE',
      path: scoped(`/channels/${moderationChannelId}/agents/${agentId}`),
    }),
    effect: async (_body, _role, { agentId }) => {
      const row = await pool.query(
        'SELECT 1 FROM agent_channel_members WHERE channel_id=$1 AND agent_id=$2',
        [moderationChannelId, agentId]
      );
      expect(row.rowCount).toBe(0);
    },
  }),
  define<{ name: string }>({
    rule: 'Create a channel: owner and admin',
    route: 'POST /channels',
    allowed: MODERATORS,
    status: 201,
    prepare: async () => ({ name: `matrix-${randomUUID().slice(0, 8)}` }),
    call: ({ name }) => ({
      method: 'POST',
      path: scoped('/channels'),
      body: { name, visibility: 'public' },
    }),
    effect: async (_body, _role, { name }) => {
      const row = await pool.query('SELECT 1 FROM channels WHERE community_id=$1 AND name=$2', [
        alphaId,
        name,
      ]);
      expect(row.rowCount).toBe(1);
    },
  }),
  define<{ description: string }>({
    rule: 'Edit a channel: owner and admin',
    route: 'PATCH /channels/:id',
    allowed: MODERATORS,
    status: 200,
    prepare: async () => ({ description: `Channel ${randomUUID()}` }),
    call: ({ description }) => ({
      method: 'PATCH',
      path: scoped(`/channels/${moderationChannelId}`),
      body: { description },
    }),
    effect: async (_body, _role, { description }) => {
      const row = await pool.query('SELECT description FROM channels WHERE id=$1', [
        moderationChannelId,
      ]);
      expect(row.rows).toEqual([{ description }]);
    },
  }),
  define({
    rule: 'Add a member to a channel: owner and admin',
    route: 'POST /channels/:id/members',
    allowed: MODERATORS,
    status: 200,
    prepare: async () => {
      await ok(
        {
          method: 'DELETE',
          path: scoped(`/channels/${moderationChannelId}/members/${spareMemberId}`),
        },
        'owner'
      );
    },
    call: () => ({
      method: 'POST',
      path: scoped(`/channels/${moderationChannelId}/members`),
      body: { memberId: spareMemberId },
    }),
    effect: async () => {
      const row = await pool.query(
        'SELECT 1 FROM channel_members WHERE channel_id=$1 AND member_id=$2',
        [moderationChannelId, spareMemberId]
      );
      expect(row.rowCount).toBe(1);
    },
  }),
  define({
    rule: 'Remove a member from a channel: owner and admin',
    route: 'DELETE /channels/:id/members/:memberId',
    allowed: MODERATORS,
    status: 200,
    prepare: async () => {
      await ok(
        {
          method: 'POST',
          path: scoped(`/channels/${moderationChannelId}/members`),
          body: { memberId: spareMemberId },
        },
        'owner'
      );
    },
    call: () => ({
      method: 'DELETE',
      path: scoped(`/channels/${moderationChannelId}/members/${spareMemberId}`),
    }),
    effect: async () => {
      const row = await pool.query(
        'SELECT 1 FROM channel_members WHERE channel_id=$1 AND member_id=$2',
        [moderationChannelId, spareMemberId]
      );
      expect(row.rowCount).toBe(0);
    },
  }),
  // ── A closed community admits no one new ──────────────────────────────────
  define({
    rule: 'Create an invitation while closed: refused for everyone',
    route: 'POST /invites',
    variant: 'closed community',
    allowed: [],
    status: 201,
    refused: { owner: 409, admin: 409 },
    prepare: closeAdmission,
    call: () => ({ method: 'POST', path: scoped('/invites'), body: { seats: 1 } }),
  }),
  define<{ token: string }>({
    rule: 'Preview a surviving invitation while closed: refused for everyone',
    route: 'POST /invites/preview',
    variant: 'closed community',
    allowed: [],
    status: 200,
    refused: { ...closedToEveryone, signedOut: 409, agent: 409 },
    prepare: async () => {
      const token = await createInvite();
      await closeLeavingInvitations();
      return { token };
    },
    call: ({ token }) => ({ method: 'POST', path: scoped('/invites/preview'), body: { token } }),
  }),
  define<{ token: string }>({
    rule: 'Start joining with a surviving invitation while closed: refused for everyone',
    route: 'POST /invites/preflight',
    variant: 'closed community',
    allowed: [],
    status: 200,
    refused: { ...closedToEveryone, signedOut: 409, agent: 409 },
    prepare: async () => {
      const token = await createInvite();
      await closeLeavingInvitations();
      return { token };
    },
    call: ({ token }) => ({ method: 'POST', path: scoped('/invites/preflight'), body: { token } }),
  }),
  define<{ cookie: string }>({
    rule: 'Bind a surviving join attempt while closed: refused for everyone',
    route: 'POST /invites/bind',
    variant: 'closed community',
    allowed: [],
    status: 200,
    refused: closedToEveryone,
    prepare: async () => {
      const cookie = await startJoining(await createInvite());
      await closeLeavingInvitations();
      return { cookie };
    },
    call: ({ cookie }) => ({ method: 'POST', path: scoped('/invites/bind'), body: {}, cookie }),
  }),
  define<{ cookie: string }>({
    rule: 'Resume a surviving join attempt while closed: refused for everyone',
    route: 'GET /invites/pending',
    variant: 'closed community',
    allowed: [],
    status: 200,
    refused: { ...closedToEveryone, signedOut: 409, agent: 409 },
    prepare: async () => {
      const cookie = await startJoining(await createInvite());
      await closeLeavingInvitations();
      return { cookie };
    },
    call: ({ cookie }) => ({ method: 'GET', path: scoped('/invites/pending'), cookie }),
  }),
  define<{ cookie: string; userId: string }>({
    rule: 'Redeem a surviving, bound join attempt while closed: refused, and no one is admitted',
    route: 'POST /invites/redeem',
    variant: 'closed community',
    allowed: [],
    status: 200,
    refused: closedToEveryone,
    prepare: async (role) => {
      const admission = await startJoining(await createInvite());
      // Each role joins as itself; a caller with no session binds a throwaway account.
      let session: string;
      let userId: string;
      if (role === 'signedOut' || role === 'agent') {
        const person = await account(`Joiner ${randomUUID().slice(0, 8)}`);
        session = person.cookie;
        userId = person.userId;
      } else {
        session = sessions[role];
        userId = userIds[role];
      }
      await expectStatus(
        await send(
          {
            method: 'POST',
            path: scoped('/invites/bind'),
            body: {},
            cookie: `${session}; ${admission}`,
          },
          'signedOut'
        ),
        200,
        'invite bind'
      );
      await closeLeavingInvitations();
      return { cookie: admission, userId };
    },
    call: ({ cookie }) => ({ method: 'POST', path: scoped('/invites/redeem'), body: {}, cookie }),
  }),
];

/**
 * Every other registered route, with the reason it is not an administration action. A new
 * route must be added to the matrix or here before this file passes.
 */
const OUTSIDE_ADMINISTRATION: Record<string, string> = {
  'POST /bootstrap/preflight': 'first installation; runs once on an empty host',
  'POST /bootstrap/complete': 'first installation; runs once on an empty host',
  'GET /community': 'public name and description of the URL community',
  'GET /auth-options': 'public sign-in options',
  'GET /host-links': "the host's public terms, privacy and report links",
  'GET /me': "the caller's own membership",
  'POST /me/leave': 'the caller leaves; no authority over anyone else',
  'POST /me/export': "the caller's personal export",
  'GET /me/grants': "the caller's own installation grants",
  'DELETE /me/grants': "revokes the caller's own grants",
  'DELETE /me/grants/:id': "revokes one of the caller's own grants",
  'GET /me/connection-access': 'the calling grant only',
  'DELETE /me/connection': 'the calling grant revokes itself',
  'GET /me/host-access': "the calling grant's own account; takes no id",
  'GET /channels': 'ordinary reading; visible channels only',
  'GET /channels/:id': 'ordinary reading',
  'POST /channels/:id/join': 'the caller joins a public channel',
  'POST /channels/:id/leave': 'the caller leaves a channel',
  'GET /channels/:id/members': 'ordinary reading of a joined channel',
  'POST /channels/:id/entries': 'ordinary posting',
  'GET /channels/:id/entries': 'ordinary reading',
  'GET /channels/:id/events': 'ordinary live stream',
  'GET /channels/:id/threads': 'ordinary reading of reply counts',
  'GET /channels/:id/read-cursor': "the caller's own read position",
  'PUT /channels/:id/read-cursor': "the caller's own read position",
  'GET /attention': "the caller's own unread counts",
  'POST /channels/:id/attachments': 'ordinary upload',
  'GET /attachments/:id': 'ordinary reading',
  'DELETE /entries/:entryId':
    "the caller's own message, or one ranked below them; content-removal.integration.test.ts",
  'DELETE /attachments/:attachmentId':
    "the caller's own file, or one ranked below them; content-removal.integration.test.ts",
  'GET /agents': "the caller's own agents",
  'POST /agents': 'the caller enrolls their own agent',
  'POST /agents/recover': "the caller recovers their own agent's credential",
  'POST /agents/:id/rotate': "the caller rotates their own agent's credential",
  'POST /pairings/start': 'a local install asks to connect',
  'GET /pairings/:id': 'the caller reviews their own pairing',
  'POST /pairings/approve': 'the caller approves their own pairing',
  'POST /pairings/decline': 'the caller declines their own pairing',
  'POST /pairings/poll': 'a local install polls its own pairing',
  'POST /pairings/exchange': 'a local install exchanges its own pairing',
  'POST /pairings/cancel': 'a local install cancels its own pairing',
  'GET /account/former-memberships': "the caller's own former memberships",
  'GET /account/erasures': "the caller's own erasure requests",
  'POST /account/erasures': 'the caller erases their own membership or account',
  'POST /account/erasures/:id/cancel': 'the caller cancels their own erasure',
  'GET /owner/erasures':
    'completed self-erasures only; member-erasure.integration.test.ts covers who may read it',
  'GET /takedowns':
    "the host's reasons: moderators see every one told, others their own; host-takedown.integration.test.ts",
};

function refusalStatus(action: Action<unknown>, role: Role): number {
  return action.refused?.[role] ?? (role === 'signedOut' || role === 'agent' ? 401 : 403);
}

function labelOf(action: Action<unknown>): string {
  return action.variant ? `${action.route} (${action.variant})` : action.route;
}

beforeAll(async () => {
  storagePath = await mkdtemp(join(tmpdir(), 'community-admin-roles-'));
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  pool = new Pool({ connectionString: dbUrl.toString() });
  config = parseConfig({
    COMMUNITY_DATABASE_URL: dbUrl.toString(),
    COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
    COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
    COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
    COMMUNITY_PUBLIC_URL: origin,
    COMMUNITY_STORAGE_PATH: storagePath,
    COMMUNITY_AGENTS_PER_OWNER: '100',
    COMMUNITY_HOST_KEY_ATTEMPTS_PER_MINUTE: '100',
    // One owner makes every route's wrong-password case within a minute; the limit itself is
    // proven in account-controls.integration.test.ts.
    COMMUNITY_REAUTH_ATTEMPTS_PER_MINUTE: '20',
  });
  app = createCommunityApp({
    config,
    pool,
    blobStore: new FileSystemBlobStore(storagePath),
    // Every admission here comes from one test peer; the per-peer preview limit is not under test.
    hooks: { invitePreviewPeer: () => randomUUID() },
  });
  server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  baseUrl = `http://localhost:${address.port}`;

  // The first-install operator owns a home community and becomes a plain member of A below.
  const founder = await bootstrapFirstHost(
    (path, body, cookie) => send({ method: 'POST', path, body, cookie }, 'signedOut'),
    {
      secret: config.bootstrapSecret,
      accountName: 'Founder',
      email: 'founder@roles.test',
      password,
      communityName: 'Founder Home',
    }
  );
  sessions.hostMember = founder.cookie;
  userIds.hostMember = (
    await pool.query<{ id: string }>(`SELECT id FROM "user" WHERE email='founder@roles.test'`)
  ).rows[0].id;

  // There is no API for adding a host operator (a separate host-operation contract).
  const hostOnly = await account('Host Only');
  await pool.query('INSERT INTO host_operators(user_id) VALUES($1)', [hostOnly.userId]);
  sessions.hostOnly = hostOnly.cookie;
  userIds.hostOnly = hostOnly.userId;

  // A and B are created by the host operator and claimed by owners who are not operators.
  for (const [role, name] of [
    ['owner', 'Alpha'],
    ['otherOwner', 'Beta'],
  ] as const) {
    const person = await account(role === 'owner' ? 'Alpha Owner' : 'Beta Owner');
    sessions[role] = person.cookie;
    userIds[role] = person.userId;
    const pending = await createPending();
    await pool.query('UPDATE communities SET name=$2 WHERE id=$1', [pending.id, name]);
    const claimed = (await ok(
      {
        method: 'POST',
        path: '/api/v1/owner-claims/claim',
        body: {},
        cookie: await claimCookie(pending.token),
      },
      role
    )) as { memberId: string };
    if (role === 'owner') {
      alphaId = pending.id;
      ownerMemberId = claimed.memberId;
    } else {
      betaId = pending.id;
    }
  }

  const adminPerson = await account('Alpha Admin');
  sessions.admin = adminPerson.cookie;
  userIds.admin = adminPerson.userId;
  const adminMemberId = await admit(adminPerson.cookie);
  await ok(
    { method: 'PATCH', path: scoped(`/members/${adminMemberId}/role`), body: { role: 'admin' } },
    'owner'
  );

  const memberPerson = await account('Alpha Member');
  sessions.member = memberPerson.cookie;
  userIds.member = memberPerson.userId;
  await admit(memberPerson.cookie);

  const removed = await account('Alpha Removed');
  sessions.removedMember = removed.cookie;
  userIds.removedMember = removed.userId;
  const removedMemberId = await admit(removed.cookie);
  await ok({ method: 'DELETE', path: scoped(`/members/${removedMemberId}`) }, 'owner', 204);

  await admit(sessions.hostMember);

  // The spare member is the target of transfers, role changes and channel moderation.
  const spare = await account('Alpha Spare');
  spareCookie = spare.cookie;
  spareMemberId = await admit(spare.cookie);

  const channel = (await ok(
    {
      method: 'POST',
      path: scoped('/channels'),
      body: { name: 'moderation', visibility: 'public' },
    },
    'owner',
    201
  )) as { channel: { id: string } };
  moderationChannelId = channel.channel.id;

  agentToken = (await mintAgent(ownerMemberId)).token;
});

afterEach(async () => {
  await restoreBaseline();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.end();
  if (storagePath) await rm(storagePath, { recursive: true, force: true });
});

it('classifies every registered route, and puts every host and settings route in the matrix', () => {
  const normalize = (path: string) =>
    path.startsWith('/api/v1/communities/:communityId')
      ? path.slice('/api/v1/communities/:communityId'.length)
      : path.slice('/api/v1'.length);
  const registered = [
    ...new Set(
      app.routes
        .filter((route) => route.method !== 'ALL' && route.path.startsWith('/api/v1/'))
        .map((route) => `${route.method} ${normalize(route.path)}`)
    ),
  ].sort();
  expect(registered.length).toBeGreaterThan(60);

  const inMatrix = new Set(actions.map((action) => action.route));
  const outside = Object.keys(OUTSIDE_ADMINISTRATION);
  expect(outside.filter((route) => inMatrix.has(route))).toEqual([]);
  expect([...new Set([...inMatrix, ...outside])].sort()).toEqual(registered);

  // Every route the host and administration modules register is administration by definition.
  const modules = new Hono();
  const auth = createCommunityAuth(pool, config);
  const blobStore = new FileSystemBlobStore(storagePath);
  const now = () => new Date();
  const authority = createHostAuthority({ auth, pool, now, limitKeyMiss: () => undefined });
  // Only the route table is read here; no request ever runs.
  const unused = async () => undefined;
  registerHostRoutes(modules, { pool, config, blobStore, authority, now });
  registerOwnerClaimRoutes(modules, { pool, auth, config, authority, now });
  registerMembershipRoutes(modules, { pool, auth });
  registerHostLimitRoutes(modules, { pool, config, authority, now });
  registerHostLifecycleRoutes(modules, { pool, config, blobStore, authority, now });
  registerShortNameRoutes(modules, { pool, config, authority, now, limitLookup: () => undefined });
  registerHostKeyRoutes(modules, { pool, auth, authority, now, confirmPassword: unused });
  registerHostTakedownRoutes(modules, { pool, config, authority, now, confirmPassword: unused });
  registerAdministrationRoutes(modules, { pool, auth, blobStore, confirmPassword: unused });
  const administration = [
    ...new Set(modules.routes.map((route) => `${route.method} ${route.path}`)),
  ];
  expect(administration.length).toBeGreaterThan(15);
  expect(administration.filter((route) => !inMatrix.has(route))).toEqual([]);

  // Each cell is asserted exactly once per role.
  const labels = actions.map(labelOf);
  expect(new Set(labels).size).toBe(labels.length);
});

for (const action of actions) {
  describe(labelOf(action), () => {
    for (const role of ROLES) {
      const allowed = action.allowed.includes(role);
      const expected = allowed ? action.status : refusalStatus(action, role);
      it(`${role} is ${allowed ? 'allowed' : 'refused'} (${expected})`, async () => {
        if (role === 'agent') await ensureAgentCredential();
        const prepared = action.prepare ? await action.prepare(role) : undefined;
        const call = action.call(prepared, password);
        const before = allowed ? undefined : await snapshot();
        const body = await expectStatus(
          await send(call, role),
          expected,
          `${labelOf(action)} as ${role}`
        );
        if (allowed) await action.effect?.(body, role, prepared);
        else
          expect(await snapshot(), `${labelOf(action)} as ${role} changed state`).toEqual(before);
      });
    }
    if (action.reauth) {
      it('owner without the current password is refused (403)', async () => {
        const prepared = action.prepare ? await action.prepare('owner') : undefined;
        const before = await snapshot();
        await expectStatus(
          await send(action.call(prepared, wrongPassword), 'owner'),
          403,
          `${labelOf(action)} with a wrong password`
        );
        expect(await snapshot()).toEqual(before);
      });
    }
  });
}

/**
 * Closing admission races an invitation or an admission. The test holds A's row so both
 * requests queue behind it in a chosen order, then lets them run. Postgres grants the row to
 * waiters in arrival order, so each ordering is exercised on purpose rather than by luck.
 */
describe('closing admission while someone is invited or joining', () => {
  async function waitForLockWaiters(count: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const waiting = await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname=$1 AND wait_event_type='Lock'`,
        [dbName]
      );
      if (waiting.rows[0].n >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Expected ${count} requests waiting on the community row`);
  }

  /** Queue `first`, then `second`, behind a held community row, then release it. */
  async function race(
    first: () => Promise<Response>,
    second: () => Promise<Response>
  ): Promise<[Response, Response]> {
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM communities WHERE id=$1 FOR UPDATE', [alphaId]);
      const one = first();
      await waitForLockWaiters(1);
      const two = second();
      await waitForLockWaiters(2);
      await holder.query('COMMIT');
      return await Promise.all([one, two]);
    } finally {
      holder.release();
    }
  }

  function close(version: number) {
    return () =>
      send(
        {
          method: 'PATCH',
          path: scoped('/settings'),
          body: { admissionPolicy: 'closed' },
          headers: { 'if-match': `"${version}"` },
        },
        'owner'
      );
  }

  const invite = () =>
    send({ method: 'POST', path: scoped('/invites'), body: { seats: 1 } }, 'admin');

  async function openInvitations(): Promise<number> {
    return (
      await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM invites WHERE community_id=$1 AND revoked_at IS NULL',
        [alphaId]
      )
    ).rows[0].n;
  }

  it('an invitation created just after the close is refused', async () => {
    const [closed, created] = await race(close((await alpha()).settings_version), invite);
    expect(closed.status).toBe(200);
    await expectStatus(created, 409, 'invitation after the close');
    expect(await openInvitations()).toBe(0);
  });

  it('an invitation created just before the close is revoked by it', async () => {
    const version = (await alpha()).settings_version;
    const [created, closed] = await race(invite, close(version));
    expect(created.status).toBe(201);
    expect(closed.status).toBe(200);
    expect(await openInvitations()).toBe(0);
  });

  async function boundAdmission(): Promise<{ cookie: string; userId: string }> {
    const admission = await startJoining(await createInvite());
    const person = await account(`Racer ${randomUUID().slice(0, 8)}`);
    const cookie = `${person.cookie}; ${admission}`;
    await expectStatus(
      await send({ method: 'POST', path: scoped('/invites/bind'), body: {}, cookie }, 'signedOut'),
      200,
      'invite bind'
    );
    return { cookie, userId: person.userId };
  }

  async function membersFor(userId: string): Promise<number> {
    return (
      await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM members WHERE community_id=$1 AND user_id=$2',
        [alphaId, userId]
      )
    ).rows[0].n;
  }

  it('a join redeemed just after the close admits no one', async () => {
    const { cookie, userId } = await boundAdmission();
    const redeem = () =>
      send({ method: 'POST', path: scoped('/invites/redeem'), body: {}, cookie }, 'signedOut');
    const [closed, redeemed] = await race(close((await alpha()).settings_version), redeem);
    expect(closed.status).toBe(200);
    await expectStatus(redeemed, 409, 'redeem after the close');
    expect(await membersFor(userId)).toBe(0);
  });

  it('a join redeemed just before the close stays a member', async () => {
    const { cookie, userId } = await boundAdmission();
    const redeem = () =>
      send({ method: 'POST', path: scoped('/invites/redeem'), body: {}, cookie }, 'signedOut');
    const version = (await alpha()).settings_version;
    const [redeemed, closed] = await race(redeem, close(version));
    expect(redeemed.status).toBe(200);
    expect(closed.status).toBe(200);
    expect(await membersFor(userId)).toBe(1);
    // Closing admission leaves existing members alone.
    expect(
      (
        await pool.query('SELECT active FROM members WHERE community_id=$1 AND user_id=$2', [
          alphaId,
          userId,
        ])
      ).rows
    ).toEqual([{ active: true }]);
  });
});

it('a token not signed for this community gets the same refusal whether it is open or closed', async () => {
  // Made-up tokens: garbage, a well-formed one with a forged signature, and a real invitation
  // signed for community B. None of them may learn whether A is closed.
  const { token: signedForB } = (await ok(
    {
      method: 'POST',
      path: `/api/v1/communities/${betaId}/invites`,
      body: { seats: 1 },
    },
    'otherOwner',
    201
  )) as { token: string };
  const forged = [
    '1',
    config.inviteKeyId,
    randomUUID(),
    String(Date.now() + 86_400_000),
    'a'.repeat(32),
    'b'.repeat(43),
  ].join('.');
  const tokens = { garbage: 'not-an-invitation', forged, signedForB };
  async function refusals(): Promise<Record<string, { status: number; body: string }>> {
    const result: Record<string, { status: number; body: string }> = {};
    for (const [name, token] of Object.entries(tokens)) {
      for (const step of ['preview', 'preflight']) {
        const response = await send(
          { method: 'POST', path: scoped(`/invites/${step}`), body: { token } },
          'signedOut'
        );
        result[`${step} ${name}`] = { status: response.status, body: await response.text() };
      }
    }
    return result;
  }
  const open = await refusals();
  for (const [label, refusal] of Object.entries(open))
    expect(refusal.status, `${label} while open`).toBe(403);
  await closeAdmission();
  expect(await refusals()).toEqual(open);
});
