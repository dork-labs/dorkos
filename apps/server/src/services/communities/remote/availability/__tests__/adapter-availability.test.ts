/**
 * The real adapter against a fixture space over HTTP, both ways round (DOR-2878): a space from
 * before availability (no `/features`, the old member list) and a space with it. An app that
 * reports must stay silent and show nothing new against the first, and use the second fully.
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import { RemoteCommunityMembersResponseSchema } from '@dorkos/shared/community-views';
import { logger } from '../../../../../lib/logger.js';
import { RemoteConnectionStore } from '../../connection-store.js';
import { RemoteCommunityAdapter } from '../../remote-community-adapter.js';
import { AgentAvailabilityReporter } from '../agent-availability-reporter.js';

const remoteCommunityId = randomUUID();
const roomId = randomUUID();
const ownerMemberId = randomUUID();
const agentMemberId = randomUUID();
const token = 'availability-fixture-grant';
const ownerKey = 'owner-author';
const base = `/api/v1/communities/${remoteCommunityId}`;

/** `old`: a space from before availability. `new`: one with it. */
let mode: 'old' | 'new' = 'new';
/** What the next report answers with, when not a normal acceptance. */
let reportStatus = 200;
const requests: Array<{ method: string; url: string; authorization?: string; body?: unknown }> = [];
let server: Server;
let origin: string;
let directory: string;
let store: RemoteConnectionStore;
let ref: CommunityRef;

function send(res: ServerResponse, value: unknown, status = 200) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(value));
}

const person = {
  memberId: ownerMemberId,
  kind: 'human',
  displayName: 'Dana',
  handle: 'dana',
  role: 'owner',
  ownerMemberId: null,
  ownerDisplayName: null,
  joinedAt: '2026-10-01T00:00:00.000Z',
};
const agent = {
  memberId: agentMemberId,
  kind: 'agent',
  displayName: 'Scout',
  handle: 'scout',
  role: null,
  ownerMemberId,
  ownerDisplayName: 'Dana',
  joinedAt: '2026-10-01T00:00:00.000Z',
};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'community-availability-'));
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const url = req.url ?? '';
    requests.push({
      method: req.method ?? '',
      url,
      authorization: req.headers.authorization,
      body,
    });
    if (url === `${base}/features`) {
      // An old space has no such route: Hono's plain-text not-found, no error code.
      if (mode === 'old') {
        res.statusCode = 404;
        res.end('404 Not Found');
        return;
      }
      return send(res, { features: { agentAvailability: true } });
    }
    if (req.headers.authorization !== `Bearer ${token}`)
      return send(res, { code: 'UNAUTHENTICATED', message: 'No.' }, 401);
    if (url.startsWith(`${base}/channels/${roomId}/members`)) {
      // A new space adds the fields only when asked; an old one never knows to.
      const asked = mode === 'new' && url.endsWith('?include=availability');
      return send(res, {
        members: [
          person,
          asked
            ? {
                ...agent,
                runsOn: 'computer',
                lastSeenAt: '2026-10-15T10:00:00.000Z',
                availability: 'available',
              }
            : agent,
        ],
      });
    }
    if (url === `${base}/agents/availability` && req.method === 'POST') {
      if (mode === 'old' || reportStatus === 404) {
        res.statusCode = 404;
        res.end('404 Not Found');
        return;
      }
      if (reportStatus !== 200) return send(res, { code: 'INTERNAL', message: 'x' }, reportStatus);
      const named = (body as { agents: Array<{ agentId: string }> }).agents.map(
        (item) => item.agentId
      );
      return send(res, {
        accepted: named.filter((id) => id === agentMemberId),
        refused: named.filter((id) => id !== agentMemberId),
        reportEverySeconds: 90,
      });
    }
    return send(res, { code: 'NOT_FOUND', message: 'Not found.' }, 404);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture has no port');
  origin = `http://127.0.0.1:${address.port}`;
  store = new RemoteConnectionStore(directory);
  ref = randomUUID() as CommunityRef;
  await store.addPending(
    {
      ref,
      ownerKey,
      remoteCommunityId,
      label: 'Fixture space',
      pinnedOrigin: origin,
      pairingId: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    randomUUID()
  );
  const capabilities = { read: true, post: true, enrollAgent: true, stream: true };
  await store.complete(ref, ownerKey, ownerMemberId, token, {
    state: 'verified',
    effective: capabilities,
    lastKnown: { lifecycle: 'active', capabilities, verifiedAt: new Date().toISOString() },
  });
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

beforeEach(() => {
  requests.length = 0;
  reportStatus = 200;
  vi.restoreAllMocks();
});

/** A reporter over the real adapter, for one agent this installation enrolled. */
function reporterFor(adapter: RemoteCommunityAdapter, onFailing = vi.fn()) {
  return new AgentAvailabilityReporter({
    space: adapter,
    agents: () => [{ agentId: agentMemberId, localAgentId: 'scout-local' }],
    runsOn: () => 'computer',
    reachable: () => true,
    onFailing,
  });
}

function quietLogs() {
  return [
    vi.spyOn(logger, 'warn'),
    vi.spyOn(logger, 'error'),
    vi.spyOn(logger, 'info'),
    vi.spyOn(logger, 'debug'),
  ];
}

describe('a new app against a space from before availability', () => {
  beforeEach(() => {
    mode = 'old';
  });

  it('sends no report, logs nothing, and calls nothing a failure', async () => {
    const logs = quietLogs();
    const adapter = new RemoteCommunityAdapter(ref, ownerKey, store);
    expect(await adapter.supportsAgentAvailability()).toBe(false);
    const onFailing = vi.fn();
    const reporter = reporterFor(adapter, onFailing);
    await reporter.reportNow();
    reporter.dispose();
    expect(requests.some((request) => request.url.endsWith('/agents/availability'))).toBe(false);
    expect(onFailing).not.toHaveBeenCalled();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it('reads the member list without the new query, and shows no status', async () => {
    const adapter = new RemoteCommunityAdapter(ref, ownerKey, store);
    const members = await adapter.listMembers(roomId);
    const memberReads = requests.filter((request) => request.url.includes('/members'));
    expect(memberReads.map((request) => request.url)).toEqual([
      `${base}/channels/${roomId}/members`,
    ]);
    for (const member of members) {
      expect(member).not.toHaveProperty('availability');
      expect(member).not.toHaveProperty('lastSeenAt');
      expect(member).not.toHaveProperty('runsOn');
    }
    // The app's own strict roster schema still reads the old shape.
    expect(() =>
      RemoteCommunityMembersResponseSchema.parse({ community: ref, roomId, members, stale: false })
    ).not.toThrow();
  });
});

describe('a new app against a space with availability', () => {
  beforeEach(() => {
    mode = 'new';
  });

  it('reads the features without a credential', async () => {
    const adapter = new RemoteCommunityAdapter(ref, ownerKey, store);
    expect(await adapter.supportsAgentAvailability()).toBe(true);
    const read = requests.find((request) => request.url.endsWith('/features'));
    expect(read?.authorization).toBeUndefined();
  });

  it('reports its own agent with its own grant, and leaves out the one refused', async () => {
    const adapter = new RemoteCommunityAdapter(ref, ownerKey, store);
    const answer = await adapter.reportAgentAvailability({
      agents: [
        { agentId: agentMemberId, runsOn: 'computer' },
        { agentId: 'someone-elses', runsOn: 'computer' },
      ],
    });
    expect(answer).toEqual({
      accepted: [agentMemberId],
      refused: ['someone-elses'],
      reportEverySeconds: 90,
    });
    const report = requests.find((request) => request.url.endsWith('/agents/availability'));
    expect(report?.authorization).toBe(`Bearer ${token}`);
    expect(report?.body).toEqual({
      agents: [
        { agentId: agentMemberId, runsOn: 'computer' },
        { agentId: 'someone-elses', runsOn: 'computer' },
      ],
    });
  });

  it('a reporter sends exactly the enrolled agent, availability and nothing else', async () => {
    const adapter = new RemoteCommunityAdapter(ref, ownerKey, store);
    const reporter = reporterFor(adapter);
    await reporter.reportNow();
    reporter.dispose();
    const reports = requests.filter((request) => request.url.endsWith('/agents/availability'));
    expect(reports.map((request) => request.body)).toEqual([
      { agents: [{ agentId: agentMemberId, runsOn: 'computer' }] },
    ]);
  });

  it('asks for availability on the member list and carries it on the agent row only', async () => {
    const adapter = new RemoteCommunityAdapter(ref, ownerKey, store);
    const members = await adapter.listMembers(roomId);
    expect(requests.find((request) => request.url.includes('/members'))?.url).toBe(
      `${base}/channels/${roomId}/members?include=availability`
    );
    expect(members.find((member) => member.kind === 'human')).not.toHaveProperty('availability');
    expect(members.find((member) => member.kind === 'agent')).toMatchObject({
      availability: 'available',
      lastSeenAt: '2026-10-15T10:00:00.000Z',
      runsOn: 'computer',
    });
    expect(() =>
      RemoteCommunityMembersResponseSchema.parse({ community: ref, roomId, members, stale: false })
    ).not.toThrow();
  });

  it('forgets the feature when a report answers 404, and asks the space again', async () => {
    const adapter = new RemoteCommunityAdapter(ref, ownerKey, store);
    expect(await adapter.supportsAgentAvailability()).toBe(true);
    reportStatus = 404;
    await expect(
      adapter.reportAgentAvailability({ agents: [{ agentId: agentMemberId, runsOn: 'computer' }] })
    ).rejects.toMatchObject({ status: 404 });
    requests.length = 0;
    await adapter.supportsAgentAvailability();
    expect(requests.filter((request) => request.url.endsWith('/features'))).toHaveLength(1);
  });

  it('tells the reporter once when the space fails, and keeps the grant', async () => {
    const onFailing = vi.fn();
    reportStatus = 503;
    const adapter = new RemoteCommunityAdapter(ref, ownerKey, store);
    const reporter = reporterFor(adapter, onFailing);
    await reporter.reportNow();
    await reporter.reportNow();
    reporter.dispose();
    expect(onFailing).toHaveBeenCalledTimes(1);
    expect((await store.get(ref, ownerKey)).status).toBe('connected');
  });
});
