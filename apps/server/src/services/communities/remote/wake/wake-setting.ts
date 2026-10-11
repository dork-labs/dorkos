/**
 * The shape of one space connection's "who may wake my agents" setting (spec
 * `official-community-space` D9), shared by the connection store that keeps it and the
 * in-memory gate that answers from it.
 *
 * @module services/communities/remote/wake/wake-setting
 */
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import type { RemoteConnectionStore } from '../connection-store.js';

/**
 * Who in a space may wake this owner's agents there: `'members'`, anyone in the space who
 * mentions one, or `'me'`, only the owner's own account.
 */
export type WakeAgentsFrom = 'me' | 'members';

/** What a connection's wake setting is when nobody chose one: today's behaviour. */
export const DEFAULT_WAKE_AGENTS_FROM: WakeAgentsFrom = 'members';

/** One connection's wake setting beside the owner's own member id in that space. */
export interface ConnectionWakeSetting {
  /** The local connection ref. */
  ref: CommunityRef;
  /** The local owner the connection belongs to. */
  ownerKey: string;
  /** The owner's own member id in the space, or `null` before pairing completes. */
  connectedHumanMemberId: string | null;
  /** Who may wake this owner's agents there. */
  wakeAgentsFrom: WakeAgentsFrom;
}

/**
 * Who in this space may wake the owner's agents; {@link DEFAULT_WAKE_AGENTS_FROM} when nobody
 * chose. Throws `RemoteConnectionNotFoundError` for another owner's connection.
 *
 * @param store - The connection store that keeps the setting.
 * @param ref - The local connection ref.
 * @param ownerKey - The local owner the connection belongs to.
 */
export async function readWakeAgentsFrom(
  store: RemoteConnectionStore,
  ref: CommunityRef,
  ownerKey: string
): Promise<WakeAgentsFrom> {
  await store.get(ref, ownerKey);
  const settings = await store.wakeSettings();
  const found = settings.find((setting) => setting.ref === ref && setting.ownerKey === ownerKey);
  return found?.wakeAgentsFrom ?? DEFAULT_WAKE_AGENTS_FROM;
}
