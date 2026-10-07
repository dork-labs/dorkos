/**
 * Who in a space may wake this install's agents, answered synchronously for the live stream
 * bridge (spec `official-community-space` D9).
 *
 * The setting lives in the connection store's side record, which is read from disk. A live frame
 * is imported synchronously, so this keeps the answer in memory: loaded once before streams
 * start, reloaded after every committed connection change, and written through on every change
 * of the setting itself. Until it has loaded, and for a connection it does not know, it wakes
 * nobody — a missed wake costs a mention, a wrong one hands a stranger a turn.
 *
 * @module services/communities/remote/wake-policy
 */
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import { logger } from '../../../lib/logger.js';
import type { RemoteConnectionStore, WakeAgentsFrom } from './connection-store.js';

/** The question the live stream bridge asks before a space message may start a turn. */
export interface RemoteWakeGate {
  /**
   * Whether a message by `authorMemberId` in this owner's space may wake the owner's agents.
   *
   * @param communityRef - The local connection ref.
   * @param ownerAuthorId - The local owner the connection belongs to.
   * @param authorMemberId - The message author's member id in the space.
   */
  wakes(communityRef: CommunityRef, ownerAuthorId: string, authorMemberId: string): boolean;
}

interface Entry {
  from: WakeAgentsFrom;
  ownerMemberId: string | null;
}

/** The production {@link RemoteWakeGate} over the connection store. */
export class RemoteWakePolicy implements RemoteWakeGate {
  private entries: ReadonlyMap<string, Entry> | null = null;
  private generation = 0;

  /**
   * Build the gate and follow every committed connection change.
   *
   * @param store - The connection store that owns the setting.
   */
  constructor(private readonly store: RemoteConnectionStore) {
    store.onChange(() => {
      void this.reload();
    });
  }

  /** Read every connection's setting into memory. Safe to call at any time; the newest read wins. */
  async reload(): Promise<void> {
    const generation = ++this.generation;
    try {
      const settings = await this.store.wakeSettings();
      if (generation !== this.generation) return;
      this.entries = new Map(
        settings.map((setting) => [
          key(setting.ref, setting.ownerKey),
          { from: setting.wakeAgentsFrom, ownerMemberId: setting.connectedHumanMemberId },
        ])
      );
    } catch (error) {
      // The last answer stands; with none, nobody wakes anything.
      logger.warn('[RemoteWakePolicy] Could not read who may wake agents in spaces', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The owner's setting for one connection.
   *
   * @param ref - The local connection ref.
   * @param ownerKey - The local owner the connection belongs to.
   */
  get(ref: CommunityRef, ownerKey: string): Promise<WakeAgentsFrom> {
    return this.store.wakeAgentsFrom(ref, ownerKey);
  }

  /**
   * Change the owner's setting for one connection and apply it before returning, so a live
   * message that arrives a moment later is judged by the new answer.
   *
   * @param ref - The local connection ref.
   * @param ownerKey - The local owner the connection belongs to.
   * @param value - Who may wake the owner's agents there.
   */
  async set(ref: CommunityRef, ownerKey: string, value: WakeAgentsFrom): Promise<void> {
    await this.store.setWakeAgentsFrom(ref, ownerKey, value);
    await this.reload();
  }

  /** @inheritdoc */
  wakes(communityRef: CommunityRef, ownerAuthorId: string, authorMemberId: string): boolean {
    const entry = this.entries?.get(key(communityRef, ownerAuthorId));
    if (!entry) return false;
    if (entry.from === 'members') return true;
    return entry.ownerMemberId !== null && entry.ownerMemberId === authorMemberId;
  }
}

function key(ref: CommunityRef, ownerKey: string): string {
  return `${ownerKey}\0${ref}`;
}
