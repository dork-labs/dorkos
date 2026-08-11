/**
 * One roster row → one disc, and the leak that made this a shared function.
 *
 * `resolveIdentityFace` was always shared; the ten lines that spread a
 * `TeamMember` into its input were not, and two of the five copies dropped
 * `imageUrl` on the way through. The result was a photo that appeared in
 * Settings, in the account menu and in the profile drawer, and NOT on the Team
 * page — the one surface the roster is named after.
 *
 * This file pins the helper. That the SURFACES render what it returns is pinned
 * in `features/team-roster/__tests__/TeamMemberCard.test.tsx`, which is where a
 * test may import a feature.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';
import { resolveAgentVisual } from '@/layers/shared/lib';
import { teamMemberFace } from '../lib/team-member-face';

const SELF = MOCK_TEAM_ROSTER.find((member) => member.isSelf)!;
const PHOTO = '/api/profile/avatar/person-dorian?v=abc123';

/** Every surface that draws a `TeamMember`'s disc, relative to `src/layers/`. */
const ROSTER_SURFACES = [
  'features/profile/ui/ProfileDrawer.tsx',
  'features/profile/ui/AccountMenu.tsx',
  'features/profile/ui/ProfilePanel.tsx',
  'features/team-roster/ui/TeamMemberCard.tsx',
  'features/team-roster/ui/TeamRosterGrid.tsx',
];

/** Read one surface's source. Paths, not imports — an entity may not import a feature. */
function sourceOf(relative: string): string {
  return readFileSync(join(__dirname, '../../..', relative), 'utf8');
}

describe('teamMemberFace', () => {
  it('carries the photo the roster cached', () => {
    expect(teamMemberFace({ ...SELF, imageUrl: PHOTO }).imageUrl).toBe(PHOTO);
  });

  it('leaves the photo absent rather than undefined-valued when there is none', () => {
    // Absence is how `resolveIdentityFace` tells "no cached photo" from a photo
    // it was handed as `undefined`, so a spread that always wrote the key would
    // defeat the fallback ladder rather than feed it.
    const face = teamMemberFace(SELF);
    expect(face.imageUrl).toBeUndefined();
    expect(face.fallback).toBe('D');
  });

  it('passes the kind through, so an agent still draws as an agent', () => {
    const agent = MOCK_TEAM_ROSTER.find((member) => member.kind === 'agent')!;
    expect(teamMemberFace(agent).kind).toBe('agent');
  });
});

describe('an agent on the roster always has a face (DOR-1122)', () => {
  const AGENT = MOCK_TEAM_ROSTER.find((member) => member.kind === 'agent')!;
  /** The same row with the icon it never chose. `member.id` is its manifest ULID. */
  const naked = (over: Partial<TeamMember> = {}): TeamMember => {
    const { emoji: _dropped, ...rest } = AGENT;
    return { ...rest, ...over };
  };

  it('draws the SAME emoji the sidebar draws for that agent', () => {
    // The load-bearing assertion, and the reason this rung lives here rather
    // than in `resolveIdentityFace`. It crosses the seam: the left side is the
    // roster's answer, the right side is what `resolveAgentVisual` — the
    // function the sidebar actually calls — answers for the same manifest id.
    // Red if either resolver's hash changes, or if this ever hashes a different
    // id than the sidebar does.
    expect(teamMemberFace(naked()).emoji).toBe(resolveAgentVisual({ id: AGENT.id }).emoji);
    expect(teamMemberFace(naked()).emoji).toBeDefined();
  });

  it('hashes a different face for a different agent', () => {
    // Keeps the assertion above from holding trivially: a hash answering one
    // emoji for everything would satisfy it and tell us nothing.
    const faces = ['agent-warden', 'agent-scout', 'agent-cartographer', 'agent-mesh'].map(
      (id) => teamMemberFace(naked({ id })).emoji
    );

    expect(new Set(faces).size).toBeGreaterThan(1);
  });

  it('treats an empty icon as no icon, not as a chosen one', () => {
    // `''` is not a face. It reaches the same letter `undefined` would, because
    // the record spread drops both — so a nullish check here would short-circuit
    // on `''` and defeat the invariant without failing anything. Nothing emits
    // an empty emoji today, which is precisely what would make it silent.
    expect(teamMemberFace(naked({ emoji: '' })).emoji).toBe(
      resolveAgentVisual({ id: AGENT.id }).emoji
    );
  });

  it("lets the agent's own icon beat the hash", () => {
    // A hash is the weakest source there is. Red if this is ever routed through
    // the `override` slot, which outranks a record's own emoji.
    expect(teamMemberFace({ ...AGENT, emoji: '🛡️' }).emoji).toBe('🛡️');
  });

  it('still resolves the letter, so nothing downstream loses one', () => {
    expect(teamMemberFace(naked()).fallback).toBe(AGENT.displayName[0]);
  });

  it('leaves a person with no emoji at all, and their letter', () => {
    // The carve-out's other half: an invented emoji beside somebody's name
    // claims a face nobody chose. Red if the rung is ever widened past agents.
    const person = MOCK_TEAM_ROSTER.find(
      (member) => member.kind === 'human' && member.emoji === undefined
    )!;
    const face = teamMemberFace(person);

    expect(face.emoji).toBeUndefined();
    expect(face.fallback).toBe(person.displayName[0]);
  });
});

describe('every roster surface goes through it', () => {
  // The unit tests above prove the helper is right. These prove it is USED —
  // which is the half that actually fixed the bug, because a sixth hand-rolled
  // spread would be correct on the day it was written and wrong on the day a
  // fifth cached field arrived.
  it.each(ROSTER_SURFACES)('%s calls teamMemberFace', (surface) => {
    expect(sourceOf(surface)).toContain('teamMemberFace(');
  });

  it.each(ROSTER_SURFACES)('%s builds no identity record of its own', (surface) => {
    // `resolveIdentityFace` is legitimate elsewhere — a room member row holds an
    // agent override no roster row has. What no roster surface may do again is
    // spread a `TeamMember` into it by hand.
    expect(sourceOf(surface)).not.toContain('resolveIdentityFace');
  });
});
