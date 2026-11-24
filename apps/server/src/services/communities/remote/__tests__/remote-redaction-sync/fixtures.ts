import { roomAudience } from '../../../../rooms/service/room-audience.js';
/**
 * The redaction sync's own decisions, against a real SQLite mirror and a scripted feed: where it
 * resumes, when it starts over, what it skips, and when it stops asking. The end-to-end proof
 * against a real Community server, including the bytes on disk, is
 * `apps/server/src/services/spaces/__tests__/redaction-mirror.integration.test.ts`.
 *
 * This module holds the setup those suites share.
 *
 * @module services/communities/remote/__tests__/remote-redaction-sync/fixtures
 */
import { type CommunityEntry, type CommunityRef } from '@dorkos/shared/community-adapter';
import { notifications } from '@dorkos/db';
import type { RoomEvent } from '@dorkos/shared/room-schemas';

import { it, vi } from 'vitest';

import {
  agentLookupFor,
  createRoomHarness,
} from '../../../../rooms/__tests__/room-test-harness.js';
import { searchMessages } from '../../../../search/index.js';

import { RemoteMirrorStore, type NativeMirrorEntry } from '../../mirror-store.js';

import { type RemoteRedactionPage } from '../../remote-community-adapter.js';
import { RemoteRedactionSync } from '../../remote-redaction-sync.js';

export const REF = 'remote_sync' as CommunityRef;
export const ROOM = 'general';

export function native(seq: number, text: string, author = 'Rae Remote'): NativeMirrorEntry {
  const entry: CommunityEntry = {
    community: REF,
    roomId: ROOM,
    id: `entry-${seq}`,
    authorId: 'remote-rae',
    text,
    mentions: [],
    parentEntryId: null,
    threadRootEntryId: null,
    depth: 0,
    cursor: `cursor-${seq}` as CommunityEntry['cursor'],
    createdAt: '2026-09-24T00:00:00.000Z',
  };
  return {
    entry,
    remoteSeq: seq,
    author: { memberId: 'remote-rae', displayName: author, kind: 'human' },
  };
}

export function setup(agents = agentLookupFor({})) {
  const harness = createRoomHarness({ agents });
  const clock = { now: Date.parse('2026-09-24T00:00:00.000Z') };
  const late: { sync?: RemoteRedactionSync } = {};
  // Wired as production wires it: a revocation's purge is finished by the sync.
  const mirrors = new RemoteMirrorStore(harness.db, harness.store, harness.authors, (purge) =>
    late.sync?.afterPurge(purge)
  );
  const room = mirrors.ensureRoom({
    communityRef: REF,
    remoteRoomId: ROOM,
    title: 'General',
    topic: null,
    ownerAuthorId: harness.human,
    accessors: [],
    authorizedAt: '2026-09-24T00:00:00.000Z',
  });
  const pages: Array<RemoteRedactionPage | Error> = [];
  const asked: Array<string | undefined> = [];
  const readRedactions = vi.fn(async (_roomId: string, opts: { cursor?: string } = {}) => {
    asked.push(opts.cursor);
    const next = pages.shift();
    if (!next) throw new Error('no page scripted');
    if (next instanceof Error) throw next;
    return next;
  });
  const deletedFiles: string[] = [];
  // Every frame the room streams fan out, as an open window would receive it.
  const published: Array<{ roomId: string; event: RoomEvent }> = [];
  const publish = harness.service.stream.publish.bind(harness.service.stream);
  vi.spyOn(harness.service.stream, 'publish').mockImplementation((roomId, event) => {
    published.push({ roomId, event });
    publish(roomId, event);
  });
  const sync = new RemoteRedactionSync({
    db: harness.db,
    mirrors,
    readers: () => ({ readRedactions }),
    roomAudience: (id, removed) => roomAudience(id, harness.service, removed),
    // Wired as production wires it.
    publishRevisions: (localRoomId, seqs) =>
      harness.service.publishEntryRevisions(localRoomId, seqs),
    now: () => clock.now,
    attachmentBytes: {
      delete: async (roomId, attachmentId, extension) => {
        deletedFiles.push(`${roomId}/${attachmentId}.${extension}`);
      },
      get: async () => null,
    },
  });
  late.sync = sync;
  const target = { communityRef: REF, remoteRoomId: ROOM, ownerAuthorId: harness.human };
  const search = (word: string) =>
    searchMessages(harness.db, {
      scopes: [{ sourceId: 'rooms', visibility: 'all' }],
      query: word,
      limit: 5,
    });
  return {
    harness,
    clock,
    mirrors,
    room,
    pages,
    asked,
    readRedactions,
    sync,
    target,
    search,
    deletedFiles,
    published,
  };
}

/** The `revision` frames a room's open windows were sent. */
export const revisionsOf = (s: ReturnType<typeof setup>) =>
  s.published.flatMap(({ roomId, event }) =>
    event.type === 'revision' ? [{ roomId, entry: event.entry }] : []
  );

/** An inbox row quoting one room entry, as the room-message emitter writes it. */
export function quoteNotification(
  s: ReturnType<typeof setup>,
  entryId: string,
  fromName: string,
  preview: string
) {
  const payload = {
    roomId: s.room.id,
    entryId,
    entrySeq: 1,
    roomName: 'General',
    fromName,
    preview,
  };
  s.harness.db
    .insert(notifications)
    .values({
      id: `n-${entryId}`,
      kind: 'mention.received',
      tier: 'notable',
      subjectType: 'room',
      subjectId: s.room.id,
      roomId: s.room.id,
      title: `${fromName} mentioned you in General`,
      body: preview,
      dataJson: JSON.stringify(payload),
      dedupeKey: `mention:${entryId}`,
      createdAt: '2026-09-24T00:00:00.000Z',
    })
    .run();
}

export const inbox = (s: ReturnType<typeof setup>) =>
  JSON.stringify(s.harness.db.select().from(notifications).all());

export const cursorOf = (s: ReturnType<typeof setup>) =>
  s.mirrors.redactionCursor(REF, ROOM, s.harness.human)?.cursor;
