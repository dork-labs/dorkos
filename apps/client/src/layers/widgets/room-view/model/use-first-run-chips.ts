/**
 * Whether #team is still at the first run's welcome, and which chips it owes
 * (spec `one-minute-onboarding` §2.4).
 *
 * @module widgets/room-view/model/use-first-run-chips
 */
import { useConfig } from '@/layers/entities/config';
import { useLoadedRoomEntries, usePendingPosts } from '@/layers/entities/room';

/**
 * Which strip sits under DorkBot's welcome:
 *
 * - `starters`: the agents can run, so the chips are first jobs for DorkBot.
 * - `connect`: no AI is connected yet, so the chips are the two ways to connect.
 */
export type FirstRunChipsMode = 'starters' | 'connect';

/**
 * The strip under DorkBot's welcome, while the welcome is the newest thing in
 * the room and nothing the person sent is on its way. The first message from
 * anybody takes it away: chips under a conversation already underway are
 * noise.
 *
 * Keyed on the welcome's entry id the first run stored, so no other room and
 * no later welcome-shaped message ever grows chips.
 *
 * @param roomId - The room on screen, or `null` before it resolves.
 * @returns The strip it owes, or `null` for none.
 */
export function useFirstRunChips(roomId: string | null): FirstRunChipsMode | null {
  const { data: config } = useConfig();
  const entries = useLoadedRoomEntries(roomId);
  const inFlight = usePendingPosts(roomId, null);

  const welcomeEntryId = config?.onboarding?.welcomeEntryId ?? null;
  if (roomId === null || welcomeEntryId === null || !entries || inFlight.length > 0) return null;
  const newest = entries.reduce<(typeof entries)[number] | undefined>(
    (latest, entry) => (latest === undefined || entry.seq > latest.seq ? entry : latest),
    undefined
  );
  if (newest?.id !== welcomeEntryId) return null;
  return config?.onboarding?.firstRunPath === 'none' ? 'connect' : 'starters';
}
