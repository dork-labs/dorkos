/**
 * Turning an OpenCode `file` part into a DorkOS image, on the async side of the
 * mapper.
 *
 * `part-event-mapper.ts` is pure and synchronous by design, and storing bytes is
 * neither. So the mapper does not store anything: it records an INTENT on the
 * per-turn context ({@link OpenCodeMediaIntent}) the same way it records delta
 * baselines and tool guards, and this module drains those intents from the
 * runtime's own async turn loop, writes the bytes through the
 * {@link SessionAttachmentStore}, and yields the `image_attachment` events.
 *
 * The split has a second benefit worth stating, because it is the trap this
 * whole feature was built to avoid: **no base64 payload ever exists as a
 * StreamEvent.** The intent holds the source and lives for microseconds inside
 * one turn's context; the event that reaches the SSE stream, the ring buffer,
 * the event log and the durable store carries a URL. See `sessionImageShape` in
 * `packages/shared/src/schemas.ts` for what inlining the bytes would have cost.
 *
 * **Where the bytes may come from.** A `data:` URI is decoded, and a `file://`
 * path is read off this machine — both are local, produced by a sidecar running
 * as the same user, and neither leaves the machine. An `http(s)` URL is
 * DELIBERATELY not fetched: that would be DorkOS making an outbound request to
 * an address a model chose, which is a server-side request forgery with extra
 * steps. Such a part is reported as an image that could not be shown, which is
 * the honest answer and the one thing the old behaviour never gave anybody.
 *
 * @module services/runtimes/opencode/media-capture
 */
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { StreamEvent } from '@dorkos/shared/types';
import {
  MAX_SESSION_ATTACHMENT_BYTES,
  UnsupportedSessionMediaError,
  deriveSessionAttachmentId,
  type SessionAttachmentStore,
} from '../../../session/attachments/index.js';
import { logger } from '../../../../lib/logger.js';

/**
 * One image OpenCode handed over, recorded by the pure mapper and not yet
 * stored.
 *
 * Deliberately carries the SOURCE (a URL string) rather than the bytes: the
 * mapper does no I/O, so it has none to carry.
 */
export interface OpenCodeMediaIntent {
  /** What OpenCode says the bytes are (`FilePart.mime`). */
  mime: string;
  /** Where OpenCode says the bytes are (`FilePart.url`) — `data:` or `file://`. */
  url: string;
  /** The original filename, when OpenCode recorded one. Becomes the alt text. */
  filename?: string;
  /**
   * How OpenCode identifies this image within the session, most-significant
   * first. Hashed into the attachment id, so the same picture read back from
   * history lands at the same URL rather than being written a second time.
   */
  identity: readonly string[];
}

/** The slice of a turn's mapping context this module owns. */
export interface OpenCodeMediaState {
  /**
   * Images the mapper has seen and not yet stored, in the order they appeared.
   * Drained by {@link captureOpenCodeMedia} after every mapped wire event.
   */
  readonly pendingMedia: OpenCodeMediaIntent[];
  /**
   * Identity keys already recorded this turn — the single-shot guard, and the
   * reason one picture is announced once.
   *
   * `message.part.updated` carries a CUMULATIVE snapshot and fires repeatedly
   * for the same part: at part start, at part end, and on every tool state
   * transition (see the `part-event-mapper` module doc). Every other arm of
   * that mapper already defends — `text`/`reasoning` through the
   * `lastTextByPartId` delta baseline, `tool` through `endedToolCallIds` — and
   * without this one the `file` arm pushed an intent per republication. The
   * store deduped the BYTES (one file, one URL, because the id is derived), so
   * nothing was corrupted; what multiplied was the EVENTS, and the client's
   * fold appends a part per event with no upsert. Three snapshots, three
   * pictures on screen.
   */
  readonly recordedMediaKeys: Set<string>;
}

/**
 * Drain every pending image, store it, and yield its `image_attachment` event.
 *
 * Drains destructively and completely, so an event that is yielded is one whose
 * bytes are already fetchable — a client never sees a reference to something
 * that is not there yet.
 *
 * **Failures degrade to a sentence, never to silence.** Bytes past the cap, a
 * media type a session may not store, a source that cannot be read: each yields
 * a typed `error` StreamEvent saying what could not be shown. The whole point
 * of this feature is that a picture never again disappears without comment —
 * swapping one silent drop for another would miss it entirely.
 *
 * @param store - Where the bytes go, or `null` when the runtime was wired
 *   without one. With no store there is nothing honest to do but say so once
 *   per image and move on — and the runtime declares `mediaOutput: 'none'` in
 *   that configuration, so nothing was promised.
 * @param sessionId - The DorkOS session id the images belong to.
 * @param state - The turn's media bookkeeping (drained).
 */
export async function* captureOpenCodeMedia(
  store: SessionAttachmentStore | null,
  sessionId: string,
  state: OpenCodeMediaState
): AsyncGenerator<StreamEvent> {
  while (state.pendingMedia.length > 0) {
    const intent = state.pendingMedia.shift()!;
    if (!store) {
      yield mediaError('This agent is not set up to keep images, so one was not saved.');
      continue;
    }
    try {
      const attachmentId = deriveSessionAttachmentId(intent.identity);
      const existing = await store.peek(sessionId, attachmentId, intent.mime);
      const stored =
        existing ??
        (await store.put(sessionId, attachmentId, intent.mime, await readMediaBytes(intent)));
      yield {
        type: 'image_attachment',
        data: {
          attachmentId,
          url: stored.url,
          mediaType: stored.mediaType,
          size: stored.size,
          ...(intent.filename !== undefined ? { alt: intent.filename } : {}),
        },
      };
    } catch (err) {
      if (err instanceof UnsupportedSessionMediaError) {
        yield mediaError(err.message);
        continue;
      }
      logger.warn('[OpenCodeRuntime] could not store an image the turn produced', {
        err,
        sessionId,
      });
      yield mediaError('An image was produced but could not be saved.');
    }
  }
}

/**
 * The typed error a reader sees in place of an image that could not be kept.
 *
 * A typed `error` rather than prose, because prose in the transcript reads as
 * something the model said. `execution_error` is the honest category — a step
 * of the turn failed — and the projector deliberately does not settle the
 * lifecycle on one, so a picture that could not be saved reports itself without
 * claiming the turn failed.
 */
function mediaError(message: string): StreamEvent {
  return {
    type: 'error',
    data: { message, code: 'SESSION_IMAGE_NOT_STORED', category: 'execution_error' },
  };
}

/**
 * The bytes behind one intent.
 *
 * @param intent - The recorded image.
 * @throws {@link UnsupportedSessionMediaError} when the source is one this
 *   machine will not read, or is larger than a session will store.
 */
async function readMediaBytes(intent: OpenCodeMediaIntent): Promise<Buffer> {
  if (intent.url.startsWith('data:')) return decodeDataUrl(intent.url);
  if (intent.url.startsWith('file://')) return readLocalFile(intent.url);
  throw new UnsupportedSessionMediaError(
    'An image was produced at a web address, which is not fetched from here, so it could not be shown.'
  );
}

/**
 * Decode a `data:` URI's payload.
 *
 * Base64 only. A percent-encoded `data:` URI is legal and no image producer
 * emits one, so it is refused rather than half-supported — an image that
 * decodes into garbage is worse than one that says it could not be read.
 *
 * The length is checked on the ENCODED string before decoding, because
 * `Buffer.from` would otherwise allocate the whole picture to discover it is
 * too big. Base64 is 4/3 of the payload, so the encoded cap is scaled to match.
 */
function decodeDataUrl(url: string): Buffer {
  const comma = url.indexOf(',');
  if (comma === -1) throw new UnsupportedSessionMediaError('An image arrived malformed.');
  const header = url.slice(5, comma);
  if (!header.includes(';base64')) {
    throw new UnsupportedSessionMediaError('An image arrived in a format that could not be read.');
  }
  const encoded = url.length - comma - 1;
  if (encoded > Math.ceil((MAX_SESSION_ATTACHMENT_BYTES * 4) / 3) + 4) {
    throw new UnsupportedSessionMediaError('An image was too large to keep, so it was not saved.');
  }
  return Buffer.from(url.slice(comma + 1), 'base64');
}

/**
 * Read a `file://` image off this machine.
 *
 * `stat` first, so a pathological file is refused without being read into
 * memory — the same reason the `data:` branch measures before it decodes.
 */
async function readLocalFile(url: string): Promise<Buffer> {
  let file: string;
  try {
    file = fileURLToPath(url);
  } catch {
    throw new UnsupportedSessionMediaError(
      'An image arrived at an address that could not be read.'
    );
  }
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) {
    throw new UnsupportedSessionMediaError(
      'An image was produced but its file is no longer there.'
    );
  }
  if (info.size > MAX_SESSION_ATTACHMENT_BYTES) {
    throw new UnsupportedSessionMediaError('An image was too large to keep, so it was not saved.');
  }
  return readFile(file);
}
