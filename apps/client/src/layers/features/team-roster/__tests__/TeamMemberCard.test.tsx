/**
 * @vitest-environment jsdom
 *
 * The Team page draws your photo.
 *
 * This is the surface the changelog's claim is about — "your photo shows up on
 * your team page" — and it was the one place the claim was false: the card and
 * the roster's cluster header each hand-rolled the spread from a `TeamMember`
 * into `resolveIdentityFace` and each dropped `imageUrl`, so a photo uploaded
 * in Settings reached the account menu, the profile drawer and the settings
 * form, and stopped at the roster.
 *
 * Both tests here fail against that code and pass through `teamMemberFace`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';
import { TeamMemberCard } from '../ui/TeamMemberCard';
import { TeamRosterGrid } from '../ui/TeamRosterGrid';

const SELF = MOCK_TEAM_ROSTER.find((member) => member.isSelf)!;
const PHOTO = '/api/profile/avatar/person-dorian?v=abc123';

/** The disc's `<img>`, which is `alt=""` because the row's own text names the identity. */
function avatarImage(): HTMLImageElement | null {
  return document.querySelector('img');
}

afterEach(cleanup);

describe('TeamMemberCard', () => {
  it('draws the photo a member has', () => {
    const withPhoto: TeamMember = { ...SELF, imageUrl: PHOTO };
    render(<TeamMemberCard member={withPhoto} />);
    expect(avatarImage()).toHaveAttribute('src', PHOTO);
  });

  it('falls back to the letter with no photo, and renders no <img> at all', () => {
    render(<TeamMemberCard member={SELF} />);
    // Structural, not cosmetic: an `<img>` with an empty `src` paints the
    // browser's own broken-image icon and no styling un-paints it.
    expect(avatarImage()).toBeNull();
    expect(screen.getByText('D')).toBeInTheDocument();
  });
});

describe('TeamRosterGrid cluster header', () => {
  it('draws the owner’s photo on the header that names them', () => {
    const owner: TeamMember = { ...SELF, imageUrl: PHOTO };
    const agents = MOCK_TEAM_ROSTER.filter((member) => member.ownerId === SELF.id);
    const roster = [owner, ...agents];

    render(<TeamRosterGrid members={agents} roster={roster} grouped />);

    // The header is the only place the owner is drawn in a grouped roster, so
    // it losing the photo loses it for the whole cluster.
    const images = Array.from(document.querySelectorAll('img'));
    expect(images.some((img) => img.getAttribute('src') === PHOTO)).toBe(true);
  });
});
