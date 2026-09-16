/**
 * The native remote CommunityAdapter against a real Community HTTP server and
 * disposable Postgres database. The fixture creates only server-owned setup
 * rows; every port operation goes through the pinned HTTP client.
 *
 * @vitest-environment node
 */
import { randomUUID } from 'node:crypto';
import { createDb, runMigrations } from '@dorkos/db';
import { CommunityAgentEnrollmentStore } from '../../../server/src/services/communities/remote/agent-enrollment-store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { Pool } from 'pg';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { communityConformance } from '@dorkos/test-utils';
import {
  CommunityRoomNotFoundError,
  StaleCommunityCursorError,
  type CommunityAdapter,
  type CommunityRef,
} from '@dorkos/shared/community-adapter';
import { createCommunityApp } from '../app.js';
import { parseConfig } from '../config.js';
import { migrate } from '../migrate.js';
import { hashSecret } from '../security.js';
import { RemoteConnectionStore } from '../../../server/src/services/communities/remote/connection-store.js';
import {
  RemoteCommunityAdapter,
  remoteAuthorOf,
  remoteSequenceOf,
} from '../../../server/src/services/communities/remote/remote-community-adapter.js';

const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl)
  throw new Error('COMMUNITY_TEST_DATABASE_URL is required for remote adapter conformance');

const admin = new Pool({ connectionString: adminUrl });
const databaseName = `community_remote_conformance_${randomUUID().replaceAll('-', '')}`;
const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${databaseName}`;
const secondDatabaseName = `community_remote_conformance_second_${randomUUID().replaceAll('-', '')}`;
const secondDatabaseUrl = new URL(adminUrl);
secondDatabaseUrl.pathname = `/${secondDatabaseName}`;
const ownerKey = 'remote-adapter-conformance-owner';
const plantedCredential = 'remote-adapter-private-bearer-never-in-port-dtos';
let pool: Pool;
let server: ReturnType<typeof serve>;
let secondPool: Pool;
let secondServer: ReturnType<typeof serve>;
let storageDirectory: string;
let localDirectory: string;
let baseUrl = '';
let secondBaseUrl = '';
let store: RemoteConnectionStore;
let communityId = '';
let ownerMemberId = '';
let secondCommunityId = '';
let secondOwnerMemberId = '';
const secondCredential = 'remote-adapter-second-community-bearer';
let ref: CommunityRef;
let unreachableRef: CommunityRef;
let secondRef: CommunityRef;
let unauthorizedRef: CommunityRef;

const config = parseConfig({
  COMMUNITY_DATABASE_URL: databaseUrl.toString(),
  COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
  COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
  COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
  COMMUNITY_PUBLIC_URL: 'http://localhost:6481',
  COMMUNITY_STORAGE_PATH: '/tmp/community-remote-conformance-blobs',
});

/** Create a private local credential record without putting the bearer in a DTO. */
async function connect(
  refToUse: CommunityRef,
  origin: string,
  token = plantedCredential,
  remoteCommunityId = communityId,
  memberId = ownerMemberId
) {
  await store.addPending(
    {
      ref: refToUse,
      ownerKey,
      remoteCommunityId,
      label: 'Conformance Community',
      pinnedOrigin: origin,
      pairingId: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    randomUUID()
  );
  await store.complete(refToUse, ownerKey, memberId, token);
}

/** Seed one joined channel and write history through the public adapter. */
async function seedRoom(adapter: CommunityAdapter): Promise<string> {
  const targetPool = adapter.community === secondRef ? secondPool : pool;
  const targetCommunityId = adapter.community === secondRef ? secondCommunityId : communityId;
  const targetMemberId = adapter.community === secondRef ? secondOwnerMemberId : ownerMemberId;
  const result = await targetPool.query<{ id: string }>(
    "INSERT INTO channels(community_id,name,visibility) VALUES($1,$2,'private') RETURNING id",
    [targetCommunityId, `Conformance ${randomUUID()}`]
  );
  const roomId = result.rows[0]!.id;
  await targetPool.query('INSERT INTO channel_members(channel_id,member_id) VALUES($1,$2)', [
    roomId,
    targetMemberId,
  ]);
  await adapter.post(roomId, { text: 'first fixture entry', idempotencyKey: randomUUID() });
  await adapter.post(roomId, { text: 'second fixture entry', idempotencyKey: randomUUID() });
  // Seeded rooms represent the already-projected room list a UI subscription
  // watches; the later membership removal must therefore be observable as a
  // removal rather than as a never-seen room.
  await adapter.listRooms();
  return roomId;
}

beforeAll(async () => {
  storageDirectory = await mkdtemp(join(tmpdir(), 'community-remote-conformance-blobs-'));
  localDirectory = await mkdtemp(join(tmpdir(), 'community-remote-conformance-local-'));
  await admin.query(`CREATE DATABASE ${databaseName}`);
  await migrate(databaseUrl.toString());
  pool = new Pool({ connectionString: databaseUrl.toString() });
  const app = createCommunityApp({
    config: { ...config, storage: { kind: 'filesystem', directory: storageDirectory } },
    pool,
  });
  server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Community HTTP server has no port');
  baseUrl = `http://127.0.0.1:${address.port}`;

  const community = await pool.query<{ id: string }>(
    "INSERT INTO communities(name) VALUES('Remote conformance') RETURNING id"
  );
  communityId = community.rows[0]!.id;
  const userId = randomUUID();
  await pool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [
    userId,
    'Conformance Owner',
    `remote-conformance-${randomUUID()}@example.test`,
  ]);
  const member = await pool.query<{ id: string }>(
    "INSERT INTO members(community_id,user_id,display_name,handle,role) VALUES($1,$2,$3,$4,'owner') RETURNING id",
    [communityId, userId, 'Conformance Owner', `owner-${randomUUID().slice(0, 8)}`]
  );
  ownerMemberId = member.rows[0]!.id;
  await pool.query(
    'INSERT INTO community_handles(community_id,handle,member_id) SELECT community_id,handle,id FROM members WHERE id=$1',
    [ownerMemberId]
  );

  await admin.query(`CREATE DATABASE ${secondDatabaseName}`);
  await migrate(secondDatabaseUrl.toString());
  secondPool = new Pool({ connectionString: secondDatabaseUrl.toString() });
  // Keep the signing secret deliberately identical: only the authenticated
  // immutable community id may distinguish cursors issued by these servers.
  const secondConfig = parseConfig({
    COMMUNITY_DATABASE_URL: secondDatabaseUrl.toString(),
    COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
    COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
    COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
    COMMUNITY_PUBLIC_URL: 'http://localhost:6481',
    COMMUNITY_STORAGE_PATH: storageDirectory,
  });
  const secondApp = createCommunityApp({
    config: { ...secondConfig, storage: { kind: 'filesystem', directory: storageDirectory } },
    pool: secondPool,
  });
  secondServer = serve({ fetch: secondApp.fetch, port: 0 });
  await new Promise<void>((resolve) => secondServer.once('listening', resolve));
  const secondAddress = secondServer.address();
  if (!secondAddress || typeof secondAddress === 'string')
    throw new Error('Second Community HTTP server has no port');
  secondBaseUrl = `http://127.0.0.1:${secondAddress.port}`;
  const secondCommunity = await secondPool.query<{ id: string }>(
    "INSERT INTO communities(name) VALUES('Remote conformance second') RETURNING id"
  );
  secondCommunityId = secondCommunity.rows[0]!.id;
  const secondUserId = randomUUID();
  await secondPool.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)', [
    secondUserId,
    'Second Owner',
    `second-${randomUUID()}@example.test`,
  ]);
  const secondMember = await secondPool.query<{ id: string }>(
    "INSERT INTO members(community_id,user_id,display_name,handle,role) VALUES($1,$2,$3,$4,'owner') RETURNING id",
    [secondCommunityId, secondUserId, 'Second Owner', `second-${randomUUID().slice(0, 8)}`]
  );
  secondOwnerMemberId = secondMember.rows[0]!.id;
  await secondPool.query(
    'INSERT INTO community_handles(community_id,handle,member_id) SELECT community_id,handle,id FROM members WHERE id=$1',
    [secondOwnerMemberId]
  );
  await secondPool.query(
    'INSERT INTO connection_grants(member_id,token_hash,scopes,install_name) VALUES($1,$2,$3,$4)',
    [secondOwnerMemberId, hashSecret(secondCredential), ['read', 'post', 'enroll-agent'], 'Second']
  );
  await pool.query(
    'INSERT INTO connection_grants(member_id,token_hash,scopes,install_name) VALUES($1,$2,$3,$4)',
    [ownerMemberId, hashSecret(plantedCredential), ['read', 'post', 'enroll-agent'], 'Conformance']
  );

  ref = randomUUID() as CommunityRef;
  unreachableRef = randomUUID() as CommunityRef;
  secondRef = randomUUID() as CommunityRef;
  unauthorizedRef = randomUUID() as CommunityRef;
});

beforeEach(async () => {
  await pool.query('UPDATE members SET active=true WHERE community_id=$1', [communityId]);
  await pool.query(
    'DELETE FROM community_handles WHERE agent_id IN (SELECT id FROM agents WHERE owner_member_id=$1)',
    [ownerMemberId]
  );
  await pool.query(
    'DELETE FROM agent_credentials WHERE agent_id IN (SELECT id FROM agents WHERE owner_member_id=$1)',
    [ownerMemberId]
  );
  await pool.query(
    'DELETE FROM agent_channel_members WHERE agent_id IN (SELECT id FROM agents WHERE owner_member_id=$1)',
    [ownerMemberId]
  );
  await pool.query(
    'DELETE FROM entries WHERE author_agent_id IN (SELECT id FROM agents WHERE owner_member_id=$1)',
    [ownerMemberId]
  );
  await pool.query('DELETE FROM agents WHERE owner_member_id=$1', [ownerMemberId]);
  await rm(localDirectory, { recursive: true, force: true });
  store = new RemoteConnectionStore(localDirectory);
  await connect(ref, baseUrl);
  await connect(unreachableRef, 'http://127.0.0.1:9');
  await connect(secondRef, secondBaseUrl, secondCredential, secondCommunityId, secondOwnerMemberId);
  await connect(unauthorizedRef, baseUrl, 'revoked-or-wrong-grant');
});

afterAll(async () => {
  await new Promise<void>((resolve) => secondServer?.close(() => resolve()));
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await secondPool?.end();
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${secondDatabaseName}`);
  await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
  await admin.end();
  await rm(storageDirectory, { recursive: true, force: true });
  await rm(localDirectory, { recursive: true, force: true });
});

communityConformance(() => new RemoteCommunityAdapter(ref, ownerKey, store), {
  name: 'RemoteCommunityAdapter — real HTTP/Postgres conformance',
  plantedCredential,
  seedRoom,
  seedEmptyRoom: async () => {
    const result = await pool.query<{ id: string }>(
      "INSERT INTO channels(community_id,name,visibility) VALUES($1,$2,'private') RETURNING id",
      [communityId, `Empty ${randomUUID()}`]
    );
    const roomId = result.rows[0]!.id;
    await pool.query('INSERT INTO channel_members(channel_id,member_id) VALUES($1,$2)', [
      roomId,
      ownerMemberId,
    ]);
    return roomId;
  },
  makeEvictedRoom: async (_adapter, roomId) => {
    await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND member_id=$2', [
      roomId,
      ownerMemberId,
    ]);
    return 'access-revoked';
  },
  makeRemovedRoom: async (_adapter, roomId) => {
    await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND member_id=$2', [
      roomId,
      ownerMemberId,
    ]);
  },
  revokeOwner: async () => {
    await pool.query('UPDATE members SET active=false WHERE id=$1', [ownerMemberId]);
  },
  seedAgentEntry: async (adapter, roomId, agent) => {
    await pool.query(
      'INSERT INTO agent_channel_members(channel_id,agent_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [roomId, agent.memberId]
    );
    return (
      await adapter.post(roomId, {
        text: 'agent attribution',
        idempotencyKey: randomUUID(),
        actingMemberId: agent.memberId,
      })
    ).entryId;
  },
  secondCommunity: () => new RemoteCommunityAdapter(secondRef, ownerKey, store),
  makeUnauthorizedAdapter: () => new RemoteCommunityAdapter(unauthorizedRef, ownerKey, store),
  unadmittedUnavailableReason:
    'browser-approved grants are issued only to an active admitted member',
  makeUnreachableAdapter: () => new RemoteCommunityAdapter(unreachableRef, ownerKey, store),
  eventTimeoutMs: 3_000,
});

describe('RemoteCommunityAdapter authoritative first-pull refusals', () => {
  it('maps the server’s 410 cursor refusal before an event is emitted', async () => {
    const adapter = new RemoteCommunityAdapter(ref, ownerKey, store);
    await adapter.connect();
    const roomId = await seedRoom(adapter);
    const cursor = (await adapter.listEntries(roomId)).entries[0]!.cursor;
    await pool.query('UPDATE channels SET epoch=epoch+1 WHERE id=$1', [roomId]);

    const iterator = adapter.subscribeRoom(roomId, cursor)[Symbol.asyncIterator]();
    try {
      await expect(iterator.next()).rejects.toBeInstanceOf(StaleCommunityCursorError);
    } finally {
      await iterator.return?.();
    }
  });

  it('maps a server-authorized hidden-room 404 before an event is emitted', async () => {
    const adapter = new RemoteCommunityAdapter(ref, ownerKey, store);
    await adapter.connect();
    const hidden = await pool.query<{ id: string }>(
      "INSERT INTO channels(community_id,name,visibility) VALUES($1,$2,'private') RETURNING id",
      [communityId, `Hidden ${randomUUID()}`]
    );
    const roomId = hidden.rows[0]!.id;

    const iterator = adapter.subscribeRoom(roomId)[Symbol.asyncIterator]();
    try {
      await expect(iterator.next()).rejects.toBeInstanceOf(CommunityRoomNotFoundError);
    } finally {
      await iterator.return?.();
    }
  });
});

describe('RemoteCommunityAdapter immutable community cursor scope', () => {
  it('rejects a cursor from a different real community with the same channel, epoch, and signing secret', async () => {
    const sharedChannelId = randomUUID();
    const [primaryChannel, secondaryChannel] = await Promise.all([
      pool.query<{ epoch: number }>(
        "INSERT INTO channels(id,community_id,name,visibility) VALUES($1,$2,$3,'private') RETURNING epoch",
        [sharedChannelId, communityId, 'Shared cursor scope']
      ),
      secondPool.query<{ epoch: number }>(
        "INSERT INTO channels(id,community_id,name,visibility) VALUES($1,$2,$3,'private') RETURNING epoch",
        [sharedChannelId, secondCommunityId, 'Shared cursor scope']
      ),
    ]);
    expect(primaryChannel.rows[0]?.epoch).toBe(secondaryChannel.rows[0]?.epoch);
    await Promise.all([
      pool.query('INSERT INTO channel_members(channel_id,member_id) VALUES($1,$2)', [
        sharedChannelId,
        ownerMemberId,
      ]),
      secondPool.query('INSERT INTO channel_members(channel_id,member_id) VALUES($1,$2)', [
        sharedChannelId,
        secondOwnerMemberId,
      ]),
    ]);

    const primary = new RemoteCommunityAdapter(ref, ownerKey, store);
    const secondary = new RemoteCommunityAdapter(secondRef, ownerKey, store);
    await Promise.all([primary.connect(), secondary.connect()]);
    await primary.post(sharedChannelId, {
      text: 'cursor belongs only to the first community',
      idempotencyKey: randomUUID(),
    });
    const foreignCursor = (await primary.listEntries(sharedChannelId)).entries[0]!.cursor;

    await expect(
      secondary.listEntries(sharedChannelId, { cursor: foreignCursor })
    ).rejects.toBeInstanceOf(StaleCommunityCursorError);
    await expect(secondary.setReadCursor(sharedChannelId, foreignCursor)).rejects.toBeInstanceOf(
      StaleCommunityCursorError
    );

    const iterator = secondary
      .subscribeRoom(sharedChannelId, foreignCursor)
      [Symbol.asyncIterator]();
    try {
      await expect(iterator.next()).rejects.toBeInstanceOf(StaleCommunityCursorError);
    } finally {
      await iterator.return?.();
    }
  });
});

describe('RemoteCommunityAdapter caller stream cancellation', () => {
  it('ends a parked caller-aborted stream after its snapshot', async () => {
    const adapter = new RemoteCommunityAdapter(ref, ownerKey, store);
    await adapter.connect();
    const roomId = await seedRoom(adapter);
    const controller = new AbortController();
    const iterator = adapter
      .subscribeRoom(roomId, undefined, controller.signal)
      [Symbol.asyncIterator]();
    try {
      const snapshot = await iterator.next();
      expect(snapshot.done).toBe(false);
      expect(snapshot.value?.type).toBe('snapshot');

      controller.abort();
      await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    } finally {
      await iterator.return?.();
    }
  });
});

describe('RemoteCommunityAdapter qualified human primitives', () => {
  it('returns a confirmed native post and joins or leaves only the connected human', async () => {
    const adapter = new RemoteCommunityAdapter(ref, ownerKey, store);
    await adapter.connect();
    const room = await pool.query<{ id: string }>(
      "INSERT INTO channels(community_id,name,visibility) VALUES($1,$2,'public') RETURNING id",
      [communityId, `Public ${randomUUID()}`]
    );
    const roomId = room.rows[0]!.id;
    await adapter.joinRoom(roomId);
    expect(
      (
        await pool.query('SELECT 1 FROM channel_members WHERE channel_id=$1 AND member_id=$2', [
          roomId,
          ownerMemberId,
        ])
      ).rowCount
    ).toBe(1);
    const written = await adapter.postEntry(roomId, {
      text: 'confirmed browser post primitive',
      idempotencyKey: randomUUID(),
    });
    expect(remoteSequenceOf(written)).toBe(1);
    expect(remoteAuthorOf(written)).toEqual({ displayName: 'Conformance Owner', kind: 'human' });
    await adapter.leaveRoom(roomId);
    expect(
      (
        await pool.query('SELECT 1 FROM channel_members WHERE channel_id=$1 AND member_id=$2', [
          roomId,
          ownerMemberId,
        ])
      ).rowCount
    ).toBe(0);
  });
});

describe('RemoteCommunityAdapter durable agent enrollment', () => {
  it('reuses a validated secret after restart and reactivates an ejected agent with no rooms', async () => {
    const localDb = createDb(':memory:');
    runMigrations(localDb);
    const enrollments = new CommunityAgentEnrollmentStore(localDb);
    const first = new RemoteCommunityAdapter(ref, ownerKey, store, enrollments);
    await first.connect();
    const roomId = await seedRoom(first);
    const admitted = await first.admitAgent({
      agentId: 'fixture-agent',
      displayName: 'Fixture agent',
    });
    await first.addMember(roomId, admitted.memberId);

    const restarted = new RemoteCommunityAdapter(ref, ownerKey, store, enrollments);
    const reused = await restarted.admitAgent({
      agentId: 'fixture-agent',
      displayName: 'Ignored name',
    });
    expect(reused.memberId).toBe(admitted.memberId);

    // Losing the initial secret response is an explicit recovery action. It
    // rotates once, then a subsequent restart reuses that new verified bearer.
    await store.deleteAgentToken(ref, ownerKey, admitted.memberId);
    const recovered = await restarted.recoverAgent({
      agentId: 'fixture-agent',
      displayName: 'Fixture agent',
    });
    expect(recovered.memberId).toBe(admitted.memberId);
    const recoveredRestart = new RemoteCommunityAdapter(ref, ownerKey, store, enrollments);
    expect(
      (await recoveredRestart.admitAgent({ agentId: 'fixture-agent', displayName: 'Ignored name' }))
        .memberId
    ).toBe(admitted.memberId);

    await restarted.revokeAgent(admitted.memberId);
    const [reactivated, concurrent] = await Promise.all([
      restarted.admitAgent({ agentId: 'fixture-agent', displayName: 'Fixture agent' }),
      new RemoteCommunityAdapter(ref, ownerKey, store, enrollments).admitAgent({
        agentId: 'fixture-agent',
        displayName: 'Ignored name',
      }),
    ]);
    expect(reactivated.memberId).toBe(admitted.memberId);
    expect(concurrent.memberId).toBe(admitted.memberId);
    expect(
      (await restarted.listMembers(roomId)).some((member) => member.memberId === admitted.memberId)
    ).toBe(false);
  });
});

describe('RemoteCommunityAdapter native sequence metadata', () => {
  it('retains wire sequence for history, snapshot, and live entry projections', async () => {
    const adapter = new RemoteCommunityAdapter(ref, ownerKey, store);
    await adapter.connect();
    const roomId = await seedRoom(adapter);
    const history = await adapter.listEntries(roomId);
    expect(history.entries.map(remoteSequenceOf)).toEqual([1, 2]);

    const iterator = adapter.subscribeRoom(roomId)[Symbol.asyncIterator]();
    try {
      const snapshot = await iterator.next();
      expect(snapshot.done).toBe(false);
      if (snapshot.done || snapshot.value.type !== 'snapshot') throw new Error('Expected snapshot');
      expect(snapshot.value.entries.map(remoteSequenceOf)).toEqual([1, 2]);

      await adapter.post(roomId, { text: 'live metadata', idempotencyKey: randomUUID() });
      const live = await iterator.next();
      expect(live.done).toBe(false);
      if (live.done || live.value.type !== 'entry') throw new Error('Expected live entry');
      expect(remoteSequenceOf(live.value.entry)).toBe(3);
    } finally {
      await iterator.return?.();
    }
  });
});
