/**
 * Storing one image a turn produced and announcing it — the step every
 * runtime's media capture shares (Claude Code, Codex, OpenCode).
 *
 * Each runtime's own `media-capture.ts` knows where its pictures come from (an
 * MCP image block, a `data:` or `file://` part, a tool-result block) and which
 * session id keys storage. What happens next is the same everywhere, and lives
 * here so the three can never drift: the bytes go through the
 * {@link SessionAttachmentStore} under a derived id, and the turn yields an
 * `image_attachment` event carrying a URL — **no base64 payload ever exists as
 * a StreamEvent**. A picture that cannot be kept yields a typed `error` saying
 * so, never silence.
 *
 * @module services/runtimes/shared/media-capture
 */
import type { StreamEvent } from '@dorkos/shared/types';
import {
  MAX_SESSION_ATTACHMENT_BYTES,
  UnsupportedSessionMediaError,
  deriveSessionAttachmentId,
  type SessionAttachmentStore,
} from '../../session/attachments/index.js';

/** What a reader sees for an image too large to keep. */
export const IMAGE_TOO_LARGE_MESSAGE = 'An image was too large to keep, so it was not saved.';

/** One image ready to store: how to name it, and how to get its bytes. */
export interface CapturedImage {
  /** The runtime's identity for this picture, hashed into the attachment id. */
  identity: readonly string[];
  /** What the bytes are, e.g. `image/png`. */
  mediaType: string;
  /** Alt text, when the runtime has one (OpenCode's filename). */
  alt?: string;
  /** Read or decode the bytes; only called when the picture is not stored yet. */
  bytes: () => Buffer | Promise<Buffer>;
}

/**
 * Whether a base64 payload of this many characters is past the session image
 * cap. Measured on the ENCODED length, before decoding, because `Buffer.from`
 * would otherwise allocate the whole picture to discover it is too big. Base64
 * is 4/3 of its payload, so the cap is scaled to match.
 *
 * @param encodedLength - Characters of base64.
 */
export function exceedsEncodedImageCap(encodedLength: number): boolean {
  return encodedLength > Math.ceil((MAX_SESSION_ATTACHMENT_BYTES * 4) / 3) + 4;
}

/**
 * Decode a base64 image payload, refusing one too large to keep.
 *
 * @param base64 - The payload exactly as the block carried it.
 * @throws {@link UnsupportedSessionMediaError} when it is past the cap.
 */
export function decodeBase64Image(base64: string): Buffer {
  if (exceedsEncodedImageCap(base64.length)) {
    throw new UnsupportedSessionMediaError(IMAGE_TOO_LARGE_MESSAGE);
  }
  return Buffer.from(base64, 'base64');
}

/**
 * The typed error a reader sees in place of an image that could not be kept.
 *
 * A typed `error` rather than prose, because prose in the transcript reads as
 * something the model said. `execution_error` is the honest category — a step
 * of the turn failed — and the projector deliberately does not settle the
 * lifecycle on one, so a picture that could not be saved reports itself without
 * claiming the turn failed.
 *
 * @param message - What could not be shown, in plain words.
 */
export function mediaError(message: string): StreamEvent {
  return {
    type: 'error',
    data: { message, code: 'SESSION_IMAGE_NOT_STORED', category: 'execution_error' },
  };
}

/**
 * Store one image and return the event that announces it.
 *
 * An image already stored under its derived id is reused, not written again.
 * With no store wired the runtime declares `mediaOutput: 'none'`, so nothing
 * was promised and the answer is a sentence saying the image was not kept. A
 * refusal the store explains (past the cap, a media type a session may not
 * keep, a source that cannot be read) is shown as that explanation; anything
 * else is reported to `onFailure` for the log and shown as a generic sentence.
 *
 * @param store - Where the bytes go, or `null` when the runtime has none.
 * @param storageId - The session id that keys storage.
 * @param image - The picture to store.
 * @param onFailure - Logs an unexpected storage failure.
 */
export async function storeCapturedImage(
  store: SessionAttachmentStore | null,
  storageId: string,
  image: CapturedImage,
  onFailure: (err: unknown) => void
): Promise<StreamEvent> {
  if (!store) return mediaError('This agent is not set up to keep images, so one was not saved.');
  try {
    const attachmentId = deriveSessionAttachmentId(image.identity);
    const existing = await store.peek(storageId, attachmentId, image.mediaType);
    const stored =
      existing ?? (await store.put(storageId, attachmentId, image.mediaType, await image.bytes()));
    return {
      type: 'image_attachment',
      data: {
        attachmentId,
        url: stored.url,
        mediaType: stored.mediaType,
        size: stored.size,
        ...(image.alt !== undefined ? { alt: image.alt } : {}),
      },
    };
  } catch (err) {
    if (err instanceof UnsupportedSessionMediaError) return mediaError(err.message);
    onFailure(err);
    return mediaError('An image was produced but could not be saved.');
  }
}
