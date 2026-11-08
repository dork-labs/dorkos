/**
 * What DorkOS tells the person when its check on agents' shell commands can't start (DOR-3300).
 * The emitter is `runtimes/claude-code/shell-guard/shell-guard-launch.ts`.
 *
 * `standing-recorded`, for the same two reasons as `signin.required`: nothing durable owns this
 * condition (the guard's host lives in memory, and a restart may be the fix), and past-tense words
 * stay true on a row read much later. It is `blocking` because the shell has stopped at Full and
 * only a person can end that, and being standing is what reaches the phone.
 *
 * The words carry what to do, on the phone too. They are the designer's and Security's. There is one
 * notice per server, so its second line follows the level of the command that found the check down.
 *
 * @module services/notifications/shell-check-notifications
 */
import type { NotificationRegistryEntry } from './notification-registry.js';

/** The payload of the one kind, joined into `NotificationPayloads`. */
export interface ShellCheckPayloads {
  /** The guard's process can't start. */
  'shell.check_down': {
    /** When it started failing, which keeps a second episode apart from the first. */
    since: string;
    /** Whether the command that found it down ran at Full, where the shell has stopped. */
    full: boolean;
    /** When a check worked again. Only on the row that closes the episode. */
    clearedAt?: string;
  };
}

/** The one entry, spread into the registry's `ENTRIES`. */
export const SHELL_CHECK_ENTRIES: {
  [K in keyof ShellCheckPayloads]: NotificationRegistryEntry<K>;
} = {
  'shell.check_down': {
    kind: 'shell.check_down',
    tier: 'blocking',
    storage: 'standing-recorded',
    subjectType: 'system',
    locate: () => ({ subjectId: 'shell-check' }),
    title: (p) =>
      p.clearedAt
        ? 'DorkOS can check shell commands for protected files again.'
        : 'DorkOS can’t check shell commands for protected files.',
    body: (p) => {
      if (p.clearedAt) return undefined;
      return p.full
        ? 'Shell commands are paused. Restart DorkOS.'
        : 'Commands that name setup files are refused, and others ask first. Restart DorkOS.';
    },
    dedupeKey: (p) => `shell-check:${p.since}`,
    // Zero for the reason `signin.required` has: the two rows share this key on purpose.
    dedupeWindowMs: 0,
    // The escalation ladder sends under its own policy while the condition stands.
    relay: 'never',
  },
};
