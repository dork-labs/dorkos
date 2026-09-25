/**
 * A DorkOS installation replaces its cached copies of erased and removed Community messages
 * (specs/community-member-erasure task 2.1, AC-14; specs/community-single-item-delete task 1.3,
 * AC-12). A real Community server on PostgreSQL, the real native adapter over HTTP, and a real
 * DorkOS room subsystem on a SQLite FILE, so the test can read the bytes the database and its
 * write-ahead log hold.
 *
 * @vitest-environment node
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, runMigrations, sql, type Db } from '@dorkos/db';
import {
  CommunityRoomNotFoundError,
  type CommunityEntry,
  type CommunityRef,
} from '@dorkos/shared/community-adapter';
import { logger } from '../../../server/src/lib/logger.js';
import { CommunityAgentEnrollmentStore } from '../../../server/src/services/communities/remote/agent-enrollment-store.js';
import { RemoteConnectionStore } from '../../../server/src/services/communities/remote/connection-store.js';
import {
  RemoteMirrorStore,
  type MirrorRoomInput,
} from '../../../server/src/services/communities/remote/mirror-store.js';
import {
  RemoteCommunityAdapter,
  RemoteRedactionFeedUnsupportedError,
  remoteAuthorOf,
  remoteSequenceOf,
} from '../../../server/src/services/communities/remote/remote-community-adapter.js';
import { RemoteRedactionSync } from '../../../server/src/services/communities/remote/remote-redaction-sync.js';
import {
  RemoteRoomSubscriptionBridge,
  type RemoteLiveEntry,
} from '../../../server/src/services/communities/remote/remote-room-subscription-bridge.js';
import {
  agentLookupFor,
  createRoomHarness,
  type RoomHarness,
} from '../../../server/src/services/rooms/__tests__/room-test-harness.js';
import { insertMessages } from '../../../server/src/services/search/frontier-store.js';
import { searchMessages } from '../../../server/src/services/search/index.js';
import { ERASED_ENTRY_TEXT, REMOVED_ENTRY_TEXT } from '../content/tombstones.js';
import { eraseMembership } from '../erasure/erasure.js';
import {
  bootstrapHost,
  pairInstall,
  startTenancyHarness,
  type TenancyHarness,
} from './tenancy-test-harness.js';
import { body, post } from './member-erasure-fixture.js';
import { makeScene, type Scene } from './member-erasure-scenes.js';

let h: TenancyHarness;
let host: { cookie: string; communityId: string };
const directories: string[] = [];

beforeAll(async () => {
  h = await startTenancyHarness('redactionmirror');
  host = await bootstrapHost(h, 'Mira Host', 'mira@host.test');
}, 60_000);

afterAll(async () => {
  await h?.close();
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
});

/** One DorkOS installation of Q's, paired to the scene's community, with one enrolled agent. */
interface Install {
  ref: CommunityRef;
  db: Db;
  file: string;
  rooms: RoomHarness;
  mirrors: RemoteMirrorStore;
  bridge: RemoteRoomSubscriptionBridge;
  adapter: RemoteCommunityAdapter;
  sync: RemoteRedactionSync;
  room: MirrorRoomInput;
  /** Q's enrolled agent on the Community: its member id and handle. */
  remoteAgent: { id: string; handle: string };
}

async function install(s: Scene, origin = h.baseUrl): Promise<Install> {
  const directory = await mkdtemp(join(tmpdir(), 'redaction-mirror-'));
  directories.push(directory);
  const file = join(directory, 'dork.db');
  const db = createDb(file);
  runMigrations(db);
  const state: { mirrors?: RemoteMirrorStore } = {};
  const rooms = createRoomHarness({
    db,
    agents: agentLookupFor({ '/agents/ana': { name: 'Ana', responseMode: 'always' } }),
    mirrorAccess: {
      canRead: (roomId, authorId) => state.mirrors?.canRead(roomId, authorId) ?? null,
      hasMirrors: () => state.mirrors?.hasMirrors() ?? false,
    },
  });
  const late: { sync?: RemoteRedactionSync } = {};
  // Wired as production wires it: a revocation's purge is finished by the sync.
  const mirrors = new RemoteMirrorStore(db, rooms.store, rooms.authors, (purge) =>
    late.sync?.afterPurge(purge)
  );
  state.mirrors = mirrors;
  const grant = await pairInstall(h, s.communityId, s.q.cookie, ['read', 'post', 'enroll-agent']);
  const enrolled = await body<{ agent: { memberId: string; handle: string } }>(
    await h.call(`${s.base}/agents`, {
      bearer: grant,
      body: { localAgentId: 'local-ana', displayName: 'Ana' },
    }),
    201,
    'enroll Ana'
  );
  await body(
    await h.call(`${s.base}/channels/${s.channelId}/agents`, {
      cookie: s.q.cookie,
      body: { agentId: enrolled.agent.memberId },
    }),
    200,
    'Ana joins'
  );
  const ref = `mirror_${randomUUID().slice(0, 8)}` as CommunityRef;
  const store = new RemoteConnectionStore(directory);
  await store.addPending(
    {
      ref,
      ownerKey: rooms.human,
      remoteCommunityId: s.communityId,
      label: 'Mirror test',
      pinnedOrigin: origin,
      pairingId: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    randomUUID()
  );
  const capabilities = { read: true, post: true, enrollAgent: true, stream: true };
  await store.complete(ref, rooms.human, s.q.memberId, grant, {
    state: 'verified',
    effective: capabilities,
    lastKnown: { lifecycle: 'active', capabilities, verifiedAt: new Date().toISOString() },
  });
  const adapter = new RemoteCommunityAdapter(ref, rooms.human, store);
  const enrollments = new CommunityAgentEnrollmentStore(db);
  enrollments.activate({
    communityRef: ref,
    localAgentId: 'local-ana',
    remoteMemberId: enrolled.agent.memberId,
    ownerAuthorId: rooms.human,
  });
  const ana = rooms.authors.resolveAgent('/agents/ana', 'Ana');
  const bridge = new RemoteRoomSubscriptionBridge(
    mirrors,
    rooms.service,
    enrollments,
    (localAgentId) => (localAgentId === 'local-ana' ? ana.id : null)
  );
  const room: MirrorRoomInput = {
    communityRef: ref,
    remoteRoomId: s.channelId,
    title: 'general',
    topic: null,
    ownerAuthorId: rooms.human,
    accessors: [{ authorId: ana.id, responseMode: 'always' }],
    authorizedAt: new Date().toISOString(),
  };
  mirrors.ensureRoom(room);
  const sync = new RemoteRedactionSync({ db, mirrors, readers: () => adapter });
  late.sync = sync;
  return {
    ref,
    db,
    file,
    rooms,
    mirrors,
    bridge,
    adapter,
    sync,
    room,
    remoteAgent: { id: enrolled.agent.memberId, handle: enrolled.agent.handle },
  };
}

/** The native entry as the stream importer sees it, with its sequence and author retained. */
function live(entry: CommunityEntry): RemoteLiveEntry {
  const author = remoteAuthorOf(entry)!;
  return {
    entry,
    remoteSeq: remoteSequenceOf(entry)!,
    author: { memberId: entry.authorId, displayName: author.displayName, kind: author.kind },
    serverCreatedAt: entry.createdAt,
  };
}

async function history(i: Install): Promise<CommunityEntry[]> {
  return (await i.adapter.listEntries(i.room.remoteRoomId, { limit: 100 })).entries;
}

/** The database file and its write-ahead log, as bytes, after SQLite's own checkpoint. */
async function rawBytes(i: Install): Promise<string> {
  i.db.run(sql`PRAGMA wal_checkpoint(PASSIVE)`);
  const parts = [await readFile(i.file)];
  if (existsSync(`${i.file}-wal`)) parts.push(await readFile(`${i.file}-wal`));
  return Buffer.concat(parts).toString('latin1');
}

const found = (bytes: string, needles: readonly string[]) =>
  needles.filter((needle) => bytes.includes(needle));

function roomSearch(i: Install, query: string) {
  return searchMessages(i.db, {
    scopes: [{ sourceId: 'rooms', visibility: 'all' }],
    query,
    limit: 20,
  });
}

function mirrored(i: Install) {
  const localRoomId = i.mirrors.localRoomIdForOwner(i.ref, i.room.remoteRoomId, i.rooms.human)!;
  return i.rooms.store.listEntriesAfter(localRoomId, 0).map((entry) => ({
    ...entry,
    author: i.rooms.authors.getById(entry.authorId)?.displayName,
  }));
}

describe('a DorkOS installation replaces cached copies (AC-14)', { timeout: 120_000 }, () => {
  // Purpose: after P's erasure and one feed sync, nothing P said is left in the installation's
  // SQLite file or WAL, in room search, or in the mirrored entries, and no local agent ran. The
  // control proves each canary was really there first. It fails if the mirror keeps the text,
  // search is not re-indexed, secure_delete / optimize / checkpoint are skipped, the author name
  // survives, or the sync dispatches an agent.
  it('leaves no copy of an erased member in the database, its log, or search', async () => {
    const s = await makeScene(h, host.cookie, 'mirror');
    const i = await install(s);
    const canary = 'zqxcanarytoken';
    const pDisplayName = `Pat mirror`;
    const pEntry = await post(
      h,
      s.communityId,
      s.channelId,
      { cookie: s.p.cookie },
      { text: `canary-text-1 ${canary} @${i.remoteAgent.handle}`, idempotencyKey: 'p-canary' }
    );
    const qEntry = await post(
      h,
      s.communityId,
      s.channelId,
      { cookie: s.q.cookie },
      { text: `@${s.p.handle} zqxthanks`, idempotencyKey: 'q-thanks' }
    );
    const entries = await history(i);
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    // P's message arrives live and mentions Q's agent: it is dispatched, so the agent's turn
    // holds the canary. Everything else is cache history.
    i.bridge.importSnapshot(i.room, entries.filter((entry) => entry.id !== pEntry.id).map(live));
    i.bridge.importLive(i.room, live(byId.get(pEntry.id)!), {
      reconnect: false,
      wasActiveBeforeDisconnect: false,
      readOnly: false,
    });
    await i.rooms.service.triggersIdle();
    expect(i.rooms.runner.turns).toHaveLength(1);
    expect(i.rooms.runner.turns[0].prompt).toContain(canary);
    await i.rooms.indexMessages();
    // What the agent keeps (its session transcript), as message search indexes it.
    i.db.transaction((tx) =>
      insertMessages(tx, 'claude-code', [
        {
          originKey: 'session-ana',
          ordinal: 1,
          messageId: null,
          role: 'user',
          createdAt: new Date().toISOString(),
          body: `canary-text-1 ${canary}`,
        },
      ])
    );

    const needles = ['canary-text-1', canary, s.p.handle, pDisplayName];
    // Control: every canary is on disk, and room search finds the message.
    expect(found(await rawBytes(i), needles)).toEqual(needles);
    expect(roomSearch(i, canary)).toHaveLength(1);
    expect(roomSearch(i, 'zqxthanks')).toHaveLength(1);

    await eraseMembership(h.pool, s.communityId, s.p.memberId);
    await i.sync.sync(
      { communityRef: i.ref, remoteRoomId: s.channelId, ownerAuthorId: i.rooms.human },
      {}
    );

    expect(roomSearch(i, canary)).toEqual([]);
    expect(roomSearch(i, 'canary')).toEqual([]);
    // Q's message is still found, now as it reads after the rewrite.
    expect(roomSearch(i, 'zqxthanks')).toHaveLength(1);
    const rows = mirrored(i);
    const pRow = rows.find((row) => row.body.text === ERASED_ENTRY_TEXT);
    expect(pRow?.author).toBe('Erased member');
    expect(rows.find((row) => row.body.text.includes('zqxthanks'))?.body.text).toBe(
      '@[erased] zqxthanks'
    );
    expect(
      i.mirrors.cachedEntryWithAuthorForOwner(i.ref, s.channelId, pEntry.id, i.rooms.human)
    ).toMatchObject({
      entry: { text: ERASED_ENTRY_TEXT, mentions: [] },
      author: { displayName: 'Erased member' },
    });
    expect(i.mirrors.cachedEntryForOwner(i.ref, s.channelId, qEntry.id, i.rooms.human)?.text).toBe(
      '@[erased] zqxthanks'
    );
    // No local agent ran for the change.
    await i.rooms.service.triggersIdle();
    expect(i.rooms.runner.turns).toHaveLength(1);
    // The agent's own copy is the named limit: what it received, and its indexed transcript,
    // are the owner's and untouched, and a search over sessions still finds it.
    expect(i.rooms.runner.turns[0].prompt).toContain(canary);
    expect(
      searchMessages(i.db, {
        scopes: [{ sourceId: 'claude-code', visibility: 'all' }],
        query: canary,
        limit: 5,
      })
    ).toHaveLength(1);
  });

  // Purpose: the raw-bytes half of AC-14 on its own, with the agent's transcript not in the
  // database, so any canary byte left in the file or WAL is the sync's. It fails without
  // secure_delete on the rewrite, without FTS optimize, or without the WAL checkpoint.
  it('leaves none of the erased text in the SQLite file or its WAL', async () => {
    const s = await makeScene(h, host.cookie, 'bytes');
    const i = await install(s);
    const canary = 'zqxbytestoken';
    await post(
      h,
      s.communityId,
      s.channelId,
      { cookie: s.p.cookie },
      { text: `canary-text-1 ${canary} ${'filler '.repeat(400)}`, idempotencyKey: 'p-bytes' }
    );
    i.bridge.importSnapshot(i.room, (await history(i)).map(live));
    await i.rooms.indexMessages();
    const needles = ['canary-text-1', canary, s.p.handle, 'Pat bytes'];
    expect(found(await rawBytes(i), needles)).toEqual(needles);

    await eraseMembership(h.pool, s.communityId, s.p.memberId);
    await i.sync.sync(
      { communityRef: i.ref, remoteRoomId: s.channelId, ownerAuthorId: i.rooms.human },
      {}
    );
    const leftover = found(await rawBytes(i), needles);
    expect(leftover).toEqual([]);
    expect(roomSearch(i, canary)).toEqual([]);
  });

  // Purpose (review finding 1): a mirror whose access is revoked can no longer read the feed, so
  // a later erasure could never reach it; its copy is deleted instead, down to the bytes of the
  // database file and its log. It fails if a revoked mirror keeps its entries or search rows.
  it('deletes a revoked mirror down to the bytes', async () => {
    const s = await makeScene(h, host.cookie, 'revoked');
    const i = await install(s);
    await post(
      h,
      s.communityId,
      s.channelId,
      { cookie: s.p.cookie },
      { text: `zqxrevokedtoken ${'filler '.repeat(200)}`, idempotencyKey: 'p-revoked' }
    );
    i.bridge.importSnapshot(i.room, (await history(i)).map(live));
    await i.rooms.indexMessages();
    expect(found(await rawBytes(i), ['zqxrevokedtoken'])).toEqual(['zqxrevokedtoken']);
    // The agent left the channel: the next directory read no longer lists it.
    // Stopping the agent's turns in a revoked mirror is refused today (the mirror is already
    // unreadable, so the halt reads the room as missing; reported separately). The purge must run
    // regardless, which is what this checks.
    await i.bridge.revokeAbsentRooms(i.ref, i.rooms.human, new Set()).catch(() => undefined);
    await i.sync.whenScrubbed();
    expect(roomSearch(i, 'zqxrevokedtoken')).toEqual([]);
    expect(
      i.rooms.store.getRoom(i.mirrors.roomIdsForOwner(i.ref, i.rooms.human)[0] ?? '')
    ).toBeNull();
    expect(i.mirrors.localRoomIdForOwner(i.ref, s.channelId, i.rooms.human)).toBeNull();
    expect(found(await rawBytes(i), ['zqxrevokedtoken'])).toEqual([]);
  });

  // Purpose (single-item delete AC-12, DorkOS half): a removal replaces the cached text with its
  // tombstone and drops it from search, but keeps the author's name (only erasure changes it),
  // and dispatches nothing. It fails if the sync renames authors on a removal.
  it('replaces a deleted message and keeps its author', async () => {
    const s = await makeScene(h, host.cookie, 'removal');
    const i = await install(s);
    const entry = await post(
      h,
      s.communityId,
      s.channelId,
      { cookie: s.p.cookie },
      { text: 'zqxremovedtoken says hi', idempotencyKey: 'p-removed' }
    );
    i.bridge.importSnapshot(i.room, (await history(i)).map(live));
    await i.rooms.indexMessages();
    expect(roomSearch(i, 'zqxremovedtoken')).toHaveLength(1);
    await body(
      await h.call(`${s.base}/entries/${entry.id}`, { method: 'DELETE', cookie: s.p.cookie }),
      200,
      'delete'
    );
    await i.sync.sync(
      { communityRef: i.ref, remoteRoomId: s.channelId, ownerAuthorId: i.rooms.human },
      {}
    );
    const row = mirrored(i).find((item) => item.body.text === REMOVED_ENTRY_TEXT.author);
    expect(row?.author).toBe('Pat removal');
    expect(roomSearch(i, 'zqxremovedtoken')).toEqual([]);
    expect(found(await rawBytes(i), ['zqxremovedtoken'])).toEqual([]);
    expect(i.rooms.runner.turns).toHaveLength(0);
  });

  // Purpose: a Community server from before the feed answers its route with a bare 404. The sync
  // then logs once, changes nothing, and stops asking until restart; a channel the reader can no
  // longer see (a 404 with a code) is not mistaken for that.
  it('logs once and changes nothing against a server without the feed', async () => {
    const s = await makeScene(h, host.cookie, 'old');
    const i = await install(s);
    const reached: string[] = [];
    const old: Server = createServer((request, response) => {
      reached.push(request.url ?? '');
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('404 Not Found');
    });
    await new Promise<void>((resolve) => old.listen(0, '127.0.0.1', resolve));
    const address = old.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const store = new RemoteConnectionStore(directories.at(-1)!);
    const oldRef = `old_${randomUUID().slice(0, 8)}` as CommunityRef;
    await store.addPending(
      {
        ref: oldRef,
        ownerKey: i.rooms.human,
        remoteCommunityId: s.communityId,
        label: 'Old server',
        pinnedOrigin: `http://127.0.0.1:${address.port}`,
        pairingId: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      randomUUID()
    );
    const capabilities = { read: true, post: true, enrollAgent: true, stream: true };
    await store.complete(oldRef, i.rooms.human, s.q.memberId, 'old-server-token', {
      state: 'verified',
      effective: capabilities,
      lastKnown: { lifecycle: 'active', capabilities, verifiedAt: new Date().toISOString() },
    });
    const oldAdapter = new RemoteCommunityAdapter(oldRef, i.rooms.human, store);
    try {
      await expect(oldAdapter.readRedactions(s.channelId)).rejects.toBeInstanceOf(
        RemoteRedactionFeedUnsupportedError
      );
      // The real server's refusal for a channel this reader cannot see carries a code.
      await expect(i.adapter.readRedactions(randomUUID())).rejects.toBeInstanceOf(
        CommunityRoomNotFoundError
      );

      const oldRoom = { ...i.room, communityRef: oldRef };
      i.mirrors.ensureRoom(oldRoom);
      const info = vi.spyOn(logger, 'info');
      const sync = new RemoteRedactionSync({
        db: i.db,
        mirrors: i.mirrors,
        readers: () => oldAdapter,
      });
      const target = {
        communityRef: oldRef,
        remoteRoomId: s.channelId,
        ownerAuthorId: i.rooms.human,
      };
      const before = i.db.all(sql`SELECT * FROM community_room_mirrors ORDER BY local_room_id`);
      await sync.sync(target, {});
      await sync.sync(target, {});
      expect(
        info.mock.calls.filter(([message]) => String(message).includes('changed messages'))
      ).toHaveLength(1);
      expect(reached.filter((url) => url.includes('/redactions'))).toHaveLength(2);
      expect(i.db.all(sql`SELECT * FROM community_room_mirrors ORDER BY local_room_id`)).toEqual(
        before
      );
      info.mockRestore();
    } finally {
      await new Promise<void>((resolve) => old.close(() => resolve()));
    }
  });
});
