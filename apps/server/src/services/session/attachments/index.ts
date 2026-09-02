/**
 * Session attachments — where images a turn produced are stored, and how the
 * one wired store is reached.
 *
 * The registry mirrors `setRoomAttachmentStores` and exists for the same
 * reason: WHERE a session's images live is a deployment decision made once in
 * `index.ts`, and neither the runtime adapters nor the serving route may make
 * it.
 *
 * There is only a `try` accessor, deliberately. The room registry pairs one
 * with a throwing `get`, but nothing here wants a throw: the route turns an
 * unwired store into a 404 (the image is not available, which is true), and an
 * adapter turns it into `mediaOutput: 'none'` (it cannot carry media, which is
 * also true). A throwing twin would have had no callers, and an accessor with
 * no callers is a decision nobody has made yet.
 *
 * @module server/services/session/attachments
 */
import type { SessionAttachmentStore } from './session-attachment-store.js';

export {
  InvalidSessionAttachmentIdError,
  UnsupportedSessionMediaError,
  type PutSessionAttachment,
  type SessionAttachmentStore,
  type StoredSessionAttachment,
} from './session-attachment-store.js';
export { LocalSessionAttachmentStore } from './local-session-attachment-store.js';
export { deriveSessionAttachmentId } from './session-attachment-id.js';
export {
  MAX_SESSION_ATTACHMENT_BYTES,
  imageMediaTypeForExtension,
  storableImageExtension,
} from './session-media-types.js';
export {
  SESSION_ATTACHMENT_RETENTION_MS,
  SESSION_ATTACHMENT_SWEEP_INTERVAL_MS,
  sweepSessionAttachments,
  type SessionAttachmentSweepResult,
} from './session-attachment-sweep.js';

let activeStore: SessionAttachmentStore | null = null;

/**
 * Register the store at bootstrap. Called once from the composition root, which
 * is the only place that knows the resolved data directory.
 *
 * @param store - The wired store.
 */
export function setSessionAttachmentStore(store: SessionAttachmentStore): void {
  activeStore = store;
}

/** The active store, or `null` when bootstrap has not wired one. */
export function tryGetSessionAttachmentStore(): SessionAttachmentStore | null {
  return activeStore;
}

/**
 * Forget the wired store. Tests only — production wires once at boot and never
 * unwires.
 */
export function resetSessionAttachmentStore(): void {
  activeStore = null;
}
