/**
 * Extension-remount bridge — a module singleton that lets non-React callers
 * request a live re-mount of every extension slot without a page reload.
 *
 * `ExtensionProvider` registers its fetch-then-swap `reloadAll` here on mount;
 * callers invoke {@link requestExtensionRemount}. This is the seam the Shape
 * apply flow drives: applying a Shape enables extensions server-side, and the
 * newly-activated slots must surface without a reload (DOR-355 W1c). Kept in the
 * shared layer (not the extensions feature) so both the module-scope UI
 * dispatcher wiring and the shapes feature can reach it without a cross-feature
 * import — the same singleton-in-shared pattern as the StreamManager.
 *
 * @module shared/lib/extension-remount
 */

/** The currently-registered remount handler, or null when no provider is mounted. */
let remountHandler: (() => Promise<void>) | null = null;

/**
 * Register the live-remount handler. Called once by `ExtensionProvider` on mount;
 * returns an unregister function to call on unmount so a torn-down provider never
 * leaves a stale handler behind.
 *
 * @param handler - Fetch-then-swap reload of every extension slot.
 * @returns An unregister function (idempotent; only clears its own handler).
 */
export function registerExtensionRemount(handler: () => Promise<void>): () => void {
  remountHandler = handler;
  return () => {
    if (remountHandler === handler) remountHandler = null;
  };
}

/**
 * Request a live re-mount of the extension slots. A no-op (resolves immediately)
 * when no provider is mounted, so callers can fire it unconditionally.
 *
 * @returns A promise that settles when the remount completes (or immediately when unwired).
 */
export function requestExtensionRemount(): Promise<void> {
  return remountHandler ? remountHandler() : Promise.resolve();
}
