/**
 * `GET /api/communities/:ref/rooms/:roomId/events`: one remote room as an event stream, for the
 * owner's own view of it. A snapshot first, then each new entry, each message changed in place,
 * and the state of the owner's own deliveries, until the room closes or the browser leaves.
 *
 * Written straight to the Node response (`http/raw-node-stream.ts`), so each frame reaches the
 * browser as it is written.
 *
 * @module routes/remote-community-events
 */
import type { ServerResponse } from 'node:http';
import type { Context } from 'hono';
import { z } from 'zod';
import { RemoteCommunityEventSchema } from '@dorkos/shared/community-views';
import { SSE } from '../config/constants.js';
import type { ApiEnv } from '../http/api-chain.js';
import { streamToNodeResponse } from '../http/raw-node-stream.js';
import { readQuery } from '../http/request-query.js';
import {
  getRemoteCommunityAdapter,
  getRemoteCommunityDeliverySnapshot,
  onRemoteCommunityDeliveryChange,
} from '../services/communities/remote/state.js';
import { remoteAuthorOf } from '../services/communities/remote/remote-community-adapter.js';
import { RemoteConnectionAuthorizationError } from '../services/communities/remote/connection-store.js';
import {
  followNativeRedactions,
  NATIVE_REDACTION_POLL_MS,
} from '../services/communities/remote/native-redaction-follower.js';
import {
  communityFailure,
  communityTarget,
  remoteEntry,
  remoteRoom,
  verifiedConnection,
} from './remote-community-http.js';

/** A redaction-feed position a resuming view sends back; opaque and bounded. */
const RedactionPositionSchema = z.string().min(1).max(1024).optional();

/** Write one strict event payload without exposing adapter or credential state. */
function writeEvent(res: ServerResponse, event: unknown): void {
  const parsed = RemoteCommunityEventSchema.parse(event);
  res.write(`event: ${parsed.type}\ndata: ${JSON.stringify(parsed)}\n\n`);
}

/**
 * Stream one remote room.
 *
 * @param c - The request's context.
 */
export async function remoteRoomEvents(c: Context<ApiEnv>): Promise<Response> {
  const target = communityTarget(c);
  if (target instanceof Response) return target;
  const { owner, ref } = target;
  const roomId = c.req.param('roomId')!;
  let connection;
  try {
    connection = await verifiedConnection(ref, owner, 'stream');
  } catch (error) {
    return communityFailure(c, error);
  }
  const query = readQuery(c);
  return streamToNodeResponse(c, async (res, { signal: left }) => {
    // Ends when the browser leaves, and when this stream does: the redaction feed's poll and the
    // room subscription stop with it, never outliving the response.
    const ended = new AbortController();
    const signal = AbortSignal.any([left, ended.signal]);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    // A quiet channel still says it is alive, as the session streams do, so a proxy or the phone
    // tunnel does not close it for idling. The space's own stream to this server now stays open
    // too (DOR-2973), so nothing else would write here for minutes. The browser skips comments.
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': keepalive\n\n');
    }, SSE.HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();
    let sawSnapshot = false;
    const writeDeliveries = () => {
      if (!sawSnapshot || signal.aborted || res.writableEnded) return;
      const deliveries = getRemoteCommunityDeliverySnapshot(ref, roomId, owner);
      writeEvent(res, { type: 'deliveries', ...deliveries });
    };
    const removeDeliveryListener = onRemoteCommunityDeliveryChange((changedOwnerAuthorId) => {
      if (changedOwnerAuthorId === owner) writeDeliveries();
    });
    try {
      const adapter = getRemoteCommunityAdapter(ref, owner);
      // Deletions, removals and erasures do not travel on the live stream, so the channel's
      // redaction feed is followed beside it (DOR-2544). Its end is read BEFORE the snapshot, so
      // a change between the two reaches the first poll; changes go out only after the snapshot.
      // A resuming view sends back the last position it was given, so a change made while it
      // was disconnected is read too; the Community snapshot on a resume holds only newer
      // entries, so nothing else would carry it.
      const resumeFrom = RedactionPositionSchema.safeParse(query.redactions);
      const redactions = followNativeRedactions(adapter, roomId, {
        signal,
        intervalMs: NATIVE_REDACTION_POLL_MS,
        ...(resumeFrom.success && resumeFrom.data !== undefined
          ? { resumeFrom: resumeFrom.data }
          : {}),
        onChanged: (items, position) => {
          if (!sawSnapshot || signal.aborted || res.writableEnded) return;
          const mine = items.filter((item) => item.entry.community === ref);
          mine.forEach((item, index) =>
            writeEvent(res, {
              type: 'revision',
              entry: remoteEntry(item.entry, owner),
              // On the page's last frame: every change before it has been written.
              ...(index === mine.length - 1 ? { redactionCursor: position } : {}),
            })
          );
        },
      });
      await redactions.ready;
      for await (const event of adapter.subscribeRoom(
        roomId,
        typeof query.since === 'string' ? (query.since as never) : undefined,
        signal
      )) {
        if (event.type === 'snapshot') {
          const entries = event.entries.map((entry) => remoteEntry(entry, owner));
          writeEvent(res, {
            type: 'snapshot',
            room: remoteRoom(event.room, connection.remoteCommunityId, connection.access!),
            entries,
            cursor: event.cursor,
            lastRemoteSeq: entries.at(-1)?.remoteSeq ?? 0,
            stale: false,
            ...(redactions.position() ? { redactionCursor: redactions.position() } : {}),
          });
          sawSnapshot = true;
          writeDeliveries();
          redactions.start();
        } else if (event.type === 'entry') {
          const author = remoteAuthorOf(event.entry);
          if (!author) throw new Error('Native remote entry lost authoritative metadata');
          writeEvent(res, { type: 'entry', entry: remoteEntry(event.entry, owner) });
        } else if (event.type === 'room_closed') {
          writeEvent(res, {
            type: 'closed',
            community: ref,
            roomId,
            reason: event.reason === 'access-revoked' ? 'revoked' : 'unavailable',
          });
          break;
        }
      }
    } catch (error) {
      if (!signal.aborted)
        writeEvent(res, {
          type: 'closed',
          community: ref,
          roomId,
          reason: error instanceof RemoteConnectionAuthorizationError ? 'revoked' : 'unavailable',
        });
    } finally {
      clearInterval(heartbeat);
      ended.abort();
      removeDeliveryListener();
      if (!res.writableEnded) res.end();
    }
  });
}
