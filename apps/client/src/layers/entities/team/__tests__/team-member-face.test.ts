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
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';
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
