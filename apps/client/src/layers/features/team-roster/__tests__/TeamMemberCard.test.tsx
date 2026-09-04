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

  describe('where the name came from (DOR-1022)', () => {
    /** The operator's row, with the provenance the payload would carry. */
    function withSuggestion(nameSuggestedBy: string | null): TeamMember {
      return { ...SELF, person: { ...SELF.person!, nameSuggestedBy } };
    }

    it('says which agent suggested the name it is drawing', () => {
      render(<TeamMemberCard member={withSuggestion('DorkBot')} />);
      expect(screen.getByText('Suggested by DorkBot')).toBeInTheDocument();
    });

    it('still says an agent did it when the payload names none', () => {
      render(<TeamMemberCard member={withSuggestion(null)} />);
      expect(screen.getByText('Suggested by an agent')).toBeInTheDocument();
    });

    it('draws nothing at all for a name nobody flagged', () => {
      // The common case, and the one that has to stay quiet: `SELF` carries no
      // `nameSuggestedBy`, which is what the payload says for a name the person
      // saved AND for one this install has no record of.
      const { container } = render(<TeamMemberCard member={SELF} />);
      expect(container.querySelector('[data-slot="team-member-name-source"]')).toBeNull();
      expect(screen.queryByText(/suggested by/i)).toBeNull();
    });
  });

  describe('the Surface tier — the card answers as one thing', () => {
    /** The card's root article. */
    const cardOf = (container: HTMLElement) =>
      container.querySelector('[data-slot="team-member-card"]') as HTMLElement;

    it('paints its border from the identity’s colour at a movable strength', () => {
      // The face colour is inline because an ancestor cannot inherit a property
      // its child declares — the card publishes it rather than reading it off
      // the disc. Everything else is a class: the border used to be inline too,
      // because `index.css` set `border-color` on `*` in an UNLAYERED rule that
      // outranked Tailwind's whole utilities layer (DOR-1024). That rule is
      // layered now, so the utility works and nothing needs the inline escape.
      const { container } = render(<TeamMemberCard member={SELF} onOpenProfile={() => {}} />);
      const card = cardOf(container);

      expect(card.style.getPropertyValue('--identity-color')).not.toBe('');
      expect(card.style.borderColor).toBe('');
      expect(card.className).toContain(
        'border-[color-mix(in_oklch,var(--identity-color)_var(--identity-border-strength),hsl(var(--border)))]'
      );
      // And the RESTING strength is a class too: an inline value would be one
      // the `hover:` step could never move.
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

    it('answers a keyboard on the CARD exactly as it answers a mouse', () => {
      // The S-tier gap this grammar's own rule forbids: a mouse got the whole
      // tile answering while Tab got a ring around a word. The negative twin
      // (standing down when the attribution takes focus) already existed, which
      // is what made the missing positive one read as an oversight rather than
      // a decision.
      const { container } = render(<TeamMemberCard member={SELF} onOpenProfile={() => {}} />);
      const card = cardOf(container);

      expect(container.querySelector('[data-slot="team-member-open"]')).not.toBeNull();
      expect(card.className).toContain(
        'has-[[data-slot=team-member-open]:focus-visible]:-translate-y-px'
      );
      expect(card.className).toContain(
        'has-[[data-slot=team-member-open]:focus-visible]:shadow-elevated'
      );
      expect(card.className).toContain(
        'has-[[data-slot=team-member-open]:focus-visible]:[--identity-border-strength:var(--identity-border-mix)]'
      );
    });

    it('does not shrink for a press it just stood down for', () => {
      // `:active` propagates to ancestors, so pressing the attribution would
      // scale the card the stand-down had only just calmed — the press echoing
      // on the wrong surface.
      const owner = MOCK_TEAM_ROSTER.find((m) => m.id === SELF.id)!;
      const { container } = render(
        <TeamMemberCard
          member={SELF}
          owner={owner}
          onSelectOwner={() => {}}
          onOpenProfile={() => {}}
        />
      );

      expect(cardOf(container).className).toContain(
        'has-[[data-slot=team-member-owner]:active]:scale-100'
      );
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

  describe('the owner echo — what narrowing to this person would leave', () => {
    const OWNER = MOCK_TEAM_ROSTER.find((member) => member.id === 'person-dorian')!;
    const AGENT = MOCK_TEAM_ROSTER.find((member) => member.id === 'agent-warden')!;

    const echoOf = (container: HTMLElement) =>
      container.querySelector('[data-slot="team-member-owner-count"]');

    function renderWithEcho(count: number | undefined) {
      return render(
        <TeamMemberCard
          member={AGENT}
          owner={OWNER}
          ownedAgentCount={count}
          onSelectOwner={() => {}}
        />
      );
    }

    it('says how many agents the owner has', () => {
      const { container } = renderWithEcho(3);
      expect(echoOf(container)).toHaveTextContent('· 3 agents');
    });

    it('counts one agent in the singular', () => {
      // The kind of thing nobody notices until it says "1 agents".
      const { container } = renderWithEcho(1);
      expect(echoOf(container)).toHaveTextContent('· 1 agent');
      expect(echoOf(container)?.textContent).not.toContain('agents');
    });

    it('draws no echo when the caller counted nothing', () => {
      // A card outside a roster has no roster to count, and "· 0 agents" beside
      // an agent that plainly exists would be a false sentence.
      expect(echoOf(renderWithEcho(undefined).container)).toBeNull();
      cleanup();
      expect(echoOf(renderWithEcho(0).container)).toBeNull();
    });

    it('costs the row nothing at rest, so revealing it cannot shove the name', () => {
      // The load-bearing assertion of this whole moment, and the second version
      // of it. Animating width is banned (it reflows), so the echo cannot grow
      // into place — but reserving its width in flow, which is what this did
      // first, charged 28–63px of the attribution's own space for something
      // invisible almost always, and truncated handles as short as
      // "@miguel.telegram" on a narrow window. Out of flow costs nothing and
      // still moves only `opacity`.
      const { container } = renderWithEcho(2);
      const echo = echoOf(container)!;

      expect(echo.className).toContain('absolute');
      expect(echo.className).toContain('left-full');
      expect(echo.className).toContain('opacity-0');
      expect(echo.className).toContain('transition-opacity');
      // Named, not `transition-all`: nothing here may transition a box property.
      expect(echo.className).not.toContain('transition-all');
      expect(echo.className).not.toContain('w-0');
      expect(echo.className).not.toContain('max-w-0');
    });

    it('anchors to a row sized by the attribution, not by the card', () => {
      // `left-full` is only "just past the handle" if the row shrink-wraps it.
      // On a full-width row it would mean "at the far edge of the card", which
      // puts the echo somewhere that reads as unrelated to what you are
      // pointing at.
      const { container } = renderWithEcho(2);
      const row = container.querySelector('[data-slot="team-member-owner"]')!.parentElement!;

      expect(row.className).toContain('w-fit');
      expect(row.className).toContain('relative');
    });

    it('answers a keyboard exactly as it answers a mouse', () => {
      // The grammar's focus-parity rule: everywhere a `hover:` reveals
      // something, the `focus-visible:` twin reveals it too. Without this, Tab
      // reaching the attribution would learn strictly less than a pointer.
      const { container } = renderWithEcho(2);
      const echo = echoOf(container)!;
      const attribution = container.querySelector('[data-slot="team-member-owner"]')!;

      expect(echo.className).toContain('peer-hover/owner:opacity-100');
      expect(echo.className).toContain('peer-focus-visible/owner:opacity-100');
      // The peer it listens to has to be the attribution itself, and named —
      // an unnamed peer would answer any sibling that happened to be one.
      expect(attribution.className).toContain('peer/owner');
    });

    it('does not exist at all where there is no hover to preview with', () => {
      // A touch screen performs the tap directly, so the preview could never be
      // seen there, and an element that can never appear is one more thing to
      // lay out for nothing. The query is about the POINTER, not the viewport,
      // so a narrow desktop window still gets the echo it can use.
      const { container } = renderWithEcho(2);
      const echo = echoOf(container)!;

      expect(echo.className).toContain('hidden');
      expect(echo.className).toContain('[@media(hover:hover)]:block');
    });

    it('stays out of the accessibility tree and out of the way of the pointer', () => {
      // The fact is already on screen as cards, and the button's own label
      // names the action. A decoration that ate hovers would be a target
      // pretending not to be one.
      const { container } = renderWithEcho(2);
      const echo = echoOf(container)!;

      expect(echo).toHaveAttribute('aria-hidden');
      expect(echo.className).toContain('pointer-events-none');
    });
  });

  describe('the badge wake', () => {
    const AGENT = MOCK_TEAM_ROSTER.find((member) => member.id === 'agent-warden')!;

    const discOf = (container: HTMLElement) =>
      container.querySelector('[data-slot="identity-avatar"]')!;
    const cardOf = (container: HTMLElement) =>
      container.querySelector('[data-slot="team-member-card"]') as HTMLElement;

    it('marks the CARD, not the disc, when there is a profile to open', () => {
      // The wake cannot ride the disc here. The name button's `after:` overlay
      // is stretched over the whole tile, so it owns the disc's pixels and the
      // disc never receives `:hover` — measured in a browser, where
      // `elementFromPoint` at the disc's centre returns the overlay and the
      // wake fired nowhere. Reading it off the card is also the honest version:
      // the card IS the target, and its lift and border answer the same hover.
      const { container } = render(<TeamMemberCard member={AGENT} onOpenProfile={() => {}} />);

      expect(cardOf(container).className).toContain('group/avatar');
      // On the disc it would be dead weight pointing at a hover that cannot
      // happen, so it must not be in two places.
      expect(discOf(container).className).not.toContain('group/avatar');
    });

    it('leaves a read-only tile alone', () => {
      // The wake says "you are pointing at something that answers", which is
      // false on a card with nothing to open.
      const { container } = render(<TeamMemberCard member={AGENT} />);
      expect(cardOf(container).className).not.toContain('group/avatar');
    });

    it('stands the badge down for the attribution, as the rest of the card does', () => {
      // The wake rides the card's hover now, so without this, pointing at the
      // attribution would wake the face while everything else deliberately
      // calmed — one pointer lighting two affordances.
      const owner = MOCK_TEAM_ROSTER.find((m) => m.id === 'person-dorian')!;
      const { container } = render(
        <TeamMemberCard
          member={AGENT}
          owner={owner}
          onSelectOwner={() => {}}
          onOpenProfile={() => {}}
        />
      );
      const card = cardOf(container);

      expect(card.className).toContain(
        '[&:has([data-slot=team-member-owner]:hover)_[data-slot=identity-badge]]:rotate-0'
      );
      expect(card.className).toContain(
        '[&:has([data-slot=team-member-owner]:focus-visible)_[data-slot=identity-badge]]:rotate-0'
      );
    });

    it('takes no hover ring — the card border is already this identity answering', () => {
      const { container } = render(<TeamMemberCard member={AGENT} onOpenProfile={() => {}} />);
      expect(discOf(container).className).not.toContain('hover:ring-2');
    });
  });
});

describe('TeamRosterGrid owner echo', () => {
  it('counts the owner’s agents from the whole roster, not the rows on screen', () => {
    // End-to-end for the one thing the card cannot do for itself. Dorian owns
    // two agents; showing only one of them must still say two, because the
    // echo previews what narrowing to Dorian would show — not what the current
    // filter left behind.
    const warden = MOCK_TEAM_ROSTER.find((member) => member.id === 'agent-warden')!;

    render(
      <TeamRosterGrid
        members={[warden]}
        roster={MOCK_TEAM_ROSTER}
        grouped={false}
        onSelectOwner={() => {}}
      />
    );

    expect(document.querySelector('[data-slot="team-member-owner-count"]')).toHaveTextContent(
      '· 2 agents'
    );
  });

  it('draws no echo inside a cluster, where the header already said whose these are', () => {
    const owner = MOCK_TEAM_ROSTER.find((member) => member.id === 'person-dorian')!;
    const owned = MOCK_TEAM_ROSTER.filter((member) => member.ownerId === owner.id);

    // Flat first, so the absence below is a decision this grid made and not an
    // echo that never renders anywhere. Same rows, same roster, one prop apart.
    const { rerender } = render(
      <TeamRosterGrid
        members={owned}
        roster={MOCK_TEAM_ROSTER}
        grouped={false}
        onSelectOwner={() => {}}
      />
    );
    expect(document.querySelectorAll('[data-slot="team-member-owner-count"]')).toHaveLength(
      owned.length
    );

    rerender(
      <TeamRosterGrid members={owned} roster={MOCK_TEAM_ROSTER} grouped onSelectOwner={() => {}} />
    );
    expect(document.querySelector('[data-slot="team-member-owner-count"]')).toBeNull();
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
