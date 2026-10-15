/**
 * How an agent's heartbeat reads, in words (spec `heartbeats` §7.6, §14): how
 * it wakes, when it next checks in, how each check ended, and what a broken
 * `HEARTBEAT.md` header needs.
 *
 * Pure, so the row and the page say the same thing and a test can pin it.
 *
 * @module features/profile/lib/heartbeat-words
 */
import type { BeatKind, BeatOutcome, HeartbeatStatus } from '@dorkos/shared/heartbeat-schemas';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import type { StatusTone } from '@/layers/shared/ui';
import { findTeamOwner } from '@/layers/entities/team';

/** The fields of the status that decide how an agent wakes. */
type WakeFacts = Pick<HeartbeatStatus, 'enabled' | 'wake' | 'skippedReason'>;

/**
 * Whether the server runs this agent's beats at all, setting aside its own
 * `wake: off`. False when the space switch is off or its runtime is not one
 * this server runs. The server's `skippedReason` names which, but in its own
 * words, so the page writes its own sentence rather than showing it.
 */
function beatsHere(status: WakeFacts): boolean {
  return status.enabled && (status.skippedReason === null || status.wake === 'off');
}

/**
 * How the agent wakes, as the page's sentence.
 *
 * @param status - The agent's heartbeat status.
 */
export function wakeSentence(status: WakeFacts): string {
  if (!status.enabled) return 'Heartbeats are off for everyone.';
  if (!beatsHere(status)) return 'Doesn’t wake here: its runtime isn’t on this computer.';
  switch (status.wake) {
    case 'timed':
      return 'Wakes every 30 minutes in working hours.';
    case 'events':
      return 'Wakes when something happens.';
    case 'off':
      return 'Heartbeat off.';
  }
}

/**
 * How the agent wakes, in the few words a profile row's value can carry.
 *
 * @param status - The agent's heartbeat status.
 */
export function wakeRowValue(status: WakeFacts): string {
  if (!status.enabled) return 'Off for everyone';
  if (!beatsHere(status)) return 'Doesn’t run here';
  switch (status.wake) {
    case 'timed':
      return 'Every 30 min in working hours';
    case 'events':
      return 'When something happens';
    case 'off':
      return 'Off';
  }
}

/** Minutes until `iso`, rounded up, or null when it is not a date. */
function minutesUntil(iso: string, now: Date): number | null {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return null;
  return Math.ceil((at - now.getTime()) / 60_000);
}

/** A clock time in the viewer's own 12- or 24-hour setting. */
function clock(when: Date): string {
  return when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * When the next timed check is, as a status line: "Next check in 12 min",
 * "Next check at 9:00 AM", or null when none is scheduled.
 *
 * @param iso - `nextBeatAt`, or null.
 * @param now - The moment to read it from.
 */
export function nextCheckWords(iso: string | null, now: Date = new Date()): string | null {
  if (!iso) return null;
  const minutes = minutesUntil(iso, now);
  if (minutes === null) return null;
  if (minutes <= 1) return 'Next check any moment';
  if (minutes < 60) return `Next check in ${minutes} min`;
  return `Next check at ${clock(new Date(iso))}`;
}

/**
 * The next check, in a row's trailing meta: "next in 12 min", "next at 9:00 AM",
 * "next any moment".
 *
 * @param iso - `nextBeatAt`, or null.
 * @param now - The moment to read it from.
 */
export function nextCheckMeta(iso: string | null, now: Date = new Date()): string | undefined {
  if (!iso) return undefined;
  const minutes = minutesUntil(iso, now);
  if (minutes === null) return undefined;
  if (minutes <= 1) return 'next any moment';
  if (minutes < 60) return `next in ${minutes} min`;
  return `next at ${clock(new Date(iso))}`;
}

/** What each kind of beat is called on the page. */
export const BEAT_KIND_LABEL: Record<BeatKind, string> = {
  pulse: 'Check',
  sweep: 'Look around',
  report: 'Report',
};

/** How each beat outcome reads as a badge, and the tone it wears. */
export const BEAT_OUTCOME_BADGE: Record<BeatOutcome, { label: string; tone: StatusTone }> = {
  quiet: { label: 'Quiet', tone: 'neutral' },
  queued: { label: 'Queued', tone: 'info' },
  worked: { label: 'Worked', tone: 'success' },
  'no-end-beat': { label: 'No end', tone: 'warning' },
  refused: { label: 'Refused', tone: 'warning' },
  failed: { label: 'Didn’t finish', tone: 'error' },
  skipped: { label: 'Skipped', tone: 'neutral' },
};

/**
 * When a held message will arrive: "Arrives 9:00 AM" today, "Arrives Mon 9:00
 * AM" within a week, else "Arrives Oct 20".
 *
 * @param iso - The raise's `deliverAfter`.
 * @param now - The moment to read it from.
 */
export function arrivesWords(iso: string, now: Date = new Date()): string | null {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  if (when.getTime() <= now.getTime()) return 'Arrives any moment';
  if (when.toDateString() === now.toDateString()) return `Arrives ${clock(when)}`;
  if (when.getTime() - now.getTime() < 6 * 86_400_000) {
    return `Arrives ${when.toLocaleDateString(undefined, { weekday: 'short' })} ${clock(when)}`;
  }
  return `Arrives ${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

/**
 * The sweep messages the schema writes as plain sentences already
 * (`SweepSchema` in `@dorkos/shared/heartbeat-schemas`). Anything else the
 * parser says about `sweep` is its own jargon, and gets the generic line.
 */
const PLAIN_SWEEP_MESSAGES: ReadonlySet<string> = new Set([
  'Use hours and minutes, like "4h" or "1h30m".',
  'A sweep runs at most every 30 minutes.',
]);

/**
 * What a person should change, given the parser's reason the header of
 * `HEARTBEAT.md` does not read (`fileError`, `field: message`).
 *
 * @param error - The server's reason.
 */
export function fileProblemWords(error: string): string {
  const field = /^([a-z]+)[.:]/.exec(error)?.[1];
  switch (field) {
    case 'wake':
      return 'Set wake to timed, events or off.';
    case 'report':
      return 'Set report to daily, weekly or off.';
    case 'watch':
      return 'Watch lists addressed, commitments, schedules, health or workspace.';
    case 'sweep': {
      const message = error.slice('sweep: '.length);
      return PLAIN_SWEEP_MESSAGES.has(message) ? message : 'Set sweep like "4h" or "1h30m".';
    }
    case 'name':
    case 'description':
      return 'Keep name and description short.';
    default:
      return 'Check the lines between the two --- marks.';
  }
}

/** The account ids the server also reads as the install owner (`reports-to.ts`). */
function isOwnerAlias(id: string): boolean {
  return id === 'owner' || id.startsWith('install:');
}

/**
 * A lookup from the account id a held message is addressed to, to a name: "you"
 * when that person is the one reading, a roster name otherwise, "someone" when
 * the roster cannot say. Only people are listed; the server leaves raises to
 * agents out.
 *
 * The `owner` and `install:<id>` aliases name the install's owner, not the
 * viewer: the owner's row is the one `isSelf` marks, and it says "you" only
 * when `isViewer` says the owner is the one reading.
 *
 * @param roster - The team roster.
 * @param agent - The agent whose heartbeat this is, to fall back on its owner
 *   when the roster marks no owner row.
 */
export function heldRecipientNames(
  roster: readonly TeamMember[],
  agent?: TeamMember
): (accountId: string) => string {
  const owner =
    roster.find((member) => member.isSelf && member.kind !== 'agent') ??
    (agent ? findTeamOwner(agent, [...roster]) : undefined);
  return (accountId) => {
    const member = isOwnerAlias(accountId)
      ? owner
      : roster.find((candidate) => candidate.person?.accountId === accountId);
    if (!member) return 'someone';
    return member.person?.isViewer === true ? 'you' : member.displayName;
  };
}
