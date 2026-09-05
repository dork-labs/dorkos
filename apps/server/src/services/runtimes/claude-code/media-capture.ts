/**
 * Turning a Claude Code tool-result image into a DorkOS image — the async half.
 *
 * `tool-result-images.ts` is pure and both of its callers are synchronous
 * mappers, so it records an INTENT and this module writes the bytes. Same split,
 * and deliberately the same shape, as `runtimes/opencode/events/media-capture.ts`: the
 * mapper stays testable with no filesystem, and **no base64 payload ever exists
 * as a StreamEvent** — the intent lives for microseconds inside one turn, and
 * the event that reaches the SSE stream, the ring buffer and the event log
 * carries a URL.
 *
 * **Two paths, one file, because claude-code has two.** A turn is watched live
 * through the SDK stream and read back later from the SDK's own JSONL, and both
 * meet the same image. {@link mapSdkMessageWithMedia} covers the live one and
 * {@link attachTranscriptImages} the recorded one; both derive the attachment id
 * from the SAME identity components, so a picture streamed during a turn and the
 * one read back after a restart are one file at one URL, not two copies.
 *
 * @module services/runtimes/claude-code/media-capture
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { HistoryMessage, ImagePart, MessagePart, StreamEvent } from '@dorkos/shared/types';
import {
  MAX_SESSION_ATTACHMENT_BYTES,
  UnsupportedSessionMediaError,
  deriveSessionAttachmentId,
  storableImageExtension,
  type SessionAttachmentStore,
} from '../../session/attachments/index.js';
import { mapSdkMessage } from './sdk/sdk-event-mapper.js';
import type { AgentSession, ToolState } from './agent-types.js';
import type { ToolResultImage, ToolResultImageState } from './tool-result-images.js';
import type { TranscriptImageRef } from './sessions/transcript-parser.js';
import { logger } from '../../../lib/logger.js';

/**
 * Drain every pending image, store it, and yield its `image_attachment` event.
 *
 * Drains destructively and completely, so an event that is yielded is one whose
 * bytes are already fetchable — a client never sees a reference to something
 * that is not there yet.
 *
 * **Failures degrade to a sentence, never to silence.** Bytes past the cap, a
 * media type a session may not store, a source this machine will not read: each
 * yields a typed `error` StreamEvent saying what could not be shown. Swapping
 * one silent drop for another would miss the point of the change entirely.
 *
 * **The storage key is the CANONICAL id, and this is the one place on the live
 * path where that distinction is not cosmetic.** `dispatch`'s contract
 * (`sessions/persistent-dispatch.ts`) says the `sessionId` a turn was asked with
 * is "only a hint after the session's first rename", kept as-is for logging and
 * "the events this turn yields" because those are cosmetic to the id a caller
 * happened to use. An `image_attachment` is one of those events — but the id
 * also picks the DIRECTORY the bytes are written to and the URL the store
 * answers, so here it is identity, not decoration. A brand-new session takes its
 * canonical `sdkSessionId` from the first `system/init` message
 * (`sessions/session-store.ts`: "for new sessions, sdkSessionId is assigned
 * after the first query() init message"), which always precedes any tool call —
 * so by the time an image exists, the canonical id is known and is what both
 * halves of {@link mapSdkMessageWithMedia} store under. Keyed on the request id
 * instead, a first turn that read a PNG wrote to `sessions/<request-id>/…` while
 * every later history read looked in `sessions/<canonical-id>/…`, found nothing,
 * and wrote a SECOND copy at a different URL than the one already on screen
 * (DOR-1664 review). Read per drain rather than captured once, because the
 * rebind happens partway through the very loop that calls this.
 *
 * @param store - Where the bytes go, or `null` when the runtime was wired
 *   without one. With no store there is nothing honest to do but say so once per
 *   image — and the runtime declares `mediaOutput: 'none'` in that
 *   configuration, so nothing was promised.
 * @param session - In-memory session state, read for the canonical
 *   `sdkSessionId` that keys storage.
 * @param sessionId - The id this turn was asked with; the fallback until
 *   `system/init` names the canonical one.
 * @param state - The turn's media bookkeeping (drained).
 */
async function* captureClaudeCodeMedia(
  store: SessionAttachmentStore | null,
  session: AgentSession,
  sessionId: string,
  state: ToolResultImageState
): AsyncGenerator<StreamEvent> {
  const storageId = session.sdkSessionId ?? sessionId;
  while (state.pendingMedia.length > 0) {
    const image = state.pendingMedia.shift()!;
    if (image.kind === 'unreadable') {
      yield mediaError(image.reason);
      continue;
    }
    if (!store) {
      yield mediaError('This agent is not set up to keep images, so one was not saved.');
      continue;
    }
    try {
      const attachmentId = deriveSessionAttachmentId(image.identity);
      const existing = await store.peek(storageId, attachmentId, image.mediaType);
      const stored =
        existing ??
        (await store.put(storageId, attachmentId, image.mediaType, decodeBase64(image.base64)));
      yield {
        type: 'image_attachment',
        data: { attachmentId, url: stored.url, mediaType: stored.mediaType, size: stored.size },
      };
    } catch (err) {
      if (err instanceof UnsupportedSessionMediaError) {
        yield mediaError(err.message);
        continue;
      }
      logger.warn('[ClaudeCode] could not store an image a tool returned', {
        err,
        sessionId,
        storageId,
      });
      yield mediaError('An image was produced but could not be saved.');
    }
  }
}

/**
 * Map one SDK message to events, then announce any picture it carried.
 *
 * The one call site both dispatch paths share: `executeSdkQuery`'s loop
 * (`messaging/message-sender.ts`) on the resume-per-message path and
 * `streamTurnWindow` (`sessions/pump-turn-stream.ts`) on the persistent pump.
 * Wrapping the mapper rather than editing both loops is what keeps the two
 * paths from drifting — the same reason `empty-stream-guard.ts` exists.
 *
 * **The drain after the loop is not belt-and-braces, it is the only one that
 * fires for the case this change exists for.** A `tool_result` whose content is
 * nothing but an image maps to ZERO stream events (the mapper emits a
 * `tool_result` only when there is text), so the in-loop drain never runs for
 * the very message that recorded the picture.
 *
 * Ordering: the image is announced immediately after the events of the message
 * that produced it, so it lands in the transcript exactly where its tool call
 * did. Nothing may follow a `done`, and nothing does — a `tool_result` message
 * never carries one.
 *
 * @param store - Where a turn's images go, or `null` when none was wired.
 * @param message - The SDK message to map.
 * @param session - In-memory session state (mutated by the mapper).
 * @param sessionId - DorkOS session identifier.
 * @param toolState - The turn's mutable tool + media bookkeeping.
 * @param wasStopped - Whether DorkOS aimed a Stop at this query.
 */
export async function* mapSdkMessageWithMedia(
  store: SessionAttachmentStore | null,
  message: SDKMessage,
  session: AgentSession,
  sessionId: string,
  toolState: ToolState,
  wasStopped?: () => boolean
): AsyncGenerator<StreamEvent> {
  for await (const event of mapSdkMessage(message, session, sessionId, toolState, wasStopped)) {
    yield event;
    yield* captureClaudeCodeMedia(store, session, sessionId, toolState);
  }
  yield* captureClaudeCodeMedia(store, session, sessionId, toolState);
}

/**
 * Put the pictures a transcript read found back into the history it produced.
 *
 * `parseTranscript` is synchronous, so it records where each image belongs — the
 * `ToolCallPart` whose result carried it — and this inserts the resolved part
 * directly after that tool call. Object identity is what makes it work:
 * `mergeConsecutiveAssistantMessages` rebuilds the parts ARRAYS but carries the
 * part objects over by reference, so the anchor is still findable afterwards.
 *
 * **A picture that cannot be re-materialized still gets a part.** Not returning
 * one looked harmless and is not: the retention sweep collects an image after
 * ninety days, and a transcript that then showed nothing would be a transcript
 * that silently lost something again. The part points at where the bytes WOULD
 * be, the fetch 404s, and the reader gets the honest "this image is not
 * available" row. Nothing here can make a whole turn vanish — the tool call it
 * anchors to is already in the transcript — but the same reasoning applies.
 *
 * Idempotent and cheap on the common path: an image already on disk costs one
 * `stat` (`peek`), and only the first read of a transcript decodes bytes.
 *
 * **This makes a history READ do writes, deliberately and boundedly.** The first
 * open of a transcript that read fifty screenshots writes fifty files, because
 * the bytes only exist in the JSONL until something materializes them. It is
 * self-limiting rather than unbounded: the work is proportional to the images
 * already in that transcript (nothing here amplifies), every write is capped at
 * {@link MAX_SESSION_ATTACHMENT_BYTES}, and the derived id makes every reopen
 * after the first a `stat` per image and no write at all. A cap on the COUNT was
 * considered and rejected — it would silently drop the oldest pictures from a
 * long session's transcript, which is the defect this whole change exists to
 * end. The retention sweep is what bounds the disk over time, not this path.
 *
 * @param store - The attachment store, or `null` when none was wired.
 * @param sessionId - The DorkOS session whose history is being read.
 * @param messages - The parsed history, mutated in place.
 * @param refs - What `parseTranscript` recorded, in transcript order.
 */
export async function attachTranscriptImages(
  store: SessionAttachmentStore | null,
  sessionId: string,
  messages: HistoryMessage[],
  refs: readonly TranscriptImageRef[]
): Promise<void> {
  if (!store || refs.length === 0) return;

  // One pass to find where every anchor ended up, rather than re-scanning the
  // whole transcript per image.
  const owners = new Map<MessagePart, MessagePart[]>();
  for (const message of messages) {
    for (const part of message.parts ?? []) owners.set(part, message.parts!);
  }

  // How many images this tool call has already contributed, so a second one
  // lands after the first rather than in front of it.
  const inserted = new Map<MessagePart, number>();
  for (const ref of refs) {
    const parts = owners.get(ref.toolCallPart);
    if (!parts) continue;
    const part = await resolveHistoryImage(store, sessionId, ref.image);
    if (!part) continue;
    const offset = inserted.get(ref.toolCallPart) ?? 0;
    inserted.set(ref.toolCallPart, offset + 1);
    parts.splice(parts.indexOf(ref.toolCallPart) + 1 + offset, 0, part);
  }
}

/**
 * One history image as a renderable part, or `null` when there is honestly
 * nothing to point at.
 *
 * `null` is reserved for what is not a storable picture at all: an unreadable
 * source, or a media type this store could never have written. Everything else
 * — including bytes the retention sweep has already collected — resolves to a
 * part, because a URL that 404s tells the truth and an absence does not.
 */
async function resolveHistoryImage(
  store: SessionAttachmentStore,
  sessionId: string,
  image: ToolResultImage
): Promise<ImagePart | null> {
  if (image.kind === 'unreadable') return null;
  const attachmentId = deriveSessionAttachmentId(image.identity);
  try {
    const existing = await store.peek(sessionId, attachmentId, image.mediaType);
    if (existing) {
      // This transcript still references the picture, which makes it in use —
      // say so, or retention reads a file nobody has rewritten since it was
      // created as a file nobody wants (`SessionAttachmentStore.touch`).
      void store.touch(sessionId, attachmentId, storableImageExtension(image.mediaType) ?? '');
      return { type: 'image', attachmentId, ...existing };
    }
    const written = await store.put(
      sessionId,
      attachmentId,
      image.mediaType,
      decodeBase64(image.base64)
    );
    return { type: 'image', attachmentId, ...written };
  } catch {
    // Fall through to the placeholder: a read that failed is still a picture
    // the transcript is entitled to mention.
  }
  const url = store.urlFor(sessionId, attachmentId, image.mediaType);
  if (!url) return null;
  return { type: 'image', attachmentId, url, mediaType: image.mediaType, size: 0 };
}

/**
 * Decode a base64 image payload, refusing one too large to keep.
 *
 * The length is checked on the ENCODED string before decoding, because
 * `Buffer.from` would otherwise allocate the whole picture to discover it is too
 * big. Base64 is 4/3 of its payload, so the encoded cap is scaled to match.
 *
 * @param base64 - The payload exactly as the block carried it.
 * @throws {@link UnsupportedSessionMediaError} when it is past the cap.
 */
function decodeBase64(base64: string): Buffer {
  if (base64.length > Math.ceil((MAX_SESSION_ATTACHMENT_BYTES * 4) / 3) + 4) {
    throw new UnsupportedSessionMediaError('An image was too large to keep, so it was not saved.');
  }
  return Buffer.from(base64, 'base64');
}

/**
 * The typed error a reader sees in place of an image that could not be kept.
 *
 * A typed `error` rather than prose, because prose in the transcript reads as
 * something the model said. `execution_error` is the honest category — a step of
 * the turn failed — and the projector deliberately does not settle the lifecycle
 * on one, so a picture that could not be saved reports itself without claiming
 * the turn failed.
 */
function mediaError(message: string): StreamEvent {
  return {
    type: 'error',
    data: { message, code: 'SESSION_IMAGE_NOT_STORED', category: 'execution_error' },
  };
}
