// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { AuthorRef, RoomRosterEntry } from '@dorkos/shared/room-schemas';
import { hashToHslColor } from '@/layers/shared/lib';
import { TooltipProvider } from '@/layers/shared/ui';
import { RoomAvatar } from '../ui/RoomAvatar';
import { RoomTitle } from '../ui/RoomTitle';
import { MemberList } from '../ui/MemberList';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** An agent author as the server projects one: emoji and colour carried. */
const ANA: AuthorRef = {
  id: 'author-ana',
  kind: 'agent',
  displayName: 'Ana',
  handle: null,
  emoji: '🐙',
  color: '#7c3aed',
  agentRef: 'deadbeefdeadbeef',
};

/** The local human: no emoji, no colour — the fallback case. */
const YOU: AuthorRef = { id: 'author-you', kind: 'human', displayName: 'You', handle: null };

/**
 * The exact inline tint the shared avatar mixes at 18%.
 *
 * Read back off a probe element because jsdom rewrites a colour inside
 * `color-mix` into `rgb(...)` — the expectation has to go through the same
 * parser the assertion reads from, or it compares two spellings of one colour.
 */
function tint(color: string): string {
  const probe = document.createElement('span');
  probe.style.backgroundColor = `color-mix(in oklch, ${color} 18%, transparent)`;
  return probe.style.backgroundColor;
}

/**
 * The same read for a disc that FILLS with its colour rather than tinting —
 * what an agent's disc does, since `kind` began deriving the variant.
 */
function fill(color: string): string {
  const probe = document.createElement('span');
  probe.style.backgroundColor = color;
  return probe.style.backgroundColor;
}

function member(author: AuthorRef): RoomRosterEntry {
  return {
    roomId: 'room-1',
    authorId: author.id,
    responseMode: 'always',
    joinedAt: '2026-07-26T10:00:00.000Z',
    joinedSeq: 0,
    lastReadSeq: 0,
    author,
    origin: 'local',
  };
}

function renderRoster(members: RoomRosterEntry[]) {
  return render(<MemberList members={members} />, {
    wrapper: ({ children }) => <TooltipProvider>{children}</TooltipProvider>,
  });
}

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemberList', () => {
  it('draws an agent with the emoji and colour the agent already carries', () => {
    const { container } = renderRoster([member(ANA)]);

    const disc = container.querySelector('[data-slot="room-member-avatar"]') as HTMLElement;
    // An agent's disc is FILLED with its colour, not tinted by it — the roster
    // used to tint every member alike, which is what let an agent and a person
    // read as the same kind of thing (DOR-968).
    expect(disc.style.backgroundColor).toBe(fill('#7c3aed'));
    expect(screen.getByText('🐙')).toBeInTheDocument();
    expect(screen.queryByText('A')).not.toBeInTheDocument();
  });

  it('gives an agent the agent silhouette, and a person the person one', () => {
    // The sharpest violation this roster was half of: it drew an agent round
    // and unmarked while the member sheet drew the same agent with a bot mark.
    // Both decisions come off `kind` now — see `roster-face-parity.test.tsx`,
    // which asserts the two surfaces against each other.
    const { container } = renderRoster([member(ANA), member(YOU)]);

    const [agent, person] = Array.from(
      container.querySelectorAll<HTMLElement>('[data-slot="room-member-avatar"]')
    );
    expect(agent!.className).not.toContain('rounded-full');
    expect(agent!.querySelector('svg.lucide-bot')).not.toBeNull();
    expect(person!.className).toContain('rounded-full');
    expect(person!.querySelector('svg')).toBeNull();
  });

  it('falls back to an initial on a hashed colour for an author with neither', () => {
    const { container } = renderRoster([member(YOU)]);

    const disc = container.querySelector('[data-slot="room-member-avatar"]') as HTMLElement;
    // "You" has no emoji and no colour of its own — the letter and a colour
    // hashed from the author id are all there is to draw with.
    expect(disc.style.backgroundColor).toBe(tint(hashToHslColor('author-you')));
    expect(screen.getByText('Y')).toBeInTheDocument();
  });

  it('names every member to assistive technology, emoji or not', () => {
    renderRoster([member(ANA), member(YOU)]);

    expect(screen.getByText('Ana')).toHaveClass('sr-only');
    expect(screen.getByText('You')).toHaveClass('sr-only');
  });

  it('still hangs its tooltip off the disc itself', () => {
    // The disc IS the trigger, so Radix's props have to reach the same element.
    const { container } = renderRoster([member(ANA)]);

    const disc = container.querySelector('[data-slot="room-member-avatar"]') as HTMLElement;
    expect(disc.getAttribute('data-state')).toBe('closed');
  });

  it('draws a roster disc one step larger than the sidebar mark it sits beside', () => {
    const { container } = renderRoster([member(ANA)]);

    expect(container.querySelector('[data-slot="room-member-avatar"]')).toHaveClass('size-6');
  });

  it('is a plain list, with nothing to press, until it is given something to do', () => {
    renderRoster([member(ANA)]);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByRole('list')).toHaveAttribute('aria-label', '1 member');
  });

  it('becomes ONE button naming the action AND the count', () => {
    const onClick = vi.fn();
    render(
      <MemberList
        members={[member(ANA), member(YOU)]}
        onClick={onClick}
        label="Members of #general"
      />,
      { wrapper: ({ children }) => <TooltipProvider>{children}</TooltipProvider> }
    );

    // Both halves, because each on its own is a defect: "2 members" never says
    // what pressing it does, and "Members of #general" drops a count every
    // sighted reader can see in the discs.
    const button = screen.getByRole('button', { name: 'Members of #general, 2 members' });
    // One button, not one per disc: two members must not mean two tab stops and
    // two identical actions.
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByRole('list')).not.toBeInTheDocument();

    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('still draws every disc, still named, when it is a button', () => {
    const { container } = render(
      <MemberList members={[member(ANA), member(YOU)]} onClick={vi.fn()} label="Members" />,
      { wrapper: ({ children }) => <TooltipProvider>{children}</TooltipProvider> }
    );
    expect(container.querySelectorAll('[data-slot="room-member-avatar"]')).toHaveLength(2);
    expect(screen.getByText('🐙')).toBeInTheDocument();
    // The names ride along on the discs. They do NOT become the button's name —
    // an explicit aria-label wins — but a roster read off this element rather
    // than off the room still finds who is in it.
    expect(screen.getByText('Ana')).toHaveClass('sr-only');
  });

  it('answers a hovered disc in that member’s own colour, in the list form', () => {
    // The tooltip should not be the first sign that anything here is
    // hoverable. Max five discs, each individually addressable — the exact
    // shape the colour response is for.
    const { container } = renderRoster([member(ANA), member(YOU)]);
    const disc = container.querySelector('[data-slot="room-member-avatar"]') as HTMLElement;

    expect(disc.className).toContain('hover:ring-2');
    expect(disc.className).toContain('var(--identity-color)');
    // Paint order only, so the ring clears the disc overlapping it and nothing
    // on the row moves.
    expect(disc.className).toContain('hover:z-10');
    // A `<span>` no keyboard can reach must not carry a focus ring: a dormant
    // affordance is exactly the defect this grammar removes, not one it adds.
    expect(disc.className).not.toContain('focus-visible:ring');
  });

  it('gives the button form no per-disc response — one target, one action', () => {
    // Five discs each answering to one hover would suggest five actions. The
    // button's own `hover:bg-accent` is the whole answer.
    const { container } = render(
      <MemberList members={[member(ANA), member(YOU)]} onClick={vi.fn()} label="Members" />,
      { wrapper: ({ children }) => <TooltipProvider>{children}</TooltipProvider> }
    );

    for (const disc of container.querySelectorAll('[data-slot="room-member-avatar"]')) {
      expect(disc.className).not.toContain('hover:ring-2');
    }
    expect(screen.getByRole('button').className).toContain('hover:bg-accent');
  });

  it('counts off the members past the fifth', () => {
    const { container } = renderRoster(
      Array.from({ length: 7 }, (_, i) =>
        member({ id: `author-${i}`, kind: 'agent', displayName: `Agent ${i}`, handle: null })
      )
    );

    expect(screen.getByText('+2')).toBeInTheDocument();
    // Discs, not letters. What this test is about is the cap, and counting one
    // particular kind of face couples it to a fallback ladder it does not care
    // about — it went red once already when an agent's empty face was being
    // reconsidered (DOR-1122).
    expect(container.querySelectorAll('[data-slot="room-member-avatar"]')).toHaveLength(5);
  });

  describe('the origin mark (chats-as-channels spec §4.3, §9, DOR-879)', () => {
    it('badges an external member so their platform is legible without a hover', () => {
      const miguel: RoomRosterEntry = {
        ...member({ id: 'author-miguel', kind: 'human', displayName: 'Miguel', handle: null }),
        origin: { platform: 'telegram' },
      };
      const { container } = renderRoster([miguel]);

      // The badge is drawn on the disc itself — always visible, never behind
      // a tooltip a reader would have to go hovering for. `telegram` resolves
      // to its own brand mark (`ADAPTER_LOGO_MAP`), so this is the SAME icon
      // the connection surfaces already draw for it, not a generic stand-in.
      const badgeSlot = container.querySelector(
        '[data-slot="room-member-avatar"] > span:nth-child(2)'
      );
      expect(badgeSlot?.querySelector('svg')).not.toBeNull();
      expect(screen.getByText('Miguel, from Telegram')).toHaveClass('sr-only');
    });

    it('badges nothing for a local member — no disc wears the mark for its own operator', () => {
      const { container } = renderRoster([member(YOU)]);
      const avatar = container.querySelector('[data-slot="room-member-avatar"]');
      expect(avatar?.querySelector('svg')).toBeNull();
    });
  });
});

describe('RoomAvatar', () => {
  it('draws a direct message as the agent it is with', () => {
    const { container } = render(
      <RoomAvatar room={{ id: 'dm-1', kind: 'dm', title: 'Ana' }} participants={[YOU, ANA]} />
    );

    const disc = container.querySelector('[data-slot="room-avatar"]') as HTMLElement;
    expect(disc.textContent).toBe('🐙');
    expect(disc.style.backgroundColor).toBe(fill('#7c3aed'));
  });

  it('stops a sidebar face stack at two, and overlaps them by 14px (D1)', () => {
    // The measurement this exists for: an 18px slot has 22px of room before the
    // label column starts. Three faces at the roster's own −6px overlap measure
    // 48 and ran UNDER the room's title; two at −14 measure 18 + 18 − 14 = 22.
    // Red if the cap or the overlap is retuned without the other.
    const five = Array.from({ length: 5 }, (_, i) => ({ color: '#7c3aed', emoji: `${i}` }));
    const { container } = render(
      <RoomAvatar room={{ id: 'dm-many', kind: 'dm', title: 'Four agents' }} visuals={five} />
    );
    const stack = container.querySelector('[data-slot="room-avatar"]') as HTMLElement;
    expect(stack.querySelectorAll('[data-slot="identity-avatar"]')).toHaveLength(2);
    expect(stack.className).toContain('-space-x-3.5');
  });

  it('lets a roomier surface keep three faces and the roster’s own overlap', () => {
    // The cap is the SIDEBAR's, not the mark's: the masthead and the picker have
    // width to spend, and a group there still reads as a group. Without this the
    // pair above would be indistinguishable from "two faces, everywhere".
    const five = Array.from({ length: 5 }, (_, i) => ({ color: '#7c3aed', emoji: `${i}` }));
    const { container } = render(
      <RoomAvatar
        room={{ id: 'dm-many', kind: 'dm', title: 'Four agents' }}
        visuals={five}
        size="md"
      />
    );
    const stack = container.querySelector('[data-slot="room-avatar"]') as HTMLElement;
    expect(stack.querySelectorAll('[data-slot="identity-avatar"]')).toHaveLength(3);
    expect(stack.className).toContain('-space-x-1.5');
  });

  it('draws a DM face as an agent, in every shape the mark takes', () => {
    // A DM's counterpart is an agent by construction, and this one component
    // is what the sidebar row, the room masthead and the command palette all
    // draw — so it read "agent" in its colour and "person" in its shape in
    // three places at once (DOR-968). Red if any of the three paths goes round
    // again: the single resolved face, the stack, or the letter fallback that
    // still knows who it is for.
    const square = (mark: Element | null) => {
      expect(mark).not.toBeNull();
      expect((mark as HTMLElement).className).not.toContain('rounded-full');
    };

    const { container: single } = render(
      <RoomAvatar
        room={{ id: 'dm-1', kind: 'dm', title: 'Ana' }}
        visuals={[{ color: '#7c3aed', emoji: '🐙' }]}
      />
    );
    const singleDisc = single.querySelector('[data-slot="room-avatar"]') as HTMLElement;
    square(singleDisc);
    expect(singleDisc.style.backgroundColor).toBe(fill('#7c3aed'));

    const { container: stacked } = render(
      <RoomAvatar
        room={{ id: 'dm-2', kind: 'dm', title: 'Ana and Kai' }}
        visuals={[
          { color: '#7c3aed', emoji: '🐙' },
          { color: '#3ca078', emoji: '🔔' },
        ]}
      />
    );
    const faces = stacked.querySelectorAll('[data-slot="identity-avatar"]');
    expect(faces).toHaveLength(2);
    faces.forEach(square);

    const { container: letter } = render(
      <RoomAvatar
        room={{ id: 'dm-3', kind: 'dm', title: 'Bo' }}
        participants={[YOU, { id: 'author-bo', kind: 'agent', displayName: 'Bo', handle: null }]}
      />
    );
    const letterDisc = letter.querySelector('[data-slot="room-avatar"]') as HTMLElement;
    expect(letterDisc.textContent).toBe('B');
    square(letterDisc);
  });

  it("falls back to the room's own letter when no agent is on the roster", () => {
    // A DM whose join never completed holds only the human. Hashing the room id
    // is stable and honest; picking the human would name the wrong person.
    const { container } = render(
      <RoomAvatar room={{ id: 'dm-1', kind: 'dm', title: 'Ana' }} participants={[YOU]} />
    );

    const disc = container.querySelector('[data-slot="room-avatar"]') as HTMLElement;
    expect(disc.textContent).toBe('A');
    expect(disc.style.backgroundColor).toBe(tint(hashToHslColor('dm-1')));
  });

  it('falls back the same way when the caller knows no roster at all', () => {
    const { container } = render(<RoomAvatar room={{ id: 'dm-1', kind: 'dm', title: 'Bo' }} />);

    const disc = container.querySelector('[data-slot="room-avatar"]') as HTMLElement;
    expect(disc.textContent).toBe('B');
    expect(disc.style.backgroundColor).toBe(tint(hashToHslColor('dm-1')));
  });

  it('draws a channel and a DM at one size in the same row, with no size given', () => {
    // The sidebar names no size. A channel's mark is a lucide glyph and a DM's
    // is the shared identity disc, and those two carry DIFFERENT defaults of
    // their own — so an unspecified size has to resolve here, once, or the two
    // marks stack up at different heights in the same list.
    const { container: channel } = render(
      <RoomAvatar room={{ id: 'c-1', kind: 'channel', title: '#general' }} />
    );
    const { container: dm } = render(
      <RoomAvatar room={{ id: 'dm-1', kind: 'dm', title: 'Ana' }} participants={[ANA]} />
    );

    expect(channel.querySelector('[data-slot="room-avatar"]')).toHaveClass('size-3.5');
    expect(dm.querySelector('[data-slot="room-avatar"]')).toHaveClass('size-[18px]');
  });

  it('scales both marks together when a size is named', () => {
    const { container: channel } = render(
      <RoomAvatar room={{ id: 'c-1', kind: 'channel', title: '#general' }} size="sm" />
    );
    const { container: dm } = render(
      <RoomAvatar room={{ id: 'dm-1', kind: 'dm', title: 'Ana' }} participants={[ANA]} size="sm" />
    );

    expect(channel.querySelector('[data-slot="room-avatar"]')).toHaveClass('size-5');
    expect(dm.querySelector('[data-slot="room-avatar"]')).toHaveClass('size-7');
  });

  it('keeps the # for a channel even when participants are handed to it', () => {
    // A channel's mark is its `#`, never a member's face — so passing a roster
    // must not push it down the DM path and put Ana's face on a room she does
    // not own. There is no third kind to check: a thread is a relation between
    // entries, not a room (ADR 260728-022013).
    const { container: channel } = render(
      <RoomAvatar room={{ id: 'c-1', kind: 'channel', title: '#general' }} participants={[ANA]} />
    );

    expect(channel.querySelector('svg.lucide-hash')).not.toBeNull();
    expect(channel.querySelector('[data-slot="identity-avatar"]')).toBeNull();
  });
});

describe('RoomTitle', () => {
  /** A channel as the server stores one: a sluggable name, and the slug. */
  const GENERAL = { kind: 'channel', slug: 'general', title: 'General' } as const;

  /** The `[data-slot="room-title"]` element itself. */
  function titleOf(container: HTMLElement): HTMLElement {
    return container.querySelector('[data-slot="room-title"]') as HTMLElement;
  }

  it('shows a channel name with no # of its own, because RoomAvatar drew one', () => {
    const { container } = render(<RoomTitle room={GENERAL} />);

    // The visible run of text is `general`. `#general` here is what renders as
    // `# #general` in a row, which is the whole defect.
    const visible = titleOf(container).querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(visible.textContent).toBe('general');
  });

  it('still speaks the # to anyone who cannot see the glyph', () => {
    const { container } = render(<RoomTitle room={GENERAL} />);

    // The mark is decorative, so losing it here would leave a screen reader
    // calling a channel `general` — a name nobody types and nothing enforces.
    const spoken = titleOf(container).querySelector('.sr-only') as HTMLElement;
    expect(spoken.textContent).toBe('#general');
  });

  it('keeps the spoken name out of a copied selection and out of find-in-page', () => {
    const { container } = render(<RoomTitle room={GENERAL} />);

    // Text that exists only for assistive technology is still selectable text.
    // Without this, dragging across the sidebar copies "#generalgeneral" and
    // Cmd+F matches a `#general` that is nowhere on screen.
    expect(titleOf(container).querySelector('.sr-only')).toHaveClass('select-none');
  });

  it('keeps #general as the tooltip, where no mark sits beside it', () => {
    const { container } = render(<RoomTitle room={GENERAL} />);

    expect(titleOf(container)).toHaveAttribute('title', '#general');
  });

  it('writes a direct message as one text node — no mark, nothing to split', () => {
    const { container } = render(<RoomTitle room={{ kind: 'dm', slug: null, title: 'Ana' }} />);

    const title = titleOf(container);
    expect(title.textContent).toBe('Ana');
    expect(title.querySelectorAll('span')).toHaveLength(0);
  });

  it('names a channel with no slug by its title, and marks nothing', () => {
    // `slug` is nullable in the schema, and a title is not a `#name`.
    const { container } = render(
      <RoomTitle room={{ kind: 'channel', slug: null, title: 'Untitled' }} />
    );

    const title = titleOf(container);
    expect(title.textContent).toBe('Untitled');
    expect(title).toHaveAttribute('title', 'Untitled');
  });
});
