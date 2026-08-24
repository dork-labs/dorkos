/**
 * The row table, checked against the spec table (`profile-unification` §1.4).
 *
 * This file is the contract: what an operator may act on, what they may only
 * read, and what stays visible but locked. Each `describe` below is one row of
 * that table, in its order.
 */
import { describe, it, expect } from 'vitest';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';
import { rowsFor, type ProfileRowGroup, type ProfileRowsContext } from '../lib/profile-rows';
import { deriveRelationship } from '../lib/profile-relationship';

const byId = (id: string): TeamMember => MOCK_TEAM_ROSTER.find((member) => member.id === id)!;

const SELF = byId('person-dorian');
const BRIDGED = byId('person-miguel');
const MANAGED = byId('agent-warden');
const DORKBOT = byId('agent-dorkbot');

/** A second local person, which the shared roster has none of. */
const PRIYA: TeamMember = {
  id: 'person-priya',
  kind: 'human',
  displayName: 'Priya',
  handle: 'priya',
  isSelf: false,
  ownerId: null,
  origin: 'local',
  person: { role: 'Staff architect', lastSeenAt: null },
};

/** Someone else's agent: the cartographer, re-homed onto Priya. */
const OTHERS_AGENT: TeamMember = { ...byId('agent-cartographer'), ownerId: PRIYA.id };

const ROSTER = [...MOCK_TEAM_ROSTER, PRIYA, OTHERS_AGENT];

/** Build the context the way `ProfileView` does, so the test cannot drift from it. */
function build(member: TeamMember, over: Partial<ProfileRowsContext> = {}): ProfileRowGroup[] {
  return rowsFor(member, {
    relationship: deriveRelationship(member, ROSTER),
    manages: ROSTER.filter((row) => row.kind === 'agent' && row.ownerId === member.id),
    ...over,
  });
}

/** Every row of every group, flattened, in reading order. */
function flat(groups: ProfileRowGroup[]) {
  return groups.flatMap((group) => group.rows);
}

/** The `label → kind` shape the spec table states. */
function shape(groups: ProfileRowGroup[]): string[] {
  return flat(groups).map((row) => `${row.label} ${row.kind}`);
}

describe('you', () => {
  it('draws your four fields, then what you belong to', () => {
    expect(shape(build(SELF))).toEqual([
      'Name nav',
      'Handle nav',
      'Photo nav',
      'Email locked',
      'Manages nav',
      'Rooms nav',
    ]);
  });

  it('keeps your email visible and unopenable, with the reason attached', () => {
    const email = flat(build(SELF)).find((row) => row.id === 'email')!;
    expect(email.value).toBe('dorian@dorkos.ai');
    expect(email.lockedReason).toContain('Settings');
  });

  it('says what is missing rather than leaving a blank', () => {
    const bare = flat(build({ ...SELF, handle: null }));
    expect(bare.find((row) => row.id === 'handle')!.value).toBe('Add a handle');
    expect(bare.find((row) => row.id === 'photo')!.value).toBe('Add a photo');
  });

  it('counts the agents you manage, and carries their faces', () => {
    const manages = flat(build(SELF)).find((row) => row.id === 'manages')!;
    // Warden and Scout on the shared roster; the cartographer is Priya's here.
    expect(manages.value).toBe('2 agents');
    expect(manages.faces?.map((face) => face.id)).toEqual(['agent-warden', 'agent-scout']);
  });

  it('has no Sessions row — the sidebar owns your sessions', () => {
    expect(shape(build(SELF)).join(' ')).not.toContain('Sessions');
  });
});

describe('another person', () => {
  it('shows a declared role, what they manage, and where they are', () => {
    expect(shape(build(PRIYA))).toEqual(['Role text', 'Manages nav', 'Rooms nav']);
  });

  it('leaves the role out entirely rather than guessing at one', () => {
    const roleless: TeamMember = { ...PRIYA, person: { role: null, lastSeenAt: null } };
    expect(shape(build(roleless))).toEqual(['Manages nav', 'Rooms nav']);
  });

  it('offers nothing to edit — none of it is yours', () => {
    expect(flat(build(PRIYA)).every((row) => row.kind !== 'pick' && row.kind !== 'locked')).toBe(
      true
    );
  });
});

describe('someone bridged in', () => {
  it('shows the rooms you share, and nothing else it cannot know', () => {
    expect(shape(build(BRIDGED))).toEqual(['Rooms nav']);
  });

  it('adds First seen only when something actually knows the date', () => {
    const seen = build(BRIDGED, { firstSeenAt: '2026-08-03T10:00:00.000Z' });
    expect(shape(seen)).toEqual(['Rooms nav', 'First seen text']);
    expect(flat(seen).find((row) => row.id === 'first-seen')!.value).toBe('Aug 3, 2026');
  });
});

describe('an agent you manage', () => {
  const WITH_FOLDER: TeamMember = {
    ...MANAGED,
    agent: { ...MANAGED.agent!, projectPath: '/Users/dorian/code/dorkos' },
  };

  it('draws setup, then work, then the toolkit — in three groups', () => {
    const groups = build(WITH_FOLDER);
    expect(groups.map((group) => group.id)).toEqual(['setup', 'work', 'toolkit']);
    expect(shape(groups)).toEqual([
      'About nav',
      'Runs on pick',
      'Personality pick',
      'Folder copy',
      'Sessions nav',
      'Schedules nav',
      'Rooms nav',
      'Notifications nav',
      'Skills nav',
      'Tools & MCP nav',
      'Connections nav',
      'Instructions nav',
      'Boundaries nav',
    ]);
  });

  it('copies the real path while showing the short one', () => {
    const folder = flat(build(WITH_FOLDER)).find((row) => row.id === 'folder')!;
    expect(folder.value).toBe('~/code/dorkos');
    expect(folder.copyValue).toBe('/Users/dorian/code/dorkos');
  });

  it('drops the Folder row when the roster does not know where the agent lives', () => {
    // The roster fills `projectPath` for every agent on this machine, so the
    // pathless case is a member whose truth is remote — and a Folder row with
    // nothing to copy is a control wired to nothing.
    const { projectPath: _remote, ...unplaced } = MANAGED.agent!;
    expect(shape(build({ ...MANAGED, agent: unplaced }))).not.toContain('Folder copy');
  });

  it('says how it runs in the row itself', () => {
    expect(flat(build(MANAGED)).find((row) => row.id === 'runs-on')!.value).toBe(
      'Claude Code · opus-4.8'
    );
  });
});

describe('someone else’s agent', () => {
  it('shows only what a teammate should see, and none of it as a control', () => {
    expect(shape(build(OTHERS_AGENT))).toEqual(['About text', 'Runs on text', 'Rooms nav']);
  });

  it('shows no lock icons — private is not the same as locked', () => {
    expect(flat(build(OTHERS_AGENT)).some((row) => row.kind === 'locked')).toBe(false);
  });
});

describe('DorkBot', () => {
  it('keeps its identity rows visible, locked, and explained', () => {
    expect(shape(build(DORKBOT))).toEqual([
      'About locked',
      'Runs on pick',
      'Personality pick',
      'Sessions nav',
      'Schedules nav',
      'Rooms nav',
      'Notifications nav',
      'Skills nav',
      'Tools & MCP nav',
    ]);
    // ONE locked row, not two. What is fixed about DorkBot is who it is — its
    // name, its face, its description — and the reason has to say exactly that,
    // or it goes stale the next time something is unlocked.
    const locked = flat(build(DORKBOT)).filter((row) => row.kind === 'locked');
    expect(locked).toHaveLength(1);
    expect(locked[0]!.lockedReason).toBe(
      'DorkBot’s name, face and description are part of DorkOS.'
    );
  });

  it('still lets you set the model — it runs on your machine', () => {
    expect(flat(build(DORKBOT)).find((row) => row.id === 'runs-on')!.kind).toBe('pick');
  });

  it('lets you change its voice — onboarding already asked you to pick one', () => {
    // The first-run beat writes DorkBot's traits and tells you it can change,
    // and `SYSTEM_PROTECTED_FIELDS` on the server never covered `traits`. A
    // locked row here made the profile the only thing refusing (DOR-1255).
    const personality = flat(build(DORKBOT)).find((row) => row.id === 'personality')!;
    expect(personality.kind).toBe('pick');
    expect(personality.pick).toBe('personality');
    expect(personality.lockedReason).toBeUndefined();
  });

  it('offers no Connections, Instructions or Boundaries', () => {
    const labels = shape(build(DORKBOT)).join(' ');
    expect(labels).not.toContain('Connections');
    expect(labels).not.toContain('Instructions');
    expect(labels).not.toContain('Boundaries');
  });
});

describe('rooms, wherever they appear', () => {
  /** The Rooms row's value for a given room list. */
  const roomsValue = (rooms: { name: string; slug: string | null; kind: 'channel' | 'dm' }[]) =>
    flat(build(SELF, { rooms: { count: rooms.length, rooms } })).find((row) => row.id === 'rooms')!
      .value;

  const channel = (slug: string) => ({ name: slug, slug, kind: 'channel' as const });

  it('names the first two and counts the rest', () => {
    expect(roomsValue(['team', 'general', 'ops', 'design'].map(channel))).toBe(
      '#team, #general, +2'
    );
  });

  it('writes a channel as its slug, not as its stored title', () => {
    // The row shares `roomDisplayTitle` with the rest of the cockpit rather
    // than prefixing a `#` onto whatever string it was handed — which is what
    // made a channel titled "Team Standup" read as `#Team Standup` here and
    // `#standup` in the sidebar beside it.
    expect(roomsValue([{ name: 'Team Standup', slug: 'standup', kind: 'channel' }])).toBe(
      '#standup'
    );
  });

  it('leaves a DM its plain name — it has no # address to wear', () => {
    expect(roomsValue([{ name: 'dopel', slug: null, kind: 'dm' }, channel('team')])).toBe(
      'dopel, #team'
    );
  });

  it('says nothing at all rather than "0" while nobody has read them', () => {
    expect(flat(build(SELF)).find((row) => row.id === 'rooms')!.value).toBeNull();
  });
});
