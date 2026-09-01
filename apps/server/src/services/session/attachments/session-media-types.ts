/**
 * The image types a session may store, and the file suffix each is filed under.
 *
 * **This allowlist is why session attachments need no database row.** Room
 * attachments carry one (`room_attachments`) because they are arbitrary files a
 * person uploaded: an original filename, a declared type that may be a lie, and
 * a sniffed type that may disagree with it — three facts that only a row can
 * hold. A session attachment is none of that. It is machine-generated media
 * whose type its producer declared, accepted only if it is one of the four
 * below, and stored under the suffix this table assigns. Type and suffix are
 * therefore a bijection, the size is a `stat`, and the owning session is the
 * directory the file sits in — so everything a row would have held is already
 * on disk, and a migration would buy nothing but a second copy to keep in sync.
 *
 * **SVG is deliberately absent.** It is the one image format that executes, and
 * these bytes are authored by a model or by whatever a tool handed back. The
 * rooms route defends against the same thing by serving anything unverified as
 * `application/octet-stream`; here the defense is earlier and simpler — bytes
 * that are not one of these four raster formats are never stored at all. No
 * image model emits SVG, so nothing real is lost.
 *
 * @module server/services/session/attachments/session-media-types
 */

/** Media type → the suffix its bytes are stored under, without a dot. */
const EXTENSION_BY_MEDIA_TYPE: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** Suffix → media type, the read direction. Derived, so the two cannot drift. */
const MEDIA_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(EXTENSION_BY_MEDIA_TYPE).map(([mediaType, extension]) => [extension, mediaType])
);

/**
 * The suffix these bytes are stored under, or `null` when the type is not one a
 * session may store.
 *
 * Case- and parameter-insensitive: a producer may hand back
 * `IMAGE/PNG` or `image/png; charset=binary`, and both name the same format.
 *
 * @param mediaType - The media type the producer declared.
 */
export function storableImageExtension(mediaType: string): string | null {
  const bare = mediaType.split(';')[0].trim().toLowerCase();
  return EXTENSION_BY_MEDIA_TYPE[bare] ?? null;
}

/**
 * The media type a stored suffix is served as, or `null` for a suffix nothing
 * here could have written.
 *
 * The read half of the bijection: it is what lets the serving route answer a
 * `Content-Type` from the filename alone, with no row to consult and no
 * sniffing.
 *
 * @param extension - The stored suffix, without a dot.
 */
export function imageMediaTypeForExtension(extension: string): string | null {
  return MEDIA_TYPE_BY_EXTENSION[extension.toLowerCase()] ?? null;
}

/**
 * The largest image a session will store, in bytes.
 *
 * Ten mebibytes. Sized against what actually arrives rather than against a
 * round number: a Gemini/Nano-Banana-class generated image lands between one
 * and three megabytes, and a full-page screenshot from a browser tool is
 * comparable, so this holds the real cases several times over while bounding
 * what one turn can write to disk. Bytes past it are refused whole — never
 * truncated, because half a PNG is not a smaller PNG, it is a broken one.
 */
export const MAX_SESSION_ATTACHMENT_BYTES = 10 * 1024 * 1024;
