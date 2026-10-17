/**
 * Which remembered tabs point at something that no longer exists: a chat that
 * was deleted, a room the person left or that was removed.
 *
 * Asked once when a window opens on restored tabs (`usePruneMissingTabs`).
 * Only a definite "not found" from the server counts. A network error, a
 * server still starting, any other refusal keeps the tab: dropping a real tab
 * because the server was slow is far worse than keeping a dead one, which
 * shows its own page and can be closed like any other.
 *
 * @module features/app-tabs/lib/missing-tabs
 */
import { parseTabHref } from './tab-target';

/** The two lookups this needs, narrowed from the transport so tests stay small. */
export interface TabTargetLookups {
  /** Resolves when the chat exists; rejects with `status: 404` when it does not. */
  getSession: (id: string) => Promise<unknown>;
  /** Resolves when the room exists and you are in it; rejects with `status: 404` when not. */
  getRoom: (id: string) => Promise<unknown>;
}

/** Whether an error is the server saying "no such thing". */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 404
  );
}

/** Ask once; answer whether the server said it is gone. */
async function isGone(lookup: () => Promise<unknown>): Promise<boolean> {
  try {
    await lookup();
    return false;
  } catch (error) {
    return isNotFound(error);
  }
}

/**
 * Find the tabs whose chat or room is gone.
 *
 * A draft chat has no row yet, so it is never asked about; a room in a
 * connected community is that community's to answer, so it is left alone.
 * Each chat or room is asked about once, however many tabs show it.
 *
 * @param tabs - The tabs to check: `id` and `href` are all it reads.
 * @param lookups - See {@link TabTargetLookups}.
 * @returns The ids of the tabs to drop.
 */
export async function findMissingTabs(
  tabs: ReadonlyArray<{ id: string; href: string }>,
  lookups: TabTargetLookups
): Promise<Set<string>> {
  const checks = new Map<string, Promise<boolean>>();
  const ask = (key: string, lookup: () => Promise<unknown>) => {
    let check = checks.get(key);
    if (!check) {
      check = isGone(lookup);
      checks.set(key, check);
    }
    return check;
  };

  const verdicts = await Promise.all(
    tabs.map(async (tab) => {
      const target = parseTabHref(tab.href);
      if (target.pathname === '/session' && target.sessionId && !target.draft) {
        const id = target.sessionId;
        return (await ask(`session:${id}`, () => lookups.getSession(id))) ? tab.id : null;
      }
      if (target.pathname === '/channels' && target.roomId && !target.community) {
        const id = target.roomId;
        return (await ask(`room:${id}`, () => lookups.getRoom(id))) ? tab.id : null;
      }
      return null;
    })
  );
  return new Set(verdicts.filter((id): id is string => id !== null));
}
