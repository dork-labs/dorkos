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

  describe('the Surface tier — the card answers as one thing', () => {
    /** The card's root article. */
    const cardOf = (container: HTMLElement) =>
      container.querySelector('[data-slot="team-member-card"]') as HTMLElement;

    it('paints its border from the identity’s colour at a movable strength', () => {
      // Two constraints meet here. An ancestor cannot inherit a property its
      // child declares, so the card publishes the face colour itself. And
      // `index.css` sets `border-color` on `*` in an UNLAYERED rule, which
      // outranks Tailwind's whole utilities layer — so no `border-<colour>`
      // class can paint a border in this app, and the colour has to be inline.
      // Only its strength moves, through a property a class can still set.
      const { container } = render(<TeamMemberCard member={SELF} onOpenProfile={() => {}} />);
      const card = cardOf(container);

      expect(card.style.getPropertyValue('--identity-color')).not.toBe('');
      expect(card.style.borderColor).toContain('var(--identity-border-strength)');
      // And the RESTING strength is a class, never inline: an inline value
      // would be one the `hover:` step could never move, for the same reason
      // the colour has to be inline to move at all.
      expect(card.style.getPropertyValue('--identity-border-strength')).toBe('');
      expect(card.className).toContain('[--identity-border-strength:0%]');
    });

    it('lifts, deepens and firms its border into that colour on hover', () => {
      const { container } = render(<TeamMemberCard member={SELF} onOpenProfile={() => {}} />);
      const card = cardOf(container);

      expect(card.className).toContain('hover:-translate-y-px');
      expect(card.className).toContain('hover:shadow-elevated');
      expect(card.className).toContain(
        'hover:[--identity-border-strength:var(--identity-border-mix)]'
      );
      // Card-sized press: 0.99, not the 0.94 a 24px mark takes.
      expect(card.className).toContain('active:scale-[0.99]');
      // Named properties, never `transition-all` — what moves stays auditable.
      expect(card.className).not.toContain('transition-all');
      // `translate` and `scale`, named as themselves: Tailwind v4 writes those
      // properties directly, so a list naming `transform` transitions nothing
      // and the lift snaps. Browser-checked — jsdom cannot see it.
      expect(card.className).toContain('transition-[box-shadow,border-color,translate,scale]');
    });

    it('stands down for the attribution, so one pointer lights one action', () => {
      const owner = MOCK_TEAM_ROSTER.find((m) => m.id === SELF.id)!;
      const { container } = render(
        <TeamMemberCard
          member={SELF}
          owner={owner}
          onSelectOwner={() => {}}
          onOpenProfile={() => {}}
        />
      );
      const card = cardOf(container);

      // Scoped to the attribution BY NAME. A bare `has-[button:hover]` would be
      // true everywhere on the card, because the name button's `after:` overlay
      // covers the whole tile and a pseudo-element hit-tests as its own
      // element — the lift would then never fire at all.
      expect(card.className).not.toContain('has-[button:hover]');
      expect(card.className).toContain('has-[[data-slot=team-member-owner]:hover]:translate-y-0');
      expect(card.className).toContain(
        'has-[[data-slot=team-member-owner]:hover]:[--identity-border-strength:0%]'
      );
      // A keyboard reaching the attribution calms the card the same way.
      expect(card.className).toContain(
        'has-[[data-slot=team-member-owner]:focus-visible]:translate-y-0'
      );
      expect(container.querySelector('[data-slot="team-member-owner"]')).not.toBeNull();
    });

    it('answers a keyboard on the attribution exactly as it answers a mouse', () => {
      const owner = MOCK_TEAM_ROSTER.find((m) => m.id === SELF.id)!;
      const { container } = render(
        <TeamMemberCard member={SELF} owner={owner} onSelectOwner={() => {}} />
      );
      const attribution = container.querySelector('[data-slot="team-member-owner"]') as HTMLElement;

      // The ring alone says "you are here", not "this filters" — the
      // informational half of the hover has to fire on focus too.
      expect(attribution.className).toContain('hover:underline');
      expect(attribution.className).toContain('focus-visible:underline');
      expect(attribution.className).toContain('hover:text-foreground');
      expect(attribution.className).toContain('focus-visible:text-foreground');
    });

    it('promises nothing on a card with no profile to open', () => {
      const { container } = render(<TeamMemberCard member={SELF} />);
      const card = cardOf(container);

      expect(card.className).not.toContain('hover:-translate-y-px');
      expect(card.className).not.toContain('active:scale-[0.99]');
    });
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
