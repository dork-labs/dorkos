/**
 * How a heartbeat reads in words (spec `heartbeats` §14): the page's wake
 * sentence, the next check, and what a broken HEARTBEAT.md header needs.
 */
import { describe, expect, it } from 'vitest';
import {
  arrivesWords,
  fileProblemWords,
  heldRecipientNames,
  nextCheckWords,
  wakeSentence,
} from '../lib/heartbeat-words';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';

const NOW = new Date('2026-10-12T10:00:00');

describe('wakeSentence', () => {
  const base = { enabled: true, skippedReason: null } as const;

  it('says each mode in the spec’s words', () => {
    expect(wakeSentence({ ...base, wake: 'timed' })).toBe(
      'Wakes every 30 minutes in working hours.'
    );
    expect(wakeSentence({ ...base, wake: 'events' })).toBe('Wakes when something happens.');
    expect(wakeSentence({ ...base, wake: 'off', skippedReason: 'Heartbeat off.' })).toBe(
      'Heartbeat off.'
    );
  });

  it('puts the space switch first, then says in its own words why it does not run here', () => {
    expect(wakeSentence({ ...base, enabled: false, wake: 'timed' })).toBe(
      'Heartbeats are off for everyone.'
    );
    const elsewhere = 'Runs on "cursor", which DorkOS does not run here.';
    expect(wakeSentence({ ...base, wake: 'timed', skippedReason: elsewhere })).toBe(
      'Doesn’t wake here: its runtime isn’t on this computer.'
    );
  });
});

describe('nextCheckWords', () => {
  it('counts minutes inside the hour and names a clock time past it', () => {
    expect(nextCheckWords(null, NOW)).toBeNull();
    expect(nextCheckWords('2026-10-12T10:12:00', NOW)).toBe('Next check in 12 min');
    expect(nextCheckWords('2026-10-12T10:00:30', NOW)).toBe('Next check any moment');
    expect(nextCheckWords('2026-10-12T12:00:00', NOW)).toMatch(/^Next check at 12:00/);
  });
});

describe('arrivesWords', () => {
  it('says today’s time, a weekday within the week, else a date', () => {
    // Built from the same locale calls the code makes, so the test holds in
    // any locale and any 12- or 24-hour setting.
    const time = (iso: string) =>
      new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const later = new Date('2026-10-13T09:00:00');
    const far = new Date('2026-10-30T09:00:00');
    expect(arrivesWords('2026-10-12T17:00:00', NOW)).toBe(`Arrives ${time('2026-10-12T17:00:00')}`);
    expect(arrivesWords(later.toISOString(), NOW)).toBe(
      `Arrives ${later.toLocaleDateString(undefined, { weekday: 'short' })} ${time(later.toISOString())}`
    );
    expect(arrivesWords(far.toISOString(), NOW)).toBe(
      `Arrives ${far.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
    );
  });
});

describe('fileProblemWords', () => {
  it('turns each field’s reason into the change to make', () => {
    expect(fileProblemWords("wake: Invalid enum value. Expected 'timed'")).toBe(
      'Set wake to timed, events or off.'
    );
    expect(fileProblemWords('report: Invalid enum value.')).toBe(
      'Set report to daily, weekly or off.'
    );
    expect(fileProblemWords('watch.0: Invalid enum value.')).toMatch(/^Watch lists /);
    expect(fileProblemWords('sweep: A sweep runs at most every 30 minutes.')).toBe(
      'A sweep runs at most every 30 minutes.'
    );
    // Anything else the parser says about sweep is its jargon, not a sentence.
    expect(fileProblemWords('sweep: Expected string, received number')).toBe(
      'Set sweep like "4h" or "1h30m".'
    );
    expect(fileProblemWords('end of the stream or a document separator is expected')).toBe(
      'Check the lines between the two --- marks.'
    );
  });
});

describe('heldRecipientNames', () => {
  const [ownerRow, ...rest] = MOCK_TEAM_ROSTER;
  const withViewer = (isViewer: boolean): TeamMember[] => [
    { ...ownerRow!, person: { ...ownerRow!.person!, accountId: 'acct-owner', isViewer } },
    ...rest,
  ];

  it('reads the install owner’s aliases as you when the owner is reading', () => {
    const nameOf = heldRecipientNames(withViewer(true));
    expect(nameOf('owner')).toBe('you');
    expect(nameOf('install:abc')).toBe('you');
    expect(nameOf('acct-owner')).toBe('you');
    expect(nameOf('acct-nobody')).toBe('someone');
  });

  it('names the install owner, not the viewer, when someone else is reading', () => {
    const nameOf = heldRecipientNames(withViewer(false));
    expect(nameOf('owner')).toBe(ownerRow!.displayName);
    expect(nameOf('install:abc')).toBe(ownerRow!.displayName);
  });
});
