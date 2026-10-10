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
 * @module services/communities/remote/wake/wake-policy
 */
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import { logger } from '../../../../lib/logger.js';
import type { RemoteConnectionStore } from '../connection-store.js';
import { readWakeAgentsFrom, type WakeAgentsFrom } from './wake-setting.js';

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
  /** The newest read started, and the newest one whose answer is in {@link entries}. */
  private started = 0;
  private applied = 0;

  /**
   * Build the gate and follow every committed connection change.
   *
   * @param store - The connection store that owns the setting.
   * @param retryDelaysMs - How long to wait before each further attempt when a read fails and
   *   the gate has no answer yet. Bounded: past the last one the gate keeps waking nobody until
   *   the next connection change reads again.
   */
  constructor(
    private readonly store: RemoteConnectionStore,
    private readonly retryDelaysMs: readonly number[] = [250, 1_000, 5_000]
  ) {
    store.onChange(() => {
      void this.reload();
    });
  }

  /**
   * Read every connection's setting into memory. Safe to call at any time.
   *
   * A newer read's answer always wins over an older one, whichever finishes first, and a read
   * that fails changes nothing: the last good answer stands. Only while there is no answer at
   * all does a failed read try again, a bounded number of times.
   */
  async reload(): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      const generation = ++this.started;
      try {
        const settings = await this.store.wakeSettings();
        if (generation > this.applied) {
          this.applied = generation;
          this.entries = new Map(
            settings.map((setting) => [
              key(setting.ref, setting.ownerKey),
              { from: setting.wakeAgentsFrom, ownerMemberId: setting.connectedHumanMemberId },
            ])
          );
        }
        return;
      } catch (error) {
        logger.warn('[RemoteWakePolicy] Could not read who may wake agents in spaces', {
          attempt: attempt + 1,
          error: error instanceof Error ? error.message : String(error),
        });
        const wait = this.retryDelaysMs[attempt];
        if (this.entries !== null || wait === undefined) return;
        await new Promise((resolve) => setTimeout(resolve, wait));
        if (this.entries !== null) return;
      }
    }
  }

  /**
   * The owner's setting for one connection.
   *
   * @param ref - The local connection ref.
   * @param ownerKey - The local owner the connection belongs to.
   */
  get(ref: CommunityRef, ownerKey: string): Promise<WakeAgentsFrom> {
    return readWakeAgentsFrom(this.store, ref, ownerKey);
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
    // Applied here directly, never left to the reload below: a reload that fails
    // keeps the last good answer, and for a tightening to `me` that would be the
    // old `members` while the owner was told it changed.
    const current = this.entries?.get(key(ref, ownerKey));
    if (current) {
      // And newer than every read already in flight, so none that started before
      // this write can land afterwards and put the old answer back.
      this.applied = ++this.started;
      this.entries = new Map(this.entries).set(key(ref, ownerKey), { ...current, from: value });
    }
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
