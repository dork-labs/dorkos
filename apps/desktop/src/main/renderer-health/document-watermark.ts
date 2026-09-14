/**
 * When the shell last threw away the document it was supervising.
 *
 * Its own module, and not a variable inside `renderer-health/index.ts`, for one
 * reason: `server-crash-recovery.ts` navigates the supervised window too, and it
 * has to stamp the same watermark. Importing `renderer-health` from there would
 * close a cycle (`renderer-health` → `diagnostics` → `server-process` →
 * `server-crash-recovery`), so the state both of them touch lives at the leaf
 * where neither has to import the other.
 *
 * @module main/renderer-health/document-watermark
 */

/** The stamp itself, in `Date.now()` milliseconds. Zero until something replaces a document. */
let replacedAt = 0;

/**
 * Note that the shell is replacing the document it was waiting on.
 *
 * Call it at the **instant** of the replacement, never a moment earlier: a
 * window can report alive on its own while a recovery rung is still clearing
 * caches, and that page is the live one until the navigation actually goes out.
 *
 * Every caller is a place the shell itself discards a page a heartbeat could
 * still arrive from: the recovery ladder's reloads, the recovery page, the app
 * going back on screen, and the windows sent to a restarted server.
 */
export function noteDocumentReplaced(): void {
  replacedAt = Date.now();
}

/** When the last replacement happened, or `0` if there has not been one. */
export function documentReplacedAt(): number {
  return replacedAt;
}

/**
 * Forget the watermark.
 *
 * @internal Exported for testing only.
 */
export function resetDocumentWatermark(): void {
  replacedAt = 0;
}
