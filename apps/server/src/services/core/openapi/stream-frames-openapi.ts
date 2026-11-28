/**
 * The frames of the chat and room event streams, as the API document
 * describes them. One definition, read by every operation that serves those
 * frames: `GET /api/sessions/{id}/events`, the hub's relay of a linked
 * computer's chat, and `GET /api/rooms/{id}/events`.
 *
 * @module services/core/openapi/stream-frames-openapi
 */
import { z } from 'zod';
import {
  CanvasChannelEventSchema,
  CanvasChannelFrameSchema,
  CanvasChannelSnapshotFrameSchema,
} from '@dorkos/shared/canvas-channel-schemas';
import { RoomEventSchema, RoomSnapshotSchema } from '@dorkos/shared/room-schemas';
import { SessionEventSchema, SessionSnapshotSchema } from '@dorkos/shared/session-stream';

/**
 * Documentation-only mirrors: OpenAPI cannot expand recursive JSON or express
 * the own-property incarnation checks. Reuse every field schema without
 * extending refined objects; production parsing retains the original guards.
 */
const LocalDocEventFrameSchema = z
  .object({
    ...CanvasChannelFrameSchema.shape,
    event: CanvasChannelEventSchema.extend({
      payload: z
        .unknown()
        .describe(
          'Finite plain JSON, maximum depth 32; bounded by the document channel envelope limit.'
        ),
    }),
  })
  .strict();
const LocalDocSnapshotFrameSchema = z
  .object({
    ...CanvasChannelSnapshotFrameSchema.shape,
    snapshot: z
      .object({
        ...CanvasChannelSnapshotFrameSchema.shape.snapshot.shape,
        state: z
          .record(z.string(), z.unknown())
          .describe(
            'Finite plain JSON state, maximum depth 32 and 256 KiB; separate from document content.'
          ),
      })
      .strict(),
  })
  .strict();
const LocalRoomEventSchema = z.union([
  ...RoomEventSchema.options.filter(
    (option) => !['canvas_event', 'canvas_channel_snapshot'].includes(option.shape.type.value)
  ),
  LocalDocEventFrameSchema,
  LocalDocSnapshotFrameSchema,
]);

/** The frames of one chat's event stream, in the order a cold connect sends them. */
const SESSION_STREAM_FRAMES = [
  SessionSnapshotSchema,
  SessionEventSchema,
  LocalDocEventFrameSchema,
  LocalDocSnapshotFrameSchema,
] as const;

/** One frame's `data:` on a chat's event stream. */
export const SessionStreamFrameSchema = z.union(SESSION_STREAM_FRAMES).openapi({
  description: 'A SessionSnapshot (cold connect) followed by SessionEvent frames.',
});

/**
 * One frame's `data:` on the hub's relay of a linked computer's chat: the
 * chat's own frames, or the `error` event the hub sends when the computer ends
 * the stream with a reason.
 */
export const RelayedSessionStreamFrameSchema = z
  .union([
    ...SESSION_STREAM_FRAMES,
    z
      .object({
        code: z.string().describe('Why the computer ended the stream.'),
        message: z.string().describe('The same, in words.'),
      })
      .describe('The `error` event: the computer ended the stream, and why.'),
  ])
  .openapi({
    description:
      "The linked computer's chat frames, as that chat's own stream sends them, or an `error` event.",
  });

/** One frame's `data:` on a room's event stream. */
export const RoomStreamFrameSchema = z.union([RoomSnapshotSchema, LocalRoomEventSchema]);
