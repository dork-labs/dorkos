/**
 * Which rooms each mini app may read and reply in as the person
 * (`extensions.roomAccess`, DOR-3017).
 *
 * The person's choice, made in Settings → Extensions and written only through
 * `PUT /api/extensions/:id/room-access` behind the person bar. An agent cannot
 * write it: the leaf is `operator-only` in `config-write-policy.ts`. A mini
 * app's own page code runs in the person's window and so passes that bar, as
 * does a server half running inside DorkOS: the choice bounds a well-behaved
 * mini app and is not a sandbox. Dropped when the mini app's run approval is
 * withdrawn ({@link withoutExtension}), so another copy under the same id
 * starts with none.
 *
 * Read per call rather than cached, so taking a room away takes effect on the
 * next request and ends a live thread stream at its next event.
 *
 * @module services/extensions/rooms/extension-room-access
 */
import { configManager } from '../../core/config-manager.js';
import { logConfigWrite } from '../../core/operator/config-write.js';

/** Most rooms one mini app may be given. */
export const ROOM_ACCESS_MAX = 50;

/**
 * The rooms a person picked for one mini app. Empty when they picked none.
 *
 * @param extensionId - The mini app.
 */
export function allowedRoomIds(extensionId: string): readonly string[] {
  return configManager.get('extensions')?.roomAccess?.[extensionId] ?? [];
}

/**
 * Whether a person picked this room for this mini app.
 *
 * @param extensionId - The mini app.
 * @param roomId - The room.
 */
export function isRoomAllowed(extensionId: string, roomId: string): boolean {
  return allowedRoomIds(extensionId).includes(roomId);
}

/**
 * Replace the rooms one mini app may use. An empty list removes its entry.
 * Only `PUT /api/extensions/:id/room-access` calls this, behind the person bar.
 * Spreads the whole `extensions` section, because the store write replaces the
 * subtree and naming only this key would erase every approval beside it.
 *
 * @param extensionId - The mini app.
 * @param roomIds - The rooms, deduplicated here.
 * @returns The rooms now allowed.
 */
export function setAllowedRooms(extensionId: string, roomIds: readonly string[]): string[] {
  const before = configManager.get('extensions');
  const next = { ...(before?.roomAccess ?? {}) };
  const unique = [...new Set(roomIds)];
  if (unique.length === 0) delete next[extensionId];
  else next[extensionId] = unique;
  configManager.set('extensions', { ...before, roomAccess: next });
  logConfigWrite(
    'choosing the rooms a mini app may use',
    'extensions',
    before,
    configManager.get('extensions')
  );
  return unique;
}

/**
 * A copy of a per-extension map without one extension's entry: what a
 * withdrawn approval leaves behind. Room access goes with the run approval, so
 * a different copy installed under the same id starts with no rooms.
 *
 * @param map - The map, keyed by extension id.
 * @param extensionId - The extension to drop.
 */
export function withoutExtension<T>(
  map: Readonly<Record<string, T>> | undefined,
  extensionId: string
): Record<string, T> {
  const next = { ...map };
  delete next[extensionId];
  return next;
}

/**
 * The person's own picks for one mini app, removed: its rooms (DOR-3017) and
 * the agent it forwards to (DOR-3325). Spread into the `extensions` section
 * when its run approval is withdrawn, so another copy under the same id starts
 * with neither.
 *
 * @param extensions - The `extensions` config section.
 * @param extensionId - The extension to drop.
 */
export function withoutPersonChoices(
  extensions: {
    roomAccess?: Readonly<Record<string, string[]>>;
    forwardAgent?: Readonly<Record<string, string>>;
  },
  extensionId: string
): { roomAccess: Record<string, string[]>; forwardAgent: Record<string, string> } {
  return {
    roomAccess: withoutExtension(extensions.roomAccess, extensionId),
    forwardAgent: withoutExtension(extensions.forwardAgent, extensionId),
  };
}
