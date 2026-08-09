/**
 * The palette actions extensions bring with them.
 *
 * An extension's `registerCommand()` contributes a palette row AND the code
 * that row runs. The row travels through the extension registry's
 * `command-palette.items` slot; the code travels here, keyed by the same action
 * id (`ext:<extension>:<command>`) the row carries. `usePaletteActions` has a
 * closed switch for the cockpit's own actions and falls through to this map for
 * everything else — which is what makes an id the cockpit has never heard of a
 * working row rather than a click that closes the dialog and does nothing
 * (DOR-1051).
 *
 * A plain module-level map, not a store: nothing renders from it, the writers
 * are outside React (extension load and teardown, wired in `main.tsx`), and its
 * lifetime is the app's.
 *
 * @module features/command-palette/model/palette-command-handlers
 */

/** Action id → the callback its extension registered. */
const handlers = new Map<string, () => void>();

/**
 * Claim an action id for an extension's callback.
 *
 * One handler per id: a re-register replaces rather than stacks, so an
 * extension hot-reload cannot leave the previous load's dead copy running
 * beside the live one.
 *
 * @param actionId - The palette action id, `ext:<extension>:<command>`.
 * @param handler - What to run when that row is chosen.
 */
export function registerPaletteCommandHandler(actionId: string, handler: () => void): void {
  handlers.set(actionId, handler);
}

/**
 * Forget an action id, when its extension unloads.
 *
 * @param actionId - The palette action id to release.
 */
export function unregisterPaletteCommandHandler(actionId: string): void {
  handlers.delete(actionId);
}

/**
 * Run whatever claimed `actionId`.
 *
 * Answers whether anything did, so the caller can tell "an extension handled
 * it" from "nobody did" — the palette says so in the console rather than
 * closing on a row that silently did nothing.
 *
 * @param actionId - The palette action id to dispatch.
 * @returns True when a handler ran.
 */
export function runPaletteCommandHandler(actionId: string): boolean {
  const handler = handlers.get(actionId);
  if (!handler) return false;
  handler();
  return true;
}
