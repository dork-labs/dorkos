/**
 * Sample schedules for the approval card's showcases: made-up agents, made-up
 * paths, run times computed from page load. Split out of
 * `ScheduleApprovalShowcases.tsx` to keep it under the line limit.
 *
 * @module dev/showcases/schedule-approval-fixtures
 */
import type { Task } from '@dorkos/shared/types';

/**
 * Frozen at module load, not read per render: `Date.now()` during render is
 * impure (`react-hooks/purity`), and ages that shift every re-render are harder
 * to read anyway.
 */
const LOADED_AT = Date.now();

/** An ISO timestamp `minutes` either side of page load. */
export function minutesFromLoad(minutes: number): string {
  return new Date(LOADED_AT + minutes * 60_000).toISOString();
}

/** The offset of `zone` from UTC at `instant`, in minutes (e.g. -300 for GMT-5). */
function zoneOffsetMinutes(instant: number, zone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' })
    .formatToParts(new Date(instant))
    .find((part) => part.type === 'timeZoneName')?.value;
  const match = /GMT([+-]\d+)(?::(\d+))?/.exec(name ?? '');
  if (!match) return 0;
  const hours = Number(match[1]);
  return hours * 60 + Math.sign(hours) * Number(match[2] ?? 0);
}

/**
 * The next `count` weekday runs at `hour`:00 in `zone` after page load, so the
 * fixture's run times agree with its cron (`0 9 * * 1-5`, America/Chicago)
 * rather than with the moment the page happened to open.
 */
function weekdayRuns(count: number, hour: number, zone: string): string[] {
  const runs: string[] = [];
  for (let day = 0; runs.length < count && day < 21; day++) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        weekday: 'short',
      })
        .formatToParts(new Date(LOADED_AT + day * 86_400_000))
        .map((part) => [part.type, part.value])
    );
    if (parts.weekday === 'Sat' || parts.weekday === 'Sun') continue;
    const guess = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour);
    const at = guess - zoneOffsetMinutes(guess, zone) * 60_000;
    if (at > LOADED_AT) runs.push(new Date(at).toISOString());
  }
  return runs;
}

/**
 * A proposal carrying everything the server can send.
 *
 * @param overrides - The fields this particular state is about.
 */
export function proposal(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-standup',
    name: 'morning-standup',
    displayName: 'Morning standup digest',
    description: null,
    prompt:
      'Read every session that ran overnight and write a short digest of what changed,\n' +
      'what broke, and what is still waiting on a person. Post it to #team.\n' +
      'Keep it under 200 words and link every claim to the session that produced it.',
    cron: '0 9 * * 1-5',
    timezone: 'America/Chicago',
    defaultCron: '0 9 * * 1-5',
    defaultTimezone: 'America/Chicago',
    timingOverridden: false,
    packageOwned: null,
    approvalChanges: [],
    agentId: '/Users/dev/agents/dorkbot',
    enabled: false,
    sticky: false,
    maxRuntime: null,
    permissionMode: 'acceptEdits',
    runtime: null,
    model: null,
    effort: null,
    account: null,
    status: 'pending_approval',
    approvedAt: null,
    approvedBy: null,
    approvedVia: null,
    filePath: '/Users/dev/agents/dorkbot/.dork/tasks/morning-standup/SKILL.md',
    createdAt: minutesFromLoad(-26),
    updatedAt: minutesFromLoad(-26),
    reason:
      'Nobody reads the overnight runs, so failures sit unseen until Monday. A digest at 9am puts them in front of you while there is still a day to fix them.',
    proposedBySessionId: 'ses-42',
    proposedByAgentPath: '/Users/dev/agents/dorkbot',
    proposedByName: 'DorkBot',
    origin: null,
    reasonSource: null,
    nextRuns: weekdayRuns(3, 9, 'America/Chicago'),
    runsAsName: 'DorkBot',
    runPlace: { kind: 'agent', path: '/Users/dev/agents/dorkbot' },
    ...overrides,
  };
}
