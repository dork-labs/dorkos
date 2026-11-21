/**
 * What DorkOS tells the person when an extension that runs separately stops on
 * its own (DOR-4785): it stopped responding and the watchdog ended it, it
 * crashed, or it ran out of memory. Before this, only its card in Settings said
 * so, and a mini app could stop for good with nobody told.
 *
 * Two rows at most per stretch of trouble, never one per stop:
 *
 * - While DorkOS restarts it on its own, one `quiet` row per app an hour
 *   ("The People app stopped responding. DorkOS is restarting it."). A second or third stop
 *   inside the hour is the same news and is deduped.
 * - When the restart budget runs out (`RestartPolicy`), one `notable` row that
 *   says it is off and offers Restart, which does what the card's reload does:
 *   a fresh crash budget and a fresh start (`POST /api/extensions/:id/restart`).
 *
 * The rows are events, not a standing condition: a standing kind rides the
 * escalation ladder to a phone, and nothing here is worth a push. Rows are never
 * rewritten once stored, so "updates in place" is these two rows under one
 * subject rather than one row that changes.
 *
 * The emitter is `tell-extension-stopped.ts`, called from
 * `ExtensionServerLifecycle.onIsolatedExit`.
 *
 * @module services/extensions/isolation/notices/extension-stopped-notice
 */
import type { NotificationRegistryEntry } from '../../../notifications/notification-registry.js';

/** Why an isolated extension stopped without being asked to. */
export type ExtensionStopReason = 'server_crashed' | 'server_out_of_memory' | 'server_unresponsive';

/** The action id on the "is off" row. The Inbox draws it as Restart. */
const RESTART_EXTENSION_ACTION_ID = 'restart-extension';

/** The prefix of the subject id, `extension:<id>`, so the client can read the id back. */
const EXTENSION_SUBJECT_PREFIX = 'extension:';

/**
 * How long one "restarted" row stands for every later stop of the same app: an
 * hour. Long enough that a hang every few minutes is one row, short enough that
 * trouble tomorrow is told again. The "is off" row names its own stop in its
 * key, so this window never hides one.
 */
const EXTENSION_STOPPED_DEDUPE_MS = 60 * 60 * 1000;

/** The payload of the one kind, joined into `NotificationPayloads`. */
export interface ExtensionStoppedPayloads {
  /** An extension that runs separately stopped on its own. */
  'extension.stopped': {
    /** The extension id. */
    extensionId: string;
    /** Its manifest name, e.g. "People". */
    name: string;
    /** Why it stopped this time. */
    reason: ExtensionStopReason;
    /** `restarting`: DorkOS will start it again. `off`: it stopped too often, so it stays off. */
    state: 'restarting' | 'off';
    /** When it stopped, ISO 8601. Names an `off` row's episode. */
    stoppedAt: string;
    /** `off` only: how many stops ended the restarts. */
    stops?: number;
    /** `off` only: the window those stops fell in, in minutes. */
    windowMinutes?: number;
  };
}

/** The payload of `extension.stopped`. */
type ExtensionStoppedPayload = ExtensionStoppedPayloads['extension.stopped'];

/**
 * The app as a sentence names it: "The People app". Apps carry names like
 * People and Notes, so the bare name would read as if humans stopped
 * responding (the designer, DOR-4785). A name that already ends in "app" is
 * not doubled.
 *
 * @param name - The manifest name.
 */
function theApp(name: string): string {
  return /\bapp$/i.test(name) ? `The ${name}` : `The ${name} app`;
}

/** The restarted title per reason. */
const RESTARTING: Record<ExtensionStopReason, (name: string) => string> = {
  server_unresponsive: (name) => `${theApp(name)} stopped responding. DorkOS is restarting it.`,
  server_crashed: (name) => `${theApp(name)} stopped unexpectedly. DorkOS is restarting it.`,
  server_out_of_memory: (name) => `${theApp(name)} ran out of memory. DorkOS is restarting it.`,
};

/**
 * The "is off" body, at most 15 words: how often it stopped, and that it
 * stays off. The reason was told on the rows before it.
 *
 * @param p - The payload.
 */
function offBody(p: ExtensionStoppedPayload): string {
  const stops = p.stops ?? 3;
  const minutes = Math.max(1, p.windowMinutes ?? 10);
  const count = stops === 1 ? 'once' : `${stops} times`;
  const span = minutes === 1 ? '1 minute' : `${minutes} minutes`;
  return `It stopped ${count} in ${span}, so DorkOS left it off.`;
}

/** The entry, spread into the registry's `ENTRIES`. */
export const EXTENSION_STOPPED_ENTRIES: {
  'extension.stopped': NotificationRegistryEntry<'extension.stopped'>;
} = {
  'extension.stopped': {
    kind: 'extension.stopped',
    // Restarted: history only. Off: it badges the bell, since only a person
    // brings it back. Neither reaches a phone: events never ride the
    // escalation ladder, and `relay` is `never`. Every row opens Settings →
    // Extensions, so none is without a way back; only the "is off" row has a
    // Restart button, since "DorkOS restarted it" beside Restart reads as a
    // contradiction (the designer, DOR-4785).
    tier: (p) => (p.state === 'off' ? 'notable' : 'quiet'),
    storage: 'event',
    subjectType: 'system',
    locate: (p) => ({ subjectId: `${EXTENSION_SUBJECT_PREFIX}${p.extensionId}` }),
    title: (p) => (p.state === 'off' ? `${theApp(p.name)} is off` : RESTARTING[p.reason](p.name)),
    body: (p) => (p.state === 'off' ? offBody(p) : undefined),
    actions: (p) =>
      p.state === 'off'
        ? [{ id: RESTART_EXTENSION_ACTION_ID, label: 'Restart', style: 'primary' }]
        : [],
    // One "restarted" row per app per window; one "is off" row per time it gave up.
    dedupeKey: (p) =>
      p.state === 'off'
        ? `extension-stopped:${p.extensionId}:off:${p.stoppedAt}`
        : `extension-stopped:${p.extensionId}:restarting`,
    dedupeWindowMs: EXTENSION_STOPPED_DEDUPE_MS,
    relay: 'never',
  },
};
