/**
 * The one magic-byte reader in the tree.
 *
 * It lived inside the avatar store until rooms needed it too, and a second copy
 * is how the RIFF bug below comes back. Anything that decides whether bytes may
 * be served inline — a profile photo, a room attachment — asks here.
 *
 * @module server/services/identity/image-sniff
 */

/**
 * What an image DorkOS will render inline may be.
 *
 * Three raster formats every browser renders, and nothing else. SVG is absent
 * on purpose: it is a script vector, and `routes/files.ts` needs a bespoke CSP
 * sandbox to serve one safely — a thing a profile photo has no reason to need.
 */
export const PREVIEWABLE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** One of {@link PREVIEWABLE_IMAGE_TYPES}. */
export type PreviewableImageType = (typeof PREVIEWABLE_IMAGE_TYPES)[number];

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
/** The two halves of a WebP's RIFF header, as bytes. `RIFF` … `WEBP`. */
const RIFF_MAGIC = Buffer.from('RIFF', 'latin1');
const WEBP_MAGIC = Buffer.from('WEBP', 'latin1');
/** Where the second half sits: after the four-byte tag and the four-byte length. */
const WEBP_FORM_OFFSET = 8;

/**
 * What these bytes actually are, or `null` when they are not an image DorkOS
 * accepts.
 *
 * **The only evidence considered is the content.** A filename and a
 * `Content-Type` header are both written by whoever is uploading, so a `.png`
 * carrying a GIF, or an SVG announced as `image/png`, is exactly the case this
 * exists to catch. WebP needs both ends of its RIFF header read — `RIFF` alone
 * is also a WAV and an AVI.
 *
 * **Compare bytes, never decoded text.** This function read the RIFF header with
 * `toString('ascii')`, which masks bit 7: `D2 C9 C6 C6 … D7 C5 C2 D0` decodes to
 * `RIFF`/`WEBP`, so an HTML payload wearing those eight high-bit bytes was
 * accepted, stored, and served back as `image/webp` (found in review). Every
 * comparison here is now `Buffer.equals` over raw bytes, which no decoder can
 * launder.
 *
 * Bytes too short to carry a signature match nothing, with no length guard
 * needed: a truncated buffer's `subarray` is shorter than the magic it is
 * compared against, so `equals` is false.
 *
 * @param bytes - The uploaded file, or at least its first twelve bytes.
 */
export function sniffImageContentType(bytes: Buffer): PreviewableImageType | null {
  if (bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return 'image/png';
  if (bytes.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) return 'image/jpeg';
  if (
    bytes.subarray(0, RIFF_MAGIC.length).equals(RIFF_MAGIC) &&
    bytes.subarray(WEBP_FORM_OFFSET, WEBP_FORM_OFFSET + WEBP_MAGIC.length).equals(WEBP_MAGIC)
  ) {
    return 'image/webp';
  }
  return null;
}
