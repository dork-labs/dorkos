/**
 * The Settings tab's words and grouping, worked out from what a space sent (DOR-3005).
 */
import { describe, expect, it } from 'vitest';
import {
  admissionLabel,
  availabilityLabel,
  groupPeople,
  headcount,
  initialsOf,
  personDetail,
  sinceLabel,
} from '../lib/space-view';

const person = (id: string, handle: string) => ({
  memberId: id,
  kind: 'human' as const,
  displayName: handle,
  handle,
  role: 'member' as const,
  ownerMemberId: null,
});
const agent = (id: string, owner: string) => ({
  memberId: id,
  kind: 'agent' as const,
  displayName: id,
  handle: id,
  role: null,
  ownerMemberId: owner,
});

describe('groupPeople', () => {
  it('puts each agent under its owner and drops one whose owner is not on the page', () => {
    // Purpose: fails if an agent shows alone, or under the wrong person.
    const people = groupPeople({
      members: [person('p1', 'alex'), person('p2', 'maya')],
      agents: [agent('a1', 'p1'), agent('a2', 'p1'), agent('a3', 'gone')],
      nextCursor: null,
    });
    expect(people.map((row) => row.agents.map((a) => a.memberId))).toEqual([['a1', 'a2'], []]);
    expect(headcount(people, true)).toBe('2 people · 2 agents');
    expect(headcount(people, false)).toBe('2 people');
    // A space with more people than were read is never counted as if it had only these.
    expect(headcount(people, true, true)).toBe('First 2 people · 2 agents');
    expect(personDetail(people[0]!)).toBe('@alex · 2 agents');
    expect(personDetail(people[1]!)).toBe('@maya');
  });
});

describe('words', () => {
  it('says who can join plainly', () => {
    expect(admissionLabel('invite_only')).toBe('Invite only');
    expect(admissionLabel('closed')).toBe('Closed');
    expect(admissionLabel('open')).toBe('Anyone who signs in');
  });

  it('says an agent is available, away since a time, or nothing when no app said', () => {
    expect(availabilityLabel({ ...agent('a', 'p'), availability: 'available' })).toBe('Available');
    expect(
      availabilityLabel(
        { ...agent('a', 'p'), availability: 'offline', lastSeenAt: '2026-10-20T09:40:00Z' },
        'en-US'
      )
    ).toMatch(/^Away since \d{1,2}:40/);
    expect(availabilityLabel({ ...agent('a', 'p'), availability: 'unknown' })).toBeNull();
  });

  it('says how long ago the space last answered', () => {
    const now = new Date('2026-10-20T10:00:00Z');
    expect(sinceLabel('2026-10-20T10:00:20Z', now)).toBe('just now');
    expect(sinceLabel('2026-10-20T09:59:00Z', now)).toBe('1 minute ago');
    expect(sinceLabel('2026-10-20T08:00:00Z', now)).toBe('2 hours ago');
    expect(sinceLabel('2026-10-17T10:00:00Z', now)).toBe('3 days ago');
  });

  it('makes initials from a name', () => {
    expect(initialsOf('Alex Kim')).toBe('AK');
    expect(initialsOf('priya')).toBe('P');
    expect(initialsOf('  ')).toBe('?');
  });
});
