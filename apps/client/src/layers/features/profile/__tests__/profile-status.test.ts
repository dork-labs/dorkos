/**
 * The one sentence under the name (spec `profile-unification` §1.2).
 *
 * The states are drawn from `design/05-states-final.html`: a live turn, a stamp
 * of when it last ran, never having run, and — for people — where they are.
 */
import { describe, it, expect } from 'vitest';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';
import { profileStatusText, type ProfileAgentActivity } from '../lib/profile-status';

const byId = (id: string): TeamMember => MOCK_TEAM_ROSTER.find((member) => member.id === id)!;

const NOW = new Date('2026-08-16T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

/**
 * Put an activity block on an agent.
 *
 * **Temporary.** `TeamAgentFacts.activity` is W1.1's field (DOR-1249); until it
 * lands the type does not carry it, so the fixture writes it through a cast —
 * the same seam `profile-status.ts` reads it back through. Both go when the
 * field lands.
 */
function withActivity(member: TeamMember, activity: ProfileAgentActivity): TeamMember {
  return { ...member, agent: { ...member.agent!, activity } as TeamMember['agent'] };
}

describe('an agent', () => {
  it('says what it is doing, where, and for how long', () => {
    const working = withActivity(byId('agent-warden'), {
      working: { roomId: 'r1', roomName: 'team', since: ago(2 * 60_000) },
      lastActiveAt: ago(2 * 60_000),
    });

    expect(profileStatusText(working, NOW)).toEqual({
      text: 'Working in #team · 2 min',
      live: true,
    });
  });

  it('still says it is working when nothing knows which room', () => {
    const working = withActivity(byId('agent-warden'), {
      working: { roomId: 'r1', roomName: null, since: ago(5 * 60_000) },
      lastActiveAt: null,
    });

    expect(profileStatusText(working, NOW).text).toBe('Working · 5 min');
  });

  it('falls back to when it was last heard from', () => {
    const idle = withActivity(byId('agent-scout'), {
      working: null,
      lastActiveAt: ago(3 * 3_600_000),
    });

    expect(profileStatusText(idle, NOW)).toEqual({ text: 'Last active 3 h ago', live: false });
  });

  it('says an agent that has never run has never run', () => {
    const never = withActivity(byId('agent-scout'), { working: null, lastActiveAt: null });

    expect(profileStatusText(never, NOW).text).toBe('Hasn’t run yet');
  });

  it('says the same thing when the roster serves no activity at all', () => {
    // The pre-W1.1 install. A guess dressed as a fact ("Active in the last
    // hour", from a 60-minute mesh window) is what this sentence replaced.
    expect(profileStatusText(byId('agent-warden'), NOW).text).toBe('Hasn’t run yet');
  });

  it('is live only while a turn is actually running', () => {
    const recent = withActivity(byId('agent-warden'), {
      working: null,
      lastActiveAt: ago(30_000),
    });

    expect(profileStatusText(recent, NOW).live).toBe(false);
  });
});

describe('a person', () => {
  it('puts you on this machine', () => {
    expect(profileStatusText(byId('person-dorian'), NOW)).toEqual({
      text: 'On this machine',
      live: false,
    });
  });

  it('puts somebody bridged in on their own platform', () => {
    expect(profileStatusText(byId('person-miguel'), NOW).text).toBe('On Telegram');
  });

  it('says when a teammate was last seen, once anything knows', () => {
    const priya: TeamMember = {
      id: 'person-priya',
      kind: 'human',
      displayName: 'Priya',
      handle: 'priya',
      isSelf: false,
      ownerId: null,
      origin: 'local',
      person: { role: null, lastSeenAt: ago(3 * 3_600_000) } as TeamMember['person'],
    };

    expect(profileStatusText(priya, NOW).text).toBe('Last seen 3 h ago');
  });
});

describe('how long ago, in words', () => {
  const stamp = (ms: number) =>
    profileStatusText(
      withActivity(byId('agent-scout'), { working: null, lastActiveAt: ago(ms) }),
      NOW
    ).text;

  it('reads at every scale it has to', () => {
    expect(stamp(10_000)).toBe('Last active just now');
    expect(stamp(20 * 60_000)).toBe('Last active 20 min ago');
    expect(stamp(3 * 3_600_000)).toBe('Last active 3 h ago');
    expect(stamp(30 * 3_600_000)).toBe('Last active yesterday');
    expect(stamp(4 * 24 * 3_600_000)).toBe('Last active 4 days ago');
    expect(stamp(60 * 24 * 3_600_000)).toContain('Last active on ');
  });
});
