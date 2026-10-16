/**
 * Signed download links and the user-content address (DOR-2957, specs/everything-is-a-space C8),
 * over real HTTP and Postgres. One server answers two addresses, as Cloud runs it: the space's
 * own (`localhost`) and the user-content one (`127.0.0.1`), which are different origins to a
 * browser. A second app on the same database has no user-content address, as a self-hoster's.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { serve } from '@hono/node-server';
import { createCommunityApp } from '../app.js';
import { parseConfig, type CommunityConfig } from '../config.js';
import { migrate } from '../migrate.js';
import { hashSecret } from '../security.js';
import { FileSystemBlobStore } from '../storage/index.js';
import { signUserContentLink, type UserContentClaim } from '../user-content/links.js';
import { bootstrapFirstHost, seedCredentialAccount } from './bootstrap-test-helper.js';
import { drainExports } from './export-test-helpers.js';
import { headerGroupOf } from './promises/headers-census.js';

const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('COMMUNITY_TEST_DATABASE_URL is required for user-content tests');
const admin = new Pool({ connectionString: adminUrl });
const dbName = `community_user_content_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;

let directory: string;
let pool: Pool;
const servers: Array<ReturnType<typeof serve>> = [];
/** The split server: the space's own address and its user-content address. */
let space: string;
let files: string;
let split: CommunityConfig;
/** A server with no user-content address, on the same database. */
let plain: string;
let ownerCookie: string;
let bobCookie: string;
let ownerId: string;
let bobId: string;
let communityId: string;
let attachmentId: string;
let exportId: string;
const AGENT_TOKEN = 'user-content-agent-token';

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('No free port');
  return address.port;
}

function env(port: number, userContent?: string) {
  return {
    COMMUNITY_DATABASE_URL: dbUrl.toString(),
    COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
    COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
    COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
    COMMUNITY_PUBLIC_URL: `http://localhost:${port}`,
    COMMUNITY_STORAGE_PATH: directory,
    ...(userContent ? { COMMUNITY_USER_CONTENT_URL: userContent } : {}),
  };
}

async function start(config: CommunityConfig, port: number, blobStore: FileSystemBlobStore) {
  const app = createCommunityApp({ config, pool, blobStore });
  const server = serve({ fetch: app.fetch, port });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  servers.push(server);
}

function cookieOf(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}

function post(base: string, path: string, body: unknown, cookie: string, origin = base) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** A link signed with this server's secret, for any claim a test wants to try. */
function linkFor(claim: Partial<Omit<UserContentClaim, 'expiresAt'>>, now = new Date()) {
  return signUserContentLink(
    split,
    {
      kind: 'attachment',
      id: attachmentId,
      communityId,
      memberId: ownerId,
      sessionId: 'unset',
      ...claim,
    },
    now
  ).url;
}

/** The session id behind a cookie, as a link records it. */
async function sessionIdOf(userEmail: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `SELECT s.id FROM session s JOIN "user" u ON u.id=s."userId"
     WHERE u.email=$1 ORDER BY s."createdAt" DESC LIMIT 1`,
    [userEmail]
  );
  return result.rows[0].id;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'community-user-content-'));
  const blobStore = new FileSystemBlobStore(directory);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  pool = new Pool({ connectionString: dbUrl.toString() });
  const splitPort = await freePort();
  split = parseConfig(env(splitPort, `http://127.0.0.1:${splitPort}`));
  space = `http://localhost:${splitPort}`;
  files = `http://127.0.0.1:${splitPort}`;
  await start(split, splitPort, blobStore);
  const plainPort = await freePort();
  plain = `http://localhost:${plainPort}`;
  await start(parseConfig(env(plainPort)), plainPort, blobStore);

  const setup = await bootstrapFirstHost((path, body, cookie) => post(space, path, body, cookie), {
    secret: split.bootstrapSecret,
    accountName: 'Owner',
    email: 'uc-owner@example.test',
    password: 'password1234',
    communityName: 'Files',
  });
  ownerCookie = setup.cookie;
  communityId = setup.communityId;
  ownerId = (
    await pool.query<{ id: string }>(
      "SELECT id FROM members WHERE role='owner' AND community_id=$1",
      [communityId]
    )
  ).rows[0].id;
  await seedCredentialAccount(pool, {
    name: 'Bob',
    email: 'uc-bob@example.test',
    password: 'password1234',
  });
  bobCookie = cookieOf(
    await post(
      space,
      '/api/auth/sign-in/email',
      { email: 'uc-bob@example.test', password: 'password1234' },
      ''
    )
  );
  bobId = (
    await pool.query<{ id: string }>(
      `INSERT INTO members(community_id,user_id,display_name,handle,role)
       SELECT $1,id,name,'bob','member' FROM "user" WHERE email='uc-bob@example.test' RETURNING id`,
      [communityId]
    )
  ).rows[0].id;
  // A channel Bob is not in, with one posted file.
  const channel = await post(space, '/api/v1/channels', { name: 'Private files' }, ownerCookie);
  expect(channel.status).toBe(201);
  const channelId = (await channel.json()).channel.id as string;
  const uploaded = await fetch(`${space}/api/v1/channels/${channelId}/attachments`, {
    method: 'POST',
    headers: {
      cookie: ownerCookie,
      origin: space,
      'content-type': 'text/plain',
      'idempotency-key': 'uc-file',
      'x-file-name': 'notes.txt',
      'x-file-size': '5',
    },
    body: 'hello',
  });
  expect(uploaded.status).toBe(201);
  attachmentId = (await uploaded.json()).attachment.id;
  const entry = await post(
    space,
    `/api/v1/channels/${channelId}/entries`,
    { text: 'a file', idempotencyKey: 'uc-entry', attachmentIds: [attachmentId] },
    ownerCookie
  );
  expect(entry.status).toBe(201);
  // An agent in that channel reads with a bearer, as the DorkOS app's agents do.
  const agent = await pool.query<{ id: string }>(
    `INSERT INTO agents(community_id,owner_member_id,display_name,handle)
     VALUES($1,$2,'Helper','helper') RETURNING id`,
    [communityId, ownerId]
  );
  await pool.query(
    'INSERT INTO agent_credentials(community_id,agent_id,token_hash) VALUES($1,$2,$3)',
    [communityId, agent.rows[0].id, hashSecret(AGENT_TOKEN)]
  );
  await pool.query(
    'INSERT INTO agent_channel_members(community_id,channel_id,agent_id) VALUES($1,$2,$3)',
    [communityId, channelId, agent.rows[0].id]
  );
  // A ready personal export.
  const created = await post(space, '/api/v1/me/export', {}, ownerCookie);
  expect(created.status).toBeLessThan(300);
  exportId = (await created.json()).export.id;
  await drainExports(pool, blobStore);
});

afterAll(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('a browser download on a space with a user-content address', () => {
  it('gets a link on the user-content address, and the file opens only there', async () => {
    // Purpose: fails if a browser's file opens on the space's own address, where its sign-in
    // lives, or if the link does not open the file as an inert download on the other address.
    const linked = await post(space, `/api/v1/attachments/${attachmentId}/link`, {}, ownerCookie);
    expect(linked.status).toBe(200);
    const { url } = (await linked.json()) as { url: string; expiresAt: string };
    expect(url.startsWith(`${files}/u/`)).toBe(true);
    const opened = await fetch(url);
    expect(opened.status).toBe(200);
    expect(await opened.text()).toBe('hello');
    expect(opened.headers.get('content-disposition')).toMatch(/^attachment;/u);
    expect(opened.headers.get('x-content-type-options')).toBe('nosniff');
    expect(headerGroupOf(opened)).toBe('locked');
    // The same link on the space's own address opens nothing.
    const onSpace = await fetch(url.replace(files, space));
    expect(onSpace.status).toBe(404);
  });

  it('redirects a signed-in browser from the old download address to a link', async () => {
    // Purpose: fails if a bookmark or an old page still downloads on the space's own address.
    const old = await fetch(`${space}/api/v1/attachments/${attachmentId}`, {
      headers: { cookie: ownerCookie },
      redirect: 'manual',
    });
    expect(old.status).toBe(303);
    const location = old.headers.get('location')!;
    expect(location.startsWith(`${files}/u/`)).toBe(true);
    expect(await (await fetch(location)).text()).toBe('hello');
  });

  it('gives a bearer caller the bytes on the space address, never a redirect', async () => {
    // Purpose: fails if the DorkOS app or an agent, which refuse redirects, is sent elsewhere.
    const read = await fetch(`${space}/api/v1/attachments/${attachmentId}`, {
      headers: { authorization: `Bearer ${AGENT_TOKEN}` },
      redirect: 'manual',
    });
    expect(read.status).toBe(200);
    expect(await read.text()).toBe('hello');
    const linked = await fetch(`${space}/api/v1/attachments/${attachmentId}/link`, {
      method: 'POST',
      headers: { authorization: `Bearer ${AGENT_TOKEN}`, origin: space },
    });
    expect(linked.status).toBe(403);
  });

  it('answers nothing but links on the user-content address', async () => {
    // Purpose: fails if the user-content address serves the page, the API or health, where a
    // file's origin could reach the space's own routes.
    for (const path of ['/', '/health', '/api/v1/channels', '/assets/app.js', '/c/x'])
      expect(
        (await fetch(`${files}${path}`, { headers: { cookie: ownerCookie } })).status,
        path
      ).toBe(404);
  });
});

describe('a link opens only for its own claim', () => {
  it('refuses a link this server did not sign, or one whose claim was changed', async () => {
    // Purpose: fails if a forged or edited link opens a file, as someone else or elsewhere.
    const sessionId = await sessionIdOf('uc-owner@example.test');
    const good = linkFor({ sessionId });
    expect((await fetch(good)).status).toBe(200);
    const forged = signUserContentLink(
      { ...split, authSecret: 'z'.repeat(32) },
      { kind: 'attachment', id: attachmentId, communityId, memberId: ownerId, sessionId },
      new Date()
    ).url;
    expect((await fetch(forged)).status).toBe(404);
    const [body, mac] = good.slice(`${files}/u/`.length).split('.');
    const claim = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    const edited = Buffer.from(JSON.stringify({ ...claim, m: bobId })).toString('base64url');
    expect((await fetch(`${files}/u/${edited}.${mac}`)).status).toBe(404);
  });

  it('refuses a link for a person who cannot read the file', async () => {
    // Purpose: fails if a link opens a file its own person could not open in the space.
    const sessionId = await sessionIdOf('uc-bob@example.test');
    expect((await fetch(linkFor({ memberId: bobId, sessionId }))).status).toBe(403);
    // Bob cannot ask for one either.
    const asked = await post(space, `/api/v1/attachments/${attachmentId}/link`, {}, bobCookie);
    expect(asked.status).toBe(403);
  });

  it('refuses a link made for another space', async () => {
    // Purpose: fails if a link's space is not the file's, so a link from one space opens another's.
    const sessionId = await sessionIdOf('uc-owner@example.test');
    expect((await fetch(linkFor({ communityId: randomUUID(), sessionId }))).status).toBe(403);
  });

  it('refuses an expired link', async () => {
    // Purpose: fails if a link keeps opening after its few minutes are up.
    const sessionId = await sessionIdOf('uc-owner@example.test');
    const old = linkFor({ sessionId }, new Date(Date.now() - 6 * 60_000));
    const response = await fetch(old);
    expect(response.status).toBe(410);
    expect((await response.json()).code).toBe('LINK_EXPIRED');
  });

  it('stops opening once its sign-in signs out', async () => {
    // Purpose: fails if signing out leaves a download link working, for anyone who copied it.
    const cookie = cookieOf(
      await post(
        space,
        '/api/auth/sign-in/email',
        { email: 'uc-owner@example.test', password: 'password1234' },
        ''
      )
    );
    const linked = await post(space, `/api/v1/attachments/${attachmentId}/link`, {}, cookie);
    const { url } = (await linked.json()) as { url: string };
    expect((await fetch(url)).status).toBe(200);
    expect((await post(space, '/api/auth/sign-out', {}, cookie)).status).toBe(200);
    expect((await fetch(url)).status).toBe(403);
  });
});

describe('exports', () => {
  it('download through a link on the user-content address, resumable by range', async () => {
    // Purpose: fails if an export opens on the space's own address, or its link cannot resume.
    const linked = await post(space, `/api/v1/exports/${exportId}/link`, {}, ownerCookie);
    expect(linked.status).toBe(200);
    const { url } = (await linked.json()) as { url: string };
    expect(url.startsWith(`${files}/u/`)).toBe(true);
    const whole = await fetch(url);
    expect(whole.status).toBe(200);
    expect(headerGroupOf(whole)).toBe('locked');
    const bytes = Buffer.from(await whole.arrayBuffer());
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    const part = await fetch(url, { headers: { range: 'bytes=0-9' } });
    expect(part.status).toBe(206);
    expect(Buffer.from(await part.arrayBuffer())).toEqual(bytes.subarray(0, 10));
    const old = await fetch(`${space}/api/v1/exports/${exportId}/archive`, {
      headers: { cookie: ownerCookie },
      redirect: 'manual',
    });
    expect(old.status).toBe(303);
    expect(old.headers.get('location')!.startsWith(`${files}/u/`)).toBe(true);
  });

  it("refuse a link to someone else's export", async () => {
    // Purpose: fails if a link opens an export for anyone but the person who asked for it.
    expect((await post(space, `/api/v1/exports/${exportId}/link`, {}, bobCookie)).status).toBe(404);
    const sessionId = await sessionIdOf('uc-bob@example.test');
    expect(
      (await fetch(linkFor({ kind: 'export', id: exportId, memberId: bobId, sessionId }))).status
    ).toBe(404);
  });
});

describe('a space with no user-content address', () => {
  it('serves links on its own address, with the same download headers', async () => {
    // Purpose: fails if a self-hosted space without the setting cannot download, or serves its
    // files with weaker headers than the split one.
    const linked = await post(plain, `/api/v1/attachments/${attachmentId}/link`, {}, ownerCookie);
    expect(linked.status).toBe(200);
    const { url } = (await linked.json()) as { url: string };
    expect(url.startsWith(`${plain}/u/`)).toBe(true);
    const opened = await fetch(url);
    expect(opened.status).toBe(200);
    expect(await opened.text()).toBe('hello');
    expect(opened.headers.get('content-disposition')).toMatch(/^attachment;/u);
    expect(headerGroupOf(opened)).toBe('locked');
    const old = await fetch(`${plain}/api/v1/attachments/${attachmentId}`, {
      headers: { cookie: ownerCookie },
      redirect: 'manual',
    });
    expect(old.status).toBe(200);
  });
});
