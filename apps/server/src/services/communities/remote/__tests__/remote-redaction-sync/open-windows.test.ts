import { REF, ROOM, native, setup, revisionsOf } from './fixtures.js';
import type { RoomRevisionEvent } from '@dorkos/shared/room-schemas';
import type { StreamFrame } from '@dorkos/shared/stream-socket';
import { describe, expect, it, vi } from 'vitest';
import { eventFanOut } from '../../../../core/event-fan-out.js';
import { deliverRoomStream } from '../../../../core/streams/room-stream-delivery.js';
import { setRoomService } from '../../../../rooms/index.js';

describe('RemoteRedactionSync', () => {
  describe('open windows (DOR-2336)', () => {
    // Purpose: an open window of the mirrored room is told which messages changed, carrying the
    // tombstone as the log now holds it and never the erased words, and the room list re-reads.
    // It fails if the sync stops emitting, emits before the rewrite, or carries the old text.
    it('sends each rewritten entry to the room with the tombstone only', async () => {
      const s = setup();
      s.mirrors.importEntries(REF, ROOM, [
        native(1, 'zqxerasedcanary secret words', 'Zephyrine Quill'),
        native(2, 'untouched words'),
      ]);
      const [first] = s.harness.store.listEntriesAfter(s.room.id, 0);
      const fanOut = vi.spyOn(eventFanOut, 'broadcast');
      s.pages.push({
        items: [native(1, 'This message was erased.', 'Erased member')],
        nextCursor: 'c1',
        hasMore: false,
      });
      await s.sync.sync(s.target, {});

      const revisions = revisionsOf(s);
      expect(revisions).toHaveLength(1);
      expect(revisions[0]).toMatchObject({
        roomId: s.room.id,
        entry: {
          id: first!.id,
          seq: first!.seq,
          roomId: s.room.id,
          body: { text: 'This message was erased.' },
        },
      });
      expect(JSON.stringify(s.published)).not.toMatch(/zqxerasedcanary|Zephyrine/);
      expect(fanOut).toHaveBeenCalledWith(
        'room_updated',
        { roomId: s.room.id },
        expect.any(Function)
      );
      fanOut.mockRestore();
    });

    // Purpose: a window that was away while a message was erased gets the tombstone when its
    // stream resumes, although the entry is below its cursor, and the frame never carries an
    // `id:` line that could move that cursor. It fails if the resume skips the revision resync.
    it('resyncs a rewrite made while the reader was away, without moving its cursor', async () => {
      const s = setup();
      s.mirrors.importEntries(REF, ROOM, [native(1, 'zqxawaycanary'), native(2, 'later words')]);
      const cursor = s.harness.store.maxSeq(s.room.id);
      s.pages.push({
        items: [native(1, 'This message was deleted.')],
        nextCursor: 'c1',
        hasMore: false,
      });
      await s.sync.sync(s.target, {});

      setRoomService(s.harness.service);
      const frames: StreamFrame[] = [];
      const controller = new AbortController();
      let settle: () => void = () => undefined;
      const resynced = new Promise<void>((resolve) => (settle = resolve));
      const delivered = deliverRoomStream(
        {
          send: async (frame) => {
            frames.push(frame);
            if (
              frame.event === 'revision' &&
              frames.filter((f) => f.event === 'revision').length === 2
            )
              settle();
          },
          get closed() {
            return controller.signal.aborted;
          },
          signal: controller.signal,
          end: () => undefined,
        },
        { roomId: s.room.id, viewerAuthorId: s.harness.human, sinceCursor: cursor }
      );
      await resynced;
      controller.abort();
      await delivered;

      const revisions = frames.filter((frame) => frame.event === 'revision');
      expect(revisions.map((frame) => (frame.data as RoomRevisionEvent).entry.body.text)).toEqual([
        'This message was deleted.',
        'later words',
      ]);
      expect(revisions.every((frame) => frame.id === undefined)).toBe(true);
      expect(JSON.stringify(frames)).not.toContain('zqxawaycanary');
    });
  });
});
