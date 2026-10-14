/**
 * The words for what is keeping this computer awake, shared by every surface
 * that says it (the top-bar cup, the Control Center line, Settings) so they can
 * never disagree.
 *
 * @module entities/keep-awake/lib/keep-awake-copy
 */
import type { KeepAwakeStatus, KeepAwakeUnsupportedReason } from '@dorkos/shared/schemas';

/** Where the Sleep settings live: `?settings=tools&settingsSection=sleep`. */
export const SLEEP_SETTINGS = { tab: 'tools', section: 'sleep' } as const;

/** One kind of work and how it is counted aloud. */
const KINDS = [
  ['chats', 'chat', 'chats'],
  ['rooms', 'room', 'rooms'],
  ['tasks', 'task', 'tasks'],
] as const;

/**
 * What the computer is awake for, in a few words: "2 chats running" for one
 * kind of work, "1 chat, 1 room, 1 task" for a mix. Kinds with nothing running
 * are left out. Null when nothing is running.
 *
 * @param working - The status's `working` counts.
 */
export function describeKeepAwakeWork(working: KeepAwakeStatus['working']): string | null {
  const parts = KINDS.filter(([key]) => working[key] > 0).map(
    ([key, one, many]) => `${working[key]} ${working[key] === 1 ? one : many}`
  );
  if (parts.length === 0) return null;
  return parts.length === 1 ? `${parts[0]} running` : parts.join(', ');
}

/**
 * Whether DorkOS is holding the computer awake for work right now. False while
 * it only lingers after the last piece of work ended: nothing is left to name.
 *
 * @param status - The keep-awake status, when it has loaded.
 */
export function isKeepingAwake(status: KeepAwakeStatus | undefined): status is KeepAwakeStatus {
  return status?.asserted === true && describeKeepAwakeWork(status.working) !== null;
}

/**
 * The one line Settings shows when this computer cannot be held awake. A
 * `denied` refusal is the one that passes: the server tries again on its own.
 */
export const UNSUPPORTED_COPY: Record<KeepAwakeUnsupportedReason, string> = {
  container: 'Not available in a container.',
  'tool-missing': 'Not available: this computer has no sleep control tool.',
  denied: 'This computer refused to stay awake. Trying again shortly.',
  platform: 'Not available on this operating system.',
};

/**
 * Whether the keep-awake switch can do anything here. A refusal is retried, and
 * switching off and on retries at once, so only what the environment rules out
 * (a container, no sleep tool, no adapter for this system) greys the switch.
 *
 * @param status - The keep-awake status.
 */
export function canSwitchKeepAwake(status: Pick<KeepAwakeStatus, 'supported' | 'reason'>): boolean {
  return status.supported || status.reason === 'denied';
}

/**
 * What keeping awake cannot do. Shown under the switch and in the cup, on every
 * platform, so it names only what holds everywhere: a closed lid sleeps most
 * laptops (a Mac stays up only on power with a display attached), and the
 * screen keeps its own timer.
 */
export const KEEP_AWAKE_CAVEAT =
  'Closing the lid usually still sleeps. The screen still turns off and locks.';
