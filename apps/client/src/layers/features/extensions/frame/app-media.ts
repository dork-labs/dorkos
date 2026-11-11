/**
 * How an app's `api.media` brings a picture or a video from its own server
 * routes into its frame (DOR-3293).
 *
 * A frame cannot reach the network (`connect-src 'none'`), so the host fetches
 * the file and hands the frame a `Blob`. The frame shows it through
 * `URL.createObjectURL`, which its policy allows for pictures and video only
 * (`img-src blob:`, `media-src blob:`).
 *
 * @module features/extensions/frame/app-media
 */
import { readAppResponse } from './app-request';

/** The largest picture or video an app may bring into its frame: 32 MB. */
export const APP_MEDIA_MAX_BYTES = 32 * 1024 * 1024;

/**
 * The types an app may show. SVG is left out on purpose: it is a document
 * that can carry script, not a picture.
 */
export const APP_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
  'video/mp4',
  'video/webm',
]);

/** Thrown when a reply is not a picture or video an app may show. */
const NOT_MEDIA = 'That file is not a picture or video this app can show.';
const TOO_BIG = 'That file is too big to show (32 MB at most).';

/**
 * Read a reply from the app's own route as a picture or video.
 *
 * A failed reply rejects exactly as `api.request` does, with its status and
 * body. A success must name an allowed type and fit under the cap; the size is
 * checked from `Content-Length` before reading, and again while reading, so a
 * reply that lies about its size is cut off rather than read whole.
 *
 * @param response - The reply from the app's own route.
 * @returns The file, typed by the host from the reply's `Content-Type`.
 * @throws An `AppRequestFailure` for a failed reply, or an `Error` for a
 *   type that is not allowed or a file over the cap.
 */
export async function readAppMedia(response: Response): Promise<Blob> {
  if (!response.ok) {
    await readAppResponse(response);
    throw new Error(NOT_MEDIA);
  }
  const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!APP_MEDIA_TYPES.has(type)) {
    await response.body?.cancel();
    throw new Error(NOT_MEDIA);
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > APP_MEDIA_MAX_BYTES) {
    await response.body?.cancel();
    throw new Error(TOO_BIG);
  }
  if (!response.body) return new Blob([], { type });
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > APP_MEDIA_MAX_BYTES) {
      await reader.cancel();
      throw new Error(TOO_BIG);
    }
    chunks.push(value);
  }
  return new Blob(chunks as BlobPart[], { type });
}
