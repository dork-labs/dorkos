import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CommunityRefSchema } from '@dorkos/shared/community-adapter';

vi.mock('../room-caller.js', () => ({
  resolveCaller: (req: { headers: Record<string, string> }) => {
    if (req.headers['x-dorkos-agent']) throw new Error('Agent identity');
    return { id: req.headers['x-test-author'] ?? 'author-a' };
  },
}));
vi.mock('../../services/rooms/index.js', () => ({
  getRoomService: () => ({ authorRegistry: { isOwner: (id: string) => id === 'author-a' } }),
}));
vi.mock('../../services/core/auth/index.js', () => ({
  readOwnerAccount: () => ({ id: 'user-a' }),
}));
vi.mock('../../lib/caller-authority.js', () => ({
  isLocalCaller: () => true,
  requireOperatorCookieUnderLogin: () => undefined,
}));

import { createCommunityConnectionsRouter } from '../community-connections.js';
import { RemoteConnectionStore } from '../../services/communities/remote/connection-store.js';
import { RemoteCommunityPairingService } from '../../services/communities/remote/pairing-service.js';

let directory: string;
let app: ReturnType<typeof express>;
let server: Server;
const ref = CommunityRefSchema.parse('remote_owner_a');
const navigation = {
  get: vi.fn(async () => ({ order: [ref], destinations: [] })),
  move: vi.fn(async () => ({ order: [ref], destinations: [] })),
  remember: vi.fn(async () => ({ order: [ref], destinations: [] })),
  resolve: vi.fn(async () => null),
};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'community-route-'));
  const store = new RemoteConnectionStore(directory);
  await store.addPending(
    {
      ref,
      ownerKey: 'author-a',
      remoteCommunityId: 'remote-community',
      label: 'Private group',
      pinnedOrigin: 'https://community.example',
      pairingId: 'pairing-private',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    'private-verifier'
  );
  app = express();
  app.use(express.json());
  app.use(
    '/api/community-connections',
    createCommunityConnectionsRouter(new RemoteCommunityPairingService(store), navigation as never)
  );
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('local connection route authority and public projection', () => {
  it('shows only the trusted owner and excludes pairing proof', async () => {
    const response = await request(server)
      .get('/api/community-connections')
      .set('x-test-author', 'author-a');
    expect(response.status).toBe(200);
    expect(response.body.connections).toHaveLength(1);
    expect(JSON.stringify(response.body)).not.toContain('pairing-private');
    expect(JSON.stringify(response.body)).not.toContain('private-verifier');
    expect(response.body.connections[0].ref).toBe(ref);
    expect(
      (await request(server).get('/api/community-connections').set('x-test-author', 'author-b'))
        .status
    ).toBe(403);
    expect(
      (
        await request(server)
          .get(`/api/community-connections/${ref}`)
          .set('x-test-author', 'author-b')
      ).status
    ).toBe(403);
    expect(
      (
        await request(server)
          .post(`/api/community-connections/${ref}/poll`)
          .set('x-dorkos-agent', 'agent-token')
      ).status
    ).toBe(403);
  });

  it('disconnects only when the trusted caller is the local owner', async () => {
    expect(
      (
        await request(server)
          .delete(`/api/community-connections/${ref}`)
          .set('x-test-author', 'author-b')
      ).status
    ).toBe(403);
    expect(
      (
        await request(server)
          .delete(`/api/community-connections/${ref}`)
          .set('x-test-author', 'author-a')
      ).status
    ).toBe(204);
    expect(
      (await request(server).get('/api/community-connections').set('x-test-author', 'author-a'))
        .body.connections
    ).toEqual([]);
  });

  it('keeps navigation state behind owner authority and static routes', async () => {
    expect(
      (
        await request(server)
          .get('/api/community-connections/navigation')
          .set('x-test-author', 'author-b')
      ).status
    ).toBe(403);
    const response = await request(server)
      .get('/api/community-connections/navigation')
      .set('x-test-author', 'author-a');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ order: [ref], destinations: [] });
    expect(navigation.get).toHaveBeenCalledWith('author-a');

    expect(
      (
        await request(server)
          .post('/api/community-connections/navigation/move')
          .set('x-test-author', 'author-a')
          .send({ ref, direction: 'sideways' })
      ).status
    ).toBe(400);
  });
});
