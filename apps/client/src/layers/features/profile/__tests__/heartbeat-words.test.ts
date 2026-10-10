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
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';

const NOW = new Date('2026-10-12T10:00:00');

describe('wakeSentence', () => {
  const base = { enabled: true, skippedReason: null } as const;

  it('says each mode in the spec’s words', () => {
    expect(wakeSentence({ ...base, wake: 'timed' })).toBe('Wakes every 30 minutes in your hours.');
    expect(wakeSentence({ ...base, wake: 'events' })).toBe('Wakes when something happens.');
    expect(wakeSentence({ ...base, wake: 'off', skippedReason: 'Heartbeat off.' })).toBe(
      'Heartbeat off.'
    );
  });

  it('puts the space switch first, then the server’s own reason', () => {
    expect(wakeSentence({ ...base, enabled: false, wake: 'timed' })).toBe(
      'Heartbeats are off for everyone.'
    );
    const elsewhere = 'Runs on "cursor", which DorkOS does not run here.';
    expect(wakeSentence({ ...base, wake: 'timed', skippedReason: elsewhere })).toBe(elsewhere);
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
    expect(arrivesWords('2026-10-12T17:00:00', NOW)).toMatch(/^Arrives 5:00/);
    expect(arrivesWords('2026-10-13T09:00:00', NOW)).toMatch(/^Arrives Tue 9:00/);
    expect(arrivesWords('2026-10-30T09:00:00', NOW)).toBe('Arrives Oct 30');
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
    expect(fileProblemWords('end of the stream or a document separator is expected')).toBe(
      'Check the lines between the two --- marks.'
    );
  });
});

describe('heldRecipientNames', () => {
  it('reads the owner’s aliases as you, and an unknown account as someone', () => {
    const nameOf = heldRecipientNames(MOCK_TEAM_ROSTER);
    expect(nameOf('owner')).toBe('you');
    expect(nameOf('install:abc')).toBe('you');
    expect(nameOf('acct-nobody')).toBe('someone');
  });
});
