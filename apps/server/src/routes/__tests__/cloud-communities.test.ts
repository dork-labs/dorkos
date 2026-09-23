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
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
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

const { createCloudCommunitiesRouter } = await import('../cloud-communities.js');
const { CommunityMoveUploads } = await import('../../services/core/cloud/community-move-upload.js');

/** The one-time credentials the fixtures carry. None may ever reach the browser uninvited. */
const START_CLAIM_URL = startFixture.claim.claimUrl;
const FRESH_CLAIM_URL = 'https://community.example.invalid/claim/ct_opaque_fresh';
const UPLOAD_TOKEN = moveStartFixture.upload.token;

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
  startStatus: number;
  startBody: unknown;
  moveStartStatus: number;
  moveStartBody: unknown;
  moveBody: unknown;
  uploadStatus: number[];
  entitlements: unknown;
}

let script: Script;
const received: Received[] = [];

function defaultScript(): Script {
  return {
    list: listFixture,
    startStatus: 200,
    startBody: startFixture,
    moveStartStatus: 200,
    moveStartBody: null,
    moveBody: moveImportingFixture,
    uploadStatus: [200],
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
  if (route === 'GET /v1/communities') return send(res, 200, script.list);
  if (route === 'GET /v1/communities/moves') return send(res, 200, movesFixture);
  if (route === 'GET /v1/entitlements') return send(res, 200, script.entitlements);
  if (route === 'GET /v1/communities/name-check') {
    return send(res, 200, { ...nameFreeFixture, name: url.searchParams.get('name') });
  }
  if (route === 'POST /v1/communities') return send(res, script.startStatus, script.startBody);
  if (route.startsWith('POST /v1/communities/') && route.endsWith('/claim-link')) {
    return send(res, 200, { ...claimLinkFixture, claimUrl: FRESH_CLAIM_URL });
  }
  if (route.endsWith('/keep')) return send(res, 200, keepFixture);
  if (route.endsWith('/restore')) return send(res, 200, restoreFixture);
  if (route === 'POST /v1/communities/moves') {
    return send(res, script.moveStartStatus, script.moveStartBody);
  }
  if (route === 'POST /v1/communities/moves/move_0001/cancel') {
    return send(res, 200, moveCancelledFixture);
  }
  if (route === 'GET /v1/communities/moves/move_0001') return send(res, 200, script.moveBody);
  if (route === 'PUT /upload/imp_0001') {
    const status = script.uploadStatus.shift() ?? 200;
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

/** A move-start answer whose upload goes to the fake upload route. */
function moveStartAnswer() {
  return {
    ...moveStartFixture,
    upload: { ...moveStartFixture.upload, url: `${fakeOrigin()}/upload/imp_0001` },
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

beforeAll(() => {
  service.baseUrl = fakeOrigin();
});

beforeEach(() => {
  config.cloud = { instanceToken: 'tok_instance' };
  script = defaultScript();
  received.length = 0;
  uploads = new CommunityMoveUploads();
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
    const claim = await request(server)
      .post(`/api/cloud/communities/${startFixture.community.communityId}/claim-link`)
      .expect(200);
    expect(claim.body.ok).toBe(false);
    expect(received).toHaveLength(0);
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
      expiresAt: startFixture.claim.expiresAt,
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
    expect(res.body).toEqual({
      ok: false,
      message: 'Couldn’t reach your DorkOS account. Try again.',
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

  // Purpose: a refused upload keeps the token usable, so sending again works.
  // Fails if a rejection throws the file away or a retry cannot reach it.
  it('sends the same file again after the Community server refuses it', async () => {
    script.moveStartBody = moveStartAnswer();
    script.uploadStatus = [400, 200];
    script.moveBody = { ...moveImportingFixture, state: 'awaiting_upload', report: null };
    await startMoveRequest().expect(200);
    expect(await uploadSettled('move_0001')).toMatchObject({
      state: 'failed',
      failure: 'rejected',
    });
    const retry = await request(server)
      .post('/api/cloud/communities/moves/move_0001/upload')
      .expect(200);
    expect(retry.body.ok).toBe(true);
    expect(await uploadSettled('move_0001')).toMatchObject({ state: 'sent' });
    const puts = received.filter((r) => r.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(puts[1]!.body.equals(archive)).toBe(true);
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
  });
});
