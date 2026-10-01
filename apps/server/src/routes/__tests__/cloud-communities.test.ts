/**
 * The hosted-community routes, driven end to end against a fake hosting
 * service and a fake Community upload route, both real HTTP servers on
 * loopback that answer from the contract package's own fixtures.
 *
 * Nothing is mocked between the route and the wire except where the service
 * lives and this instance's credential, so these tests prove what actually
 * leaves this process (headers, bodies, the exported bytes) and what actually
 * reaches the browser. No test here reaches a real service.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { logger } from '../../lib/logger.js';
import listFixture from '@dork-labs/cloud-api/fixtures/v1/communities/list.json' with { type: 'json' };
import movesFixture from '@dork-labs/cloud-api/fixtures/v1/communities/moves.json' with { type: 'json' };
import startFixture from '@dork-labs/cloud-api/fixtures/v1/communities/start.json' with { type: 'json' };
import startReplayFixture from '@dork-labs/cloud-api/fixtures/v1/communities/start-replay.json' with { type: 'json' };
import claimLinkFixture from '@dork-labs/cloud-api/fixtures/v1/communities/claim-link.json' with { type: 'json' };
import keepFixture from '@dork-labs/cloud-api/fixtures/v1/communities/keep.json' with { type: 'json' };
import restoreFixture from '@dork-labs/cloud-api/fixtures/v1/communities/restore.json' with { type: 'json' };
import moveStartFixture from '@dork-labs/cloud-api/fixtures/v1/communities/move-start.json' with { type: 'json' };
import moveImportingFixture from '@dork-labs/cloud-api/fixtures/v1/communities/move-importing.json' with { type: 'json' };
import moveCancelledFixture from '@dork-labs/cloud-api/fixtures/v1/communities/move-cancelled.json' with { type: 'json' };
import nameFreeFixture from '@dork-labs/cloud-api/fixtures/v1/communities/name-check-free.json' with { type: 'json' };
import signInFixture from '@dork-labs/cloud-api/fixtures/v1/communities/sign-in.json' with { type: 'json' };
import entitlementsFixture from '@dork-labs/cloud-api/fixtures/v1/billing/entitlements-free.json' with { type: 'json' };
import nameTakenProblem from '@dork-labs/cloud-api/fixtures/v1/problem/community-name-taken.json' with { type: 'json' };
import entitlementProblem from '@dork-labs/cloud-api/fixtures/v1/problem/entitlement-required-action.json' with { type: 'json' };

const config = vi.hoisted(() => ({ cloud: { instanceToken: 'tok_instance' } as unknown }));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: (section: string) => (section === 'cloud' ? config.cloud : undefined) },
}));

const service = vi.hoisted(() => ({ baseUrl: 'http://127.0.0.1:1' }));
vi.mock('../../services/core/auth/cloud-link-client.js', () => ({
  resolveCloudBaseUrl: () => service.baseUrl,
}));

/**
 * The staging disk, as the room check sees it. `free: null` reads the real
 * disk; a number pretends that many bytes are free; `fail` makes the read throw.
 */
const disk = vi.hoisted(() => ({ free: null as number | null, fail: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    statfs: async (...args: Parameters<typeof real.statfs>) => {
      if (disk.fail) throw Object.assign(new Error('statfs failed'), { code: 'EIO' });
      const stats = await real.statfs(...args);
      return disk.free === null ? stats : { ...stats, bavail: disk.free, bsize: 1 };
    },
  };
});

const { createCloudCommunitiesRouter } = await import('../cloud-communities.js');
const { CommunityMoveUploads, initMoveStaging, moveStagingRoot, MOVE_STAGING_HEADROOM_BYTES } =
  await import('../../services/core/cloud/community-move-upload.js');

/** A throwaway data directory for this file's staged exports. */
const dorkHome = mkdtempSync(path.join(tmpdir(), 'dorkos-move-route-test-'));

/** The staged copies on disk right now. */
function stagedCopies(): string[] {
  return readdirSync(moveStagingRoot(dorkHome));
}

/** The one-time credentials the fixtures carry. None may ever reach the browser uninvited. */
const START_CLAIM_URL = startFixture.claim.claimUrl;
const FRESH_CLAIM_URL = 'https://community.example.invalid/claim/ct_opaque_fresh';
const UPLOAD_TOKEN = moveStartFixture.upload.token;

/**
 * An instant `ms` after now.
 *
 * The fixtures' expiry times are fixed instants, only in the future on the
 * day they were written, and the code under test compares them with the real
 * clock. A test that needs an open window builds one here instead (the move
 * fixture's upload window closed on 2026-09-24 and took six tests with it).
 */
function fromNow(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

/** A start answer whose held claim link is still valid. */
function startAnswer() {
  return { ...startFixture, claim: { ...startFixture.claim, expiresAt: fromNow(3_600_000) } };
}

/** One request the fake service or upload route received. */
interface Received {
  method: string;
  path: string;
  authorization: string | undefined;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

/** What the fake service answers, set per test. */
interface Script {
  list: unknown;
  /** The status the list read answers with. */
  listStatus: number;
  startStatus: number;
  startBody: unknown;
  moveStartStatus: number;
  moveStartBody: unknown;
  moveBody: unknown;
  /** What the move cancel answers with; anything but 200 is a refusal. */
  cancelStatus: number;
  /** Upload answers in order. `0` breaks the connection instead of answering. */
  uploadStatus: number[];
  /** When set, the move start waits for this before answering. */
  moveStartGate: Promise<void> | null;
  entitlements: unknown;
  /** When set, the entitlements read waits for this before answering. */
  entitlementsGate: Promise<void> | null;
  /** The parts the fake Community server holds for a parted upload, by number. */
  parts: Map<number, Buffer>;
  /** Answers `complete` gives in order before it succeeds (`202` = still checking). */
  completeStatus: number[];
  /** What the account sign-in read answers with; `null` is a service that does not serve it. */
  signIn: unknown;
  /** The status the account sign-in read answers with. */
  signInStatus: number;
}

let script: Script;
const received: Received[] = [];
/** Requests the fake has started on and not yet answered. */
let inFlight = 0;

function defaultScript(): Script {
  return {
    list: listFixture,
    listStatus: 200,
    startStatus: 200,
    startBody: startAnswer(),
    moveStartStatus: 200,
    moveStartBody: null,
    moveBody: moveImportingFixture,
    cancelStatus: 200,
    uploadStatus: [200],
    moveStartGate: null,
    entitlements: {
      ...entitlementsFixture,
      limits: {
        ...entitlementsFixture.limits,
        communities: {
          maxCommunities: 3,
          maxMembersPerCommunity: 200,
          maxStorageBytesPerCommunity: null,
        },
      },
      used: { ...entitlementsFixture.used, communities: 1 },
    },
    entitlementsGate: null,
    parts: new Map(),
    completeStatus: [],
    signIn: signInFixture,
    signInStatus: 200,
  };
}

/** Read a whole request body. */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Answer JSON. */
function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * The fake hosting service and the fake Community upload route, one server.
 * Routes by method and path the way the contract names them.
 */
const fake = listeningServer(async (req, res) => {
  inFlight++;
  res.on('close', () => inFlight--);
  const url = new URL(req.url ?? '/', 'http://fake');
  const body = await readBody(req);
  received.push({
    method: req.method ?? '',
    path: url.pathname,
    authorization: req.headers.authorization,
    headers: req.headers,
    body,
  });
  const route = `${req.method} ${url.pathname}`;
  if (route === 'GET /v1/communities') return send(res, script.listStatus, script.list);
  if (route === 'GET /v1/communities/moves') return send(res, 200, movesFixture);
  if (route === 'GET /v1/entitlements') {
    if (script.entitlementsGate) await script.entitlementsGate;
    return send(res, 200, script.entitlements);
  }
  if (route === 'GET /v1/communities/name-check') {
    return send(res, 200, { ...nameFreeFixture, name: url.searchParams.get('name') });
  }
  if (route === 'GET /v1/communities/sign-in' && script.signIn !== null) {
    return send(res, script.signInStatus, script.signIn);
  }
  if (route === 'POST /v1/communities') return send(res, script.startStatus, script.startBody);
  if (route.startsWith('POST /v1/communities/') && route.endsWith('/claim-link')) {
    return send(res, 200, { ...claimLinkFixture, claimUrl: FRESH_CLAIM_URL });
  }
  if (route.endsWith('/keep')) return send(res, 200, keepFixture);
  if (route.endsWith('/restore')) return send(res, 200, restoreFixture);
  if (route === 'POST /v1/communities/moves') {
    if (script.moveStartGate) await script.moveStartGate;
    return send(res, script.moveStartStatus, script.moveStartBody);
  }
  if (route === 'POST /v1/communities/moves/move_0001/cancel') {
    if (script.cancelStatus !== 200) {
      return send(res, script.cancelStatus, {
        code: 'temporarily_unavailable',
        status: script.cancelStatus,
        title: 'Try again shortly.',
      });
    }
    return send(res, 200, moveCancelledFixture);
  }
  if (route === 'GET /v1/communities/moves/move_0001') return send(res, 200, script.moveBody);
  if (route === 'GET /upload/imp_0001/parts') {
    return send(res, 200, {
      parts: [...script.parts].map(([partNumber, bytes]) => ({
        partNumber,
        byteSize: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      })),
      maxPartBytes: 8,
      maxArchiveBytes: 1024,
    });
  }
  const part = /^PUT \/upload\/imp_0001\/parts\/(\d+)$/.exec(route);
  if (part) {
    if (createHash('sha256').update(body).digest('hex') !== req.headers['x-part-sha256'])
      return send(res, 400, { code: 'IMPORT_ARCHIVE_INVALID' });
    script.parts.set(Number(part[1]), body);
    return send(res, 200, { partNumber: Number(part[1]), byteSize: body.length });
  }
  if (route === 'POST /upload/imp_0001/complete') {
    const next = script.completeStatus.shift();
    if (next) {
      res.setHeader('retry-after', '0');
      return send(res, next, {});
    }
    const request = JSON.parse(body.toString()) as { parts: number; archiveSha256: string };
    const whole = Buffer.concat(
      Array.from(
        { length: request.parts },
        (_, index) => script.parts.get(index + 1) ?? Buffer.alloc(0)
      )
    );
    if (createHash('sha256').update(whole).digest('hex') !== request.archiveSha256)
      return send(res, 400, { code: 'IMPORT_ARCHIVE_INVALID' });
    return send(res, 200, { state: 'validating' });
  }
  if (route === 'PUT /upload/imp_0001') {
    const status = script.uploadStatus.shift() ?? 200;
    if (status === 0) return req.socket.destroy();
    return send(res, status, status === 200 ? { ok: true } : { code: 'IMPORT_ARCHIVE_INVALID' });
  }
  return send(res, 404, { code: 'not_found', status: 404, title: 'Not here' });
});

let uploads: InstanceType<typeof CommunityMoveUploads>;
const app = express();
app.use(express.json());
app.use('/api/cloud/communities', (req, res, next) =>
  createCloudCommunitiesRouter(uploads)(req, res, next)
);
const server = listeningServer(app);

/** The loopback origin the fake listens on. */
function fakeOrigin() {
  return `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
}

/** A move-start answer whose upload goes to the fake upload route, with its window open. */
function moveStartAnswer() {
  return {
    ...moveStartFixture,
    upload: {
      ...moveStartFixture.upload,
      url: `${fakeOrigin()}/upload/imp_0001`,
      expiresAt: fromNow(3_600_000),
    },
  };
}

/** Wait until the move's local upload stops sending. */
async function uploadSettled(moveId: string) {
  await vi.waitFor(() => {
    const progress = uploads.progress(moveId);
    if (!progress || progress.state === 'sending') throw new Error('still sending');
  });
  return uploads.progress(moveId);
}

/** Every service request the fake saw, excluding the upload route. */
function serviceRequests() {
  return received.filter((r) => r.path.startsWith('/v1/'));
}

beforeAll(async () => {
  service.baseUrl = fakeOrigin();
  await initMoveStaging(dorkHome);
});

beforeEach(() => {
  config.cloud = { instanceToken: 'tok_instance' };
  disk.free = null;
  disk.fail = false;
  script = defaultScript();
  received.length = 0;
  uploads = new CommunityMoveUploads();
});

// Every request a test starts must be answered inside that test. One still
// running would land in the next test's `received` and fail an assertion
// that has nothing to do with it (DOR-2298).
afterEach(async () => {
  await vi.waitFor(() => expect(inFlight).toBe(0));
});

describe('unlinked', () => {
  // Purpose: the entry points must cost nothing on an install with no account.
  // Fails if any route reaches the service before checking the link.
  it('answers every route without a single request leaving the machine', async () => {
    config.cloud = { instanceToken: null };
    const list = await request(server).get('/api/cloud/communities').expect(200);
    expect(list.body).toEqual({ available: false });
    const check = await request(server)
      .get('/api/cloud/communities/name-check?name=acme')
      .expect(200);
    expect(check.body).toEqual({ available: false });
    const start = await request(server)
      .post('/api/cloud/communities')
      .send({ idempotencyKey: 'k1', name: 'Acme' })
      .expect(200);
    expect(start.body).toMatchObject({ ok: false, message: expect.any(String) });
    const move = await request(server)
      .post('/api/cloud/communities/moves?idempotencyKey=k2&name=Acme')
      .set('content-type', 'application/zip')
      .send(Buffer.from('zip bytes'))
      .expect(200);
    expect(move.body.ok).toBe(false);
    const room = await request(server).get('/api/cloud/communities/moves/room?bytes=9').expect(200);
    expect(room.body).toMatchObject({ ok: false, message: expect.any(String) });
    const claim = await request(server)
      .post(`/api/cloud/communities/${startFixture.community.communityId}/claim-link`)
      .expect(200);
    expect(claim.body.ok).toBe(false);
    const signIn = await request(server).get('/api/cloud/communities/sign-in').expect(200);
    expect(signIn.body).toEqual({ available: false });
    expect(received).toHaveLength(0);
  });
});

describe('GET /api/cloud/communities/sign-in', () => {
  // Purpose: the app leads with the account on exactly the servers the service
  // names, and keeps today's flow everywhere else.
  it('passes on the origins of the servers where the account signs a person in', async () => {
    const res = await request(server).get('/api/cloud/communities/sign-in').expect(200);
    expect(res.body).toEqual({ available: true, origins: ['https://community.example.invalid'] });
    expect(serviceRequests()).toEqual([
      expect.objectContaining({ method: 'GET', path: '/v1/communities/sign-in' }),
    ]);
    expect(serviceRequests()[0]?.authorization).toBe('Bearer tok_instance');
  });

  it('reads a service that does not serve the route yet as not available, not as a fault', async () => {
    // The demo-claim gate: until the control plane ships it, nothing changes.
    script.signIn = null;
    const res = await request(server).get('/api/cloud/communities/sign-in').expect(200);
    expect(res.body).toEqual({ available: false });
  });

  it('passes an empty list on as it is: the service offers the sign-in nowhere today', async () => {
    script.signIn = { servers: [] };
    const res = await request(server).get('/api/cloud/communities/sign-in').expect(200);
    expect(res.body).toEqual({ available: true, origins: [] });
  });

  it('passes on the origin and nothing else the service put beside it', async () => {
    script.signIn = {
      servers: [{ origin: 'https://community.example.invalid', subject: 'account-subject' }],
      account: 'u_1',
    };
    const res = await request(server).get('/api/cloud/communities/sign-in').expect(200);
    expect(res.body).toEqual({ available: true, origins: ['https://community.example.invalid'] });
    expect(JSON.stringify(res.body)).not.toContain('account-subject');
  });

  it('refuses a server that is not a bare origin rather than opening pages on it', async () => {
    script.signIn = { servers: [{ origin: 'https://community.example.invalid/c/x' }] };
    const logged = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const res = await request(server).get('/api/cloud/communities/sign-in').expect(502);
    expect(res.body).toEqual({ error: expect.any(String) });
    logged.mockRestore();
  });

  it('says it could not reach the account when the service fails', async () => {
    script.signInStatus = 503;
    script.signIn = { code: 'temporarily_unavailable', status: 503, title: 'Try again shortly.' };
    const logged = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await request(server).get('/api/cloud/communities/sign-in').expect(502);
    logged.mockRestore();
  });
});

describe('GET /api/cloud/communities', () => {
  // Purpose: the list the switcher reads, with the allowance numbers when sent.
  it('lists communities and moves with the installation credential, and the allowance', async () => {
    const res = await request(server).get('/api/cloud/communities').expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.available).toBe(true);
    expect(res.body.communities.map((c: { name: string }) => c.name)).toEqual(
      listFixture.items.map((c) => c.name)
    );
    expect(res.body.moves[0]).toMatchObject({ moveId: 'move_0001', upload: null });
    expect(res.body.allowance).toEqual({ maxCommunities: 3, usedCommunities: 1 });
    for (const r of serviceRequests()) expect(r.authorization).toBe('Bearer tok_instance');
  });

  // Purpose: the allowance is a courtesy. Fails if its absence invents numbers.
  it('says nothing about an allowance the service did not send', async () => {
    script.entitlements = entitlementsFixture;
    const res = await request(server).get('/api/cloud/communities').expect(200);
    expect(res.body.allowance).toBeNull();
  });

  // Purpose: a relay forwards parsed values, so a credential the service put in
  // the wrong shape stops here. Fails if the route passes the raw body through.
  it('drops keys the contract does not declare, including a stray claim link', async () => {
    const [first, ...rest] = listFixture.items;
    script.list = {
      ...listFixture,
      items: [{ ...first, claimUrl: START_CLAIM_URL, token: UPLOAD_TOKEN }, ...rest],
    };
    const res = await request(server).get('/api/cloud/communities').expect(200);
    expect(res.text).not.toContain(START_CLAIM_URL);
    expect(res.text).not.toContain(UPLOAD_TOKEN);
    expect(res.body.communities[0]).not.toHaveProperty('claimUrl');
  });

  // Purpose: a state from a later release must not take the whole list down.
  it('reads an unknown state as unrecognised and keeps every other community', async () => {
    const [first, ...rest] = listFixture.items;
    script.list = { ...listFixture, items: [{ ...first, state: 'frozen_by_moonlight' }, ...rest] };
    const res = await request(server).get('/api/cloud/communities').expect(200);
    expect(res.body.communities[0].state).toBe('unrecognised');
    expect(res.body.communities).toHaveLength(listFixture.items.length);
  });

  // Purpose: an unreachable service is said plainly, never as a raw body.
  it('answers 502 in plain words when the service breaks', async () => {
    script.list = '<html>proxy error</html>';
    const res = await request(server).get('/api/cloud/communities').expect(502);
    expect(res.body).toEqual({ error: 'Couldn’t reach your DorkOS account. Try again.' });
  });

  // Purpose: a refused read names the service's own code and status in the
  // log. Fails if the log line drops them back to a bare message.
  it('logs the problem code and status when a read is refused', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    script.listStatus = 503;
    script.list = { code: 'temporarily_unavailable', status: 503, title: 'Down for a moment.' };
    await request(server).get('/api/cloud/communities').expect(502);
    expect(warn).toHaveBeenCalledWith(
      '[Cloud] Could not read hosted communities',
      expect.objectContaining({ code: 'temporarily_unavailable', status: 503 })
    );
    warn.mockRestore();
  });

  // Purpose: a failed list waits for the reads it started beside it. Fails if
  // the route answers while the allowance read is still running, which is
  // how that read once reached the service during a later test (DOR-2298).
  it('does not answer a failed list while its other reads are still running', async () => {
    let release!: () => void;
    script.entitlementsGate = new Promise((resolve) => (release = resolve));
    script.list = '<html>proxy error</html>';
    let answered = false;
    const pending = request(server)
      .get('/api/cloud/communities')
      .then((res) => {
        answered = true;
        return res;
      });
    try {
      await vi.waitFor(() =>
        expect(received.some((r) => r.path === '/v1/entitlements')).toBe(true)
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(answered).toBe(false);
    } finally {
      release();
    }
    expect((await pending).status).toBe(502);
  });
});

describe('GET /api/cloud/communities/name-check', () => {
  // Purpose: a malformed name never becomes a request.
  it('refuses a name outside the grammar without asking the service', async () => {
    await request(server).get('/api/cloud/communities/name-check?name=Bad_Name').expect(400);
    expect(received).toHaveLength(0);
  });

  it('passes the service’s answer on', async () => {
    const res = await request(server)
      .get('/api/cloud/communities/name-check?name=night-shift')
      .expect(200);
    expect(res.body).toEqual({
      available: true,
      check: { name: 'night-shift', available: true, reason: null },
    });
  });
});

describe('starting a community and claiming it', () => {
  // Purpose: the claim link is a one-time credential; the start answer must
  // not carry it, and it must reach the browser only through claim-link.
  // Fails if the start relays the service body, or if the held link is never
  // used (a second, needless mint) or used twice.
  it('holds the first claim link back, hands it out once, then asks for a fresh one', async () => {
    const answer = startAnswer();
    script.startBody = answer;
    const start = await request(server)
      .post('/api/cloud/communities')
      .send({ idempotencyKey: 'key-1', name: 'Night shift', shortName: 'night-shift' })
      .expect(200);
    expect(start.body).toMatchObject({ ok: true, claimReady: true });
    expect(start.text).not.toContain(START_CLAIM_URL);
    const sent = JSON.parse(serviceRequests()[0]!.body.toString());
    expect(sent).toEqual({
      idempotencyKey: 'key-1',
      name: 'Night shift',
      shortName: 'night-shift',
    });

    const id = startFixture.community.communityId;
    const first = await request(server).post(`/api/cloud/communities/${id}/claim-link`).expect(200);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.body).toEqual({
      ok: true,
      claimUrl: START_CLAIM_URL,
      expiresAt: answer.claim.expiresAt,
    });
    expect(serviceRequests().filter((r) => r.path.endsWith('/claim-link'))).toHaveLength(0);

    const second = await request(server)
      .post(`/api/cloud/communities/${id}/claim-link`)
      .expect(200);
    expect(second.body.claimUrl).toBe(FRESH_CLAIM_URL);
    expect(serviceRequests().filter((r) => r.path.endsWith('/claim-link'))).toHaveLength(1);
  });

  // Purpose: a replayed start has no link to hold. Fails if claimReady lies.
  it('says no claim link is ready when the start was a replay', async () => {
    script.startBody = startReplayFixture;
    const res = await request(server)
      .post('/api/cloud/communities')
      .send({ idempotencyKey: 'key-1', name: 'Night shift' })
      .expect(200);
    expect(res.body).toMatchObject({ ok: true, claimReady: false });
  });

  // Purpose: the service's own words reach the person, with its link.
  it('passes a taken web address through as the service’s problem', async () => {
    script.startStatus = 409;
    script.startBody = nameTakenProblem;
    const res = await request(server)
      .post('/api/cloud/communities')
      .send({ idempotencyKey: 'k', name: 'Acme', shortName: 'acme' })
      .expect(200);
    expect(res.body).toEqual({ ok: false, problem: nameTakenProblem });
  });

  it('keeps an entitlement refusal’s action link, and drops a malformed one', async () => {
    script.startStatus = 403;
    script.startBody = entitlementProblem;
    const good = await request(server)
      .post('/api/cloud/communities')
      .send({ idempotencyKey: 'k', name: 'Acme' })
      .expect(200);
    expect(good.body.problem).toMatchObject({
      code: 'entitlement_required',
      actionUrl: entitlementProblem.actionUrl,
      actionLabel: entitlementProblem.actionLabel,
    });
    script.startBody = { ...entitlementProblem, actionUrl: 'javascript:alert(1)' };
    const bad = await request(server)
      .post('/api/cloud/communities')
      .send({ idempotencyKey: 'k', name: 'Acme' })
      .expect(200);
    expect(bad.body.problem.title).toBe(entitlementProblem.title);
    expect(bad.body.problem).not.toHaveProperty('actionUrl');
  });

  it('says the account could not be reached when the service answers nonsense', async () => {
    script.startStatus = 500;
    script.startBody = 'upstream exploded';
    const res = await request(server)
      .post('/api/cloud/communities')
      .send({ idempotencyKey: 'k', name: 'Acme' })
      .expect(200);
    // The service may have made the community before it broke, so a retry
    // with the same key is the safe next step.
    expect(res.body).toEqual({
      ok: false,
      message: 'Couldn’t reach your DorkOS account. Try again.',
      mayExist: true,
    });
  });

  it('refuses an empty name without asking the service', async () => {
    await request(server)
      .post('/api/cloud/communities')
      .send({ idempotencyKey: 'k', name: '   ' })
      .expect(400);
    expect(received).toHaveLength(0);
  });
});

describe('keep and restore', () => {
  it('echoes the confirmed preview to the service and relays the answer', async () => {
    const id = listFixture.items[2]!.communityId;
    const res = await request(server)
      .post(`/api/cloud/communities/${id}/keep`)
      .send({ expectedHeldCommunityIds: ['4f1c2b7e-8a3d-4e5f-9b6a-1c2d3e4f5a6b'] })
      .expect(200);
    expect(res.body).toMatchObject({ ok: true, heldCommunityIds: keepFixture.heldCommunityIds });
    expect(JSON.parse(serviceRequests()[0]!.body.toString())).toEqual({
      expectedHeldCommunityIds: ['4f1c2b7e-8a3d-4e5f-9b6a-1c2d3e4f5a6b'],
    });
    const restored = await request(server).post(`/api/cloud/communities/${id}/restore`).expect(200);
    expect(restored.body).toMatchObject({
      ok: true,
      community: { communityId: restoreFixture.communityId },
    });
  });
});

describe('moving a community in', () => {
  const archive = Buffer.from('PK\u0003\u0004 an owner export, byte for byte');
  const digest = createHash('sha256').update(archive).digest('hex');

  /** Start a move with the archive above as the body. */
  function startMoveRequest() {
    return request(server)
      .post(
        '/api/cloud/communities/moves?idempotencyKey=move-key&name=Old%20garden&shortName=old-garden'
      )
      .set('content-type', 'application/zip')
      .send(archive);
  }

  // Purpose: the upload token must never leave this process, the service must
  // be told the true size and digest, and the Community server must get the
  // exact bytes with the headers the contract names. Fails on any of those.
  it('measures the export, starts the move, and streams the bytes with the token itself', async () => {
    script.moveStartBody = moveStartAnswer();
    const res = await startMoveRequest().expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.move).toMatchObject({ moveId: 'move_0001', state: 'awaiting_upload' });
    expect(res.text).not.toContain(UPLOAD_TOKEN);

    const startSent = JSON.parse(
      serviceRequests()
        .find((r) => r.path === '/v1/communities/moves')!
        .body.toString()
    );
    expect(startSent).toEqual({
      idempotencyKey: 'move-key',
      name: 'Old garden',
      shortName: 'old-garden',
      archiveBytes: archive.length,
      archiveSha256: digest,
    });

    expect(await uploadSettled('move_0001')).toEqual({
      state: 'sent',
      sentBytes: archive.length,
      totalBytes: archive.length,
      failure: null,
    });
    const put = received.find((r) => r.method === 'PUT')!;
    expect(put.authorization).toBe(`Bearer ${UPLOAD_TOKEN}`);
    expect(put.headers['content-length']).toBe(String(archive.length));
    expect(put.headers['x-archive-sha256']).toBe(digest);
    expect(put.body.equals(archive)).toBe(true);
  });

  // Purpose (AC-15): when the Community server takes the file in parts, the export goes up as
  // numbered parts of at most partBytes, each with its own digest and the token as bearer, and
  // `complete` (asked again after a 202) puts them together; the token still never reaches the
  // browser. Fails if a part is too large, a digest is wrong, a byte is lost, or the token leaks.
  it('sends the export in parts when the Community server offers them', async () => {
    const answer = moveStartAnswer();
    script.moveStartBody = {
      ...answer,
      upload: { ...answer.upload, parts: { partBytes: 8, maxBytes: 1024 } },
    };
    script.completeStatus = [202];
    const res = await startMoveRequest().expect(200);
    expect(res.text).not.toContain(UPLOAD_TOKEN);
    expect(await uploadSettled('move_0001')).toEqual({
      state: 'sent',
      sentBytes: archive.length,
      totalBytes: archive.length,
      failure: null,
    });
    const puts = received.filter((r) => r.method === 'PUT');
    expect(puts.map((r) => r.path)).toEqual(
      Array.from(
        { length: Math.ceil(archive.length / 8) },
        (_, i) => `/upload/imp_0001/parts/${i + 1}`
      )
    );
    for (const put of puts) {
      expect(put.body.length).toBeLessThanOrEqual(8);
      expect(put.authorization).toBe(`Bearer ${UPLOAD_TOKEN}`);
      expect(put.headers['x-part-sha256']).toBe(
        createHash('sha256').update(put.body).digest('hex')
      );
    }
    expect(Buffer.concat(puts.map((r) => r.body)).equals(archive)).toBe(true);
    const completes = received.filter((r) => r.path === '/upload/imp_0001/complete');
    expect(completes).toHaveLength(2);
    expect(JSON.parse(completes[1].body.toString())).toEqual({
      parts: puts.length,
      archiveBytes: archive.length,
      archiveSha256: digest,
    });
    const poll = await request(server).get('/api/cloud/communities/moves/move_0001').expect(200);
    expect(poll.text).not.toContain(UPLOAD_TOKEN);
    expect(received.some((r) => r.method === 'PUT' && r.path === '/upload/imp_0001')).toBe(false);
  });

  // Purpose: move state is never cached here. Fails if a poll answers from memory.
  it('reads the move from the service on every poll', async () => {
    script.moveStartBody = moveStartAnswer();
    await startMoveRequest().expect(200);
    await uploadSettled('move_0001');
    const before = serviceRequests().length;
    const first = await request(server).get('/api/cloud/communities/moves/move_0001').expect(200);
    script.moveBody = { ...moveImportingFixture, state: 'ready', pollAfterMs: null };
    const second = await request(server).get('/api/cloud/communities/moves/move_0001').expect(200);
    expect(serviceRequests().length - before).toBe(2);
    expect(first.body.move.state).toBe('importing');
    expect(first.body.move.upload.state).toBe('sent');
    expect(second.body.move.state).toBe('ready');
    expect(first.text + second.text).not.toContain(UPLOAD_TOKEN);
  });

  // Purpose: a broken connection never reached a verdict, so the same copy can
  // go again. Fails if the copy is thrown away or a retry cannot reach it.
  it('sends the same file again after the connection breaks', async () => {
    script.moveStartBody = moveStartAnswer();
    script.uploadStatus = [0, 200];
    script.moveBody = { ...moveImportingFixture, state: 'awaiting_upload', report: null };
    await startMoveRequest().expect(200);
    expect(await uploadSettled('move_0001')).toMatchObject({
      state: 'failed',
      failure: 'interrupted',
    });
    expect(stagedCopies()).toHaveLength(1);
    const retry = await request(server)
      .post('/api/cloud/communities/moves/move_0001/upload')
      .expect(200);
    expect(retry.body.ok).toBe(true);
    expect(await uploadSettled('move_0001')).toMatchObject({ state: 'sent' });
    const puts = received.filter((r) => r.method === 'PUT');
    expect(puts.at(-1)!.body.equals(archive)).toBe(true);
    await vi.waitFor(() => expect(stagedCopies()).toHaveLength(0));
  });

  // Purpose: bytes the Community server refused would be refused again.
  // Fails if a retry is offered or the copy lingers.
  it('does not send refused bytes again, and lets go of the copy', async () => {
    script.moveStartBody = moveStartAnswer();
    script.uploadStatus = [400];
    await startMoveRequest().expect(200);
    expect(await uploadSettled('move_0001')).toMatchObject({
      state: 'failed',
      failure: 'rejected',
    });
    const retry = await request(server)
      .post('/api/cloud/communities/moves/move_0001/upload')
      .expect(200);
    expect(retry.body.ok).toBe(false);
    expect(received.filter((r) => r.method === 'PUT')).toHaveLength(1);
    await vi.waitFor(() => expect(stagedCopies()).toHaveLength(0));
  });

  // Purpose: a closed window spends the token for good. Fails if a retry is offered.
  it('does not send again once the upload window has closed', async () => {
    script.moveStartBody = moveStartAnswer();
    script.uploadStatus = [401];
    await startMoveRequest().expect(200);
    expect(await uploadSettled('move_0001')).toMatchObject({ state: 'failed', failure: 'expired' });
    const retry = await request(server)
      .post('/api/cloud/communities/moves/move_0001/upload')
      .expect(200);
    expect(retry.body).toMatchObject({ ok: false, message: expect.stringMatching(/start again/) });
    expect(received.filter((r) => r.method === 'PUT')).toHaveLength(1);
  });

  // Purpose: a replayed start comes with no token, so nothing is sent.
  it('sends nothing when the service answers a replay', async () => {
    script.moveStartBody = { ...moveStartAnswer(), upload: null, replayed: true };
    const res = await startMoveRequest().expect(200);
    expect(res.body.move.upload).toBeNull();
    expect(uploads.progress('move_0001')).toBeNull();
    expect(received.filter((r) => r.method === 'PUT')).toHaveLength(0);
    expect(stagedCopies()).toHaveLength(0);
  });

  // Purpose: the browser may leave after the last byte but before the move
  // starts (a cancel, a stall). Fails if a move is left running for nobody.
  it('cancels the move and sends nothing when the browser leaves before the answer', async () => {
    let release!: () => void;
    script.moveStartGate = new Promise((resolve) => (release = resolve));
    script.moveStartBody = moveStartAnswer();
    const port = (server.address() as AddressInfo).port;
    const client = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/api/cloud/communities/moves?idempotencyKey=gone&name=Old%20garden',
      headers: { 'content-type': 'application/zip', 'content-length': String(archive.length) },
    });
    client.on('error', () => {});
    client.end(archive);
    await vi.waitFor(() =>
      expect(received.some((r) => r.path === '/v1/communities/moves')).toBe(true)
    );
    client.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await vi.waitFor(() =>
      expect(received.some((r) => r.path === '/v1/communities/moves/move_0001/cancel')).toBe(true)
    );
    expect(uploads.progress('move_0001')).toBeNull();
    expect(received.filter((r) => r.method === 'PUT')).toHaveLength(0);
    await vi.waitFor(() => expect(stagedCopies()).toHaveLength(0));
  });

  it('forgets the upload and asks the service to cancel', async () => {
    script.moveStartBody = moveStartAnswer();
    await startMoveRequest().expect(200);
    await uploadSettled('move_0001');
    const res = await request(server)
      .post('/api/cloud/communities/moves/move_0001/cancel')
      .expect(200);
    expect(res.body).toMatchObject({ ok: true, move: { state: 'cancelled', upload: null } });
    expect(uploads.progress('move_0001')).toBeNull();
    await vi.waitFor(() => expect(stagedCopies()).toHaveLength(0));
  });

  it('refuses an empty file without starting a move', async () => {
    const res = await request(server)
      .post('/api/cloud/communities/moves?idempotencyKey=k&name=Old%20garden')
      .set('content-type', 'application/zip')
      .send(Buffer.alloc(0))
      .expect(400);
    expect(res.body.ok).toBe(false);
    expect(serviceRequests()).toHaveLength(0);
  });

  // Purpose: the service refuses an export by its declared size before any
  // upload, in its own words. Fails if the file is sent anyway.
  it('passes a too-large refusal through and sends nothing', async () => {
    const tooLarge = {
      code: 'import_too_large',
      status: 413,
      title: 'That export is too large to move.',
    };
    script.moveStartStatus = 413;
    script.moveStartBody = tooLarge;
    const res = await startMoveRequest().expect(200);
    expect(res.body).toEqual({ ok: false, problem: tooLarge });
    expect(received.filter((r) => r.method === 'PUT')).toHaveLength(0);
    expect(stagedCopies()).toHaveLength(0);
  });

  // Purpose (DOR-2611): a server error from the service does not say the move
  // was not made, so the refusal is marked `mayExist` and the app keeps its
  // key; a 4xx it described (above) made nothing and is not marked. Fails if
  // a 5xx problem, or no answer at all, reads as "nothing was made": the
  // app's retry could then start a second move.
  it('marks a refusal that may have made the move anyway', async () => {
    const unavailable = {
      code: 'temporarily_unavailable',
      status: 503,
      title: 'Try again shortly.',
    };
    script.moveStartStatus = 503;
    script.moveStartBody = unavailable;
    const fiveHundred = await startMoveRequest().expect(200);
    expect(fiveHundred.body).toEqual({ ok: false, problem: unavailable, mayExist: true });

    script.moveStartStatus = 200;
    script.moveStartBody = { nonsense: true };
    const nonsense = await startMoveRequest().expect(200);
    expect(nonsense.body).toEqual({
      ok: false,
      message: 'Couldn’t reach your DorkOS account. Try again.',
      mayExist: true,
    });
    expect(received.filter((r) => r.method === 'PUT')).toHaveLength(0);
    expect(stagedCopies()).toHaveLength(0);
  });

  // Purpose (DOR-2587): an export this computer has no room for is refused
  // with both numbers before a byte is copied or a move exists; one that just
  // fits goes ahead. Fails if the room check is missing, off by the headroom,
  // or runs after the move starts.
  it('refuses an export the disk has no room for, before a move starts', async () => {
    disk.free = archive.length + MOVE_STAGING_HEADROOM_BYTES - 1;
    const res = await startMoveRequest().expect(507);
    expect(res.body).toEqual({
      ok: false,
      message:
        'This computer doesn’t have room to hold the export. It needs 537 MB free and has 536 MB. Free up some space, then try again.',
    });
    expect(serviceRequests()).toHaveLength(0);
    expect(stagedCopies()).toHaveLength(0);

    disk.free = archive.length + MOVE_STAGING_HEADROOM_BYTES;
    script.moveStartBody = moveStartAnswer();
    const fits = await startMoveRequest().expect(200);
    expect(fits.body.ok).toBe(true);
    expect(await uploadSettled('move_0001')).toMatchObject({ state: 'sent' });
  });

  // Purpose (DOR-2587): when the free space cannot be read, the move is refused
  // rather than copied on hope. Fails if a statfs failure lets it through.
  it('refuses safely when the free space cannot be read', async () => {
    disk.fail = true;
    const res = await startMoveRequest().expect(507);
    expect(res.body).toMatchObject({ ok: false, message: expect.stringMatching(/free space/) });
    expect(serviceRequests()).toHaveLength(0);
    expect(stagedCopies()).toHaveLength(0);
  });

  // Purpose (DOR-2587): with no declared size there is no room check to make,
  // so a chunked body is refused before it is copied. Fails if it is staged.
  it('refuses an export that arrives without its size', async () => {
    const port = (server.address() as AddressInfo).port;
    const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const client = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/api/cloud/communities/moves?idempotencyKey=chunked&name=Old%20garden',
          headers: { 'content-type': 'application/zip', 'transfer-encoding': 'chunked' },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() })
          );
        }
      );
      client.on('error', reject);
      client.end(archive);
    });
    expect(answer.status).toBe(411);
    expect(JSON.parse(answer.body)).toMatchObject({ ok: false });
    expect(serviceRequests()).toHaveLength(0);
    expect(stagedCopies()).toHaveLength(0);
  });

  // Purpose (DOR-2611): a person who presses Start again after the host-limit
  // refusal, with the same file and name, reuses the same key, so the service
  // replays the move that refusal cancelled. Fails if the route answers `ok`
  // with a cancelled move (the app would show "cancelled" instead of a reason)
  // or keeps the second copy.
  it('refuses a replayed start of a move that was already cancelled, in plain words', async () => {
    const answer = moveStartAnswer();
    script.moveStartBody = {
      ...answer,
      upload: { ...answer.upload, maxBytes: archive.length - 1 },
    };
    await startMoveRequest().expect(413);

    script.moveStartBody = { move: moveCancelledFixture, upload: null, replayed: true };
    const again = await startMoveRequest().expect(409);
    expect(again.body).toEqual({
      ok: false,
      message:
        'That move was already cancelled, so nothing was sent on to DorkOS. Press Start moving to begin a new one.',
    });
    expect(received.filter((r) => r.method === 'PUT')).toHaveLength(0);
    expect(uploads.progress('move_0001')).toBeNull();
    expect(stagedCopies()).toHaveLength(0);
  });

  // Purpose (DOR-2587): the host's own limit decides, and a host that takes more
  // in parts than in one piece takes a move above its single-upload limit.
  // Fails if the single limit (or any fixed ceiling) refuses it.
  it('sends an export above the single-upload limit when the host takes it in parts', async () => {
    const answer = moveStartAnswer();
    script.moveStartBody = {
      ...answer,
      upload: {
        ...answer.upload,
        maxBytes: archive.length - 1,
        parts: { partBytes: 8, maxBytes: 1024 },
      },
    };
    const res = await startMoveRequest().expect(200);
    expect(res.body.ok).toBe(true);
    expect(await uploadSettled('move_0001')).toMatchObject({ state: 'sent' });
    expect(received.some((r) => r.path === '/upload/imp_0001/parts/1')).toBe(true);
  });

  // Purpose (DOR-2587): an export past everything the host offers is refused
  // in plain words before a byte leaves for the host, and the move that cannot
  // be filled is cancelled. Fails if the file is sent anyway or the move is
  // left waiting for an upload that will never come.
  it('refuses an export larger than the host takes, and cancels the move', async () => {
    const answer = moveStartAnswer();
    script.moveStartBody = {
      ...answer,
      upload: { ...answer.upload, maxBytes: archive.length - 1 },
    };
    const res = await startMoveRequest().expect(413);
    expect(res.body).toEqual({
      ok: false,
      message: `This export is too large to move. It is ${archive.length} bytes, and the most DorkOS takes is ${archive.length - 1} bytes.`,
    });
    expect(res.text).not.toContain(UPLOAD_TOKEN);
    expect(received.some((r) => r.path === '/v1/communities/moves/move_0001/cancel')).toBe(true);
    expect(received.filter((r) => r.method === 'PUT')).toHaveLength(0);
    expect(uploads.progress('move_0001')).toBeNull();
    expect(stagedCopies()).toHaveLength(0);
  });

  // Purpose (DOR-2611): when the cancel after a too-large refusal does not go
  // through, the move still exists, so the refusal says so and the app keeps
  // its key. Fails if a failed cancel is answered like a clean one.
  it('marks the too-large refusal when the move could not be cancelled', async () => {
    const answer = moveStartAnswer();
    script.moveStartBody = {
      ...answer,
      upload: { ...answer.upload, maxBytes: archive.length - 1 },
    };
    script.cancelStatus = 503;
    const res = await startMoveRequest().expect(413);
    expect(res.body).toMatchObject({ ok: false, mayExist: true });
    expect(received.some((r) => r.path === '/v1/communities/moves/move_0001/cancel')).toBe(true);
    expect(received.filter((r) => r.method === 'PUT')).toHaveLength(0);
    expect(stagedCopies()).toHaveLength(0);
  });

  // Purpose (DOR-2587): a parted limit smaller than the export is still the
  // host's limit. Fails if offering parts at all lets any size through.
  it('refuses an export larger than the host takes even in parts', async () => {
    const answer = moveStartAnswer();
    script.moveStartBody = {
      ...answer,
      upload: {
        ...answer.upload,
        maxBytes: archive.length - 2,
        parts: { partBytes: 8, maxBytes: archive.length - 1 },
      },
    };
    await startMoveRequest().expect(413);
    expect(received.filter((r) => r.method === 'PUT')).toHaveLength(0);
    expect(stagedCopies()).toHaveLength(0);
  });
});

describe('GET /api/cloud/communities/moves/room', () => {
  /** Ask whether `bytes` would fit. */
  function askRoom(bytes: number | string) {
    return request(server).get(`/api/cloud/communities/moves/room?bytes=${bytes}`);
  }

  // Purpose (DOR-2610): the app asks before sending, and a file that won't fit
  // is refused with both numbers, in the same words the upload itself would
  // use, and with nothing sent to the service. Fails if the check is missing,
  // is read as a move id, or words its refusal differently.
  it('refuses a size the disk has no room for, with both numbers, and passes one that fits', async () => {
    const bytes = 1_000;
    disk.free = bytes + MOVE_STAGING_HEADROOM_BYTES - 1;
    const refused = await askRoom(bytes).expect(200);
    expect(refused.body).toEqual({
      ok: false,
      message:
        'This computer doesn’t have room to hold the export. It needs 537 MB free and has 536 MB. Free up some space, then try again.',
    });

    disk.free = bytes + MOVE_STAGING_HEADROOM_BYTES;
    const fits = await askRoom(bytes).expect(200);
    expect(fits.body).toEqual({ ok: true });
    expect(received).toHaveLength(0);
    expect(stagedCopies()).toHaveLength(0);
  });

  // Purpose (DOR-2610): asking first holds nothing back, so the real upload
  // that follows is not counted twice against the same free space. Fails if
  // the room check reserves the bytes: the upload, on a disk with room for
  // exactly one copy, would then be refused.
  it('does not count the same export twice when the upload follows', async () => {
    const archive = Buffer.from('PK\u0003\u0004 an owner export');
    disk.free = archive.length + MOVE_STAGING_HEADROOM_BYTES;
    expect((await askRoom(archive.length).expect(200)).body).toEqual({ ok: true });
    script.moveStartBody = moveStartAnswer();
    const res = await request(server)
      .post('/api/cloud/communities/moves?idempotencyKey=after-room&name=Old%20garden')
      .set('content-type', 'application/zip')
      .send(archive)
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(await uploadSettled('move_0001')).toMatchObject({ state: 'sent' });
  });

  // Purpose (DOR-2610): the same refusals as the upload for an empty file and
  // an unreadable disk. Fails if either is let through as fitting.
  it('refuses an empty file and a disk whose free space cannot be read', async () => {
    const empty = await askRoom(0).expect(200);
    expect(empty.body).toMatchObject({ ok: false, message: expect.stringMatching(/empty/) });
    disk.fail = true;
    const unknown = await askRoom(10).expect(200);
    expect(unknown.body).toMatchObject({ ok: false, message: expect.stringMatching(/free space/) });
  });

  it('refuses a size that is not a whole number of bytes', async () => {
    await askRoom('ten').expect(400);
    await askRoom('-1').expect(400);
    await askRoom('1e30').expect(400);
    await askRoom(String(Number.MAX_SAFE_INTEGER) + '0').expect(400);
  });
});
