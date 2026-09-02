/**
 * How a runtime adapter names one image, so it can name it again later.
 *
 * **Deterministic, and that is the whole design.** A session's history is read
 * back from the runtime's own store (SDK JSONL, Codex threads, the OpenCode
 * sidecar) every time the transcript is reopened — including after a server
 * restart that saw none of the original turn. If an adapter minted a random id
 * per read, every reopen would write a second copy of a picture that was
 * already on disk and the transcript would drift from the bytes. Deriving the
 * id from the runtime's OWN identity for that image makes the write idempotent:
 * the same picture lands at the same path, at the same URL, forever.
 *
 * Runtime-neutral on purpose. Each adapter passes whatever it uses to identify
 * an image within a session — OpenCode passes its part id (or the tool call id
 * plus the attachment's index); the claude-code and codex adapters will pass
 * their own equivalents when they adopt this seam. The only contract is that
 * the components are stable across reads of the same transcript and distinct
 * between different images.
 *
 * @module server/services/session/attachments/session-attachment-id
 */
import { createHash } from 'node:crypto';

/**
 * The attachment id for one image, derived from how its runtime identifies it.
 *
 * Hashed rather than concatenated for two reasons that both matter: the parts
 * come from a runtime and may contain anything (a `/`, a `..`, a newline),
 * while an attachment id reaches the filesystem and a URL path segment; and a
 * digest is fixed-length, so no combination of long part ids can overflow a
 * filename. The components are joined under a separator that cannot appear in
 * the hash input's own alphabet by accident, so `['a|b']` and `['a','b']` do
 * not collide.
 *
 * Truncated to 32 hex characters — 128 bits. These ids are scoped to one
 * session's directory and are not secrets; 128 bits makes an accidental
 * collision between two images in one transcript unreachable.
 *
 * @param components - Whatever the runtime uses to identify this image within
 *   the session, most-significant first. Must be stable across reads.
 */
export function deriveSessionAttachmentId(components: readonly string[]): string {
  const input = components.map((part) => part.replace(/\|/g, '||')).join('|-|');
  return createHash('sha256').update(input).digest('hex').slice(0, 32);
}
