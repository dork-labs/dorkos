/**
 * The latch that decides when asking for notification permission is FAIR.
 *
 * DorkOS never asks at launch. A permission prompt on arrival is the pattern
 * everybody has learned to dismiss reflexively, and a reflexive "block" is
 * permanent — Chrome does not ask twice, and the setting is buried. So the ask
 * waits for the first moment a person would actually want the answer: a turn
 * that has been running long enough to walk away from, or something that has
 * genuinely stopped and is waiting on them.
 *
 * A module-level latch rather than component state because the two triggers live
 * in different places — the long-turn timer is in the session view, the blocking
 * arrival is watched by the app-wide notification center — and they must arm ONE
 * card, not two.
 *
 * @module features/notifications/model/primer-trigger
 */
import { useSyncExternalStore } from 'react';

/**
 * How long a turn must run before it counts as one worth walking away from.
 *
 * Thirty seconds. Short enough that a real piece of work reaches it, long enough
 * that the quick back-and-forth of a conversation never does — asking during a
 * fast exchange would be asking while somebody is plainly at the keyboard, which
 * is the same mistake as asking at launch, just later.
 */
export const LONG_TURN_MS = 30_000;

/** Whether anything has happened yet that earns the question. */
let armed = false;

/** Everyone waiting to hear that it has. */
const listeners = new Set<() => void>();

/**
 * Record that the moment has come. Idempotent, and one-way for the page's life.
 *
 * One-way on purpose: the card does not appear and vanish as a turn finishes.
 * Once the question is fair to ask it stays fair, and the person answers it when
 * they get to it.
 */
export function armPermissionPrimer(): void {
  if (armed) return;
  armed = true;
  for (const listener of listeners) listener();
}

/** @internal Exported for testing only — puts the latch back down. */
export function resetPermissionPrimerForTests(): void {
  armed = false;
  for (const listener of listeners) listener();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function getSnapshot(): boolean {
  return armed;
}

/** Whether something has happened that makes asking for permission fair. */
export function usePermissionPrimerArmed(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
