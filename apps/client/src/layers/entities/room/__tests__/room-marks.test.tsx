// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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
  emoji: '🐙',
  color: '#7c3aed',
  agentRef: 'deadbeefdeadbeef',
};

/** The local human: no emoji, no colour — the fallback case. */
const YOU: AuthorRef = { id: 'author-you', kind: 'human', displayName: 'You' };

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

function member(author: AuthorRef): RoomRosterEntry {
  return {
    roomId: 'room-1',
    authorId: author.id,
    responseMode: 'always',
    joinedAt: '2026-07-26T10:00:00.000Z',
    lastReadSeq: 0,
    author,
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
    expect(disc.style.backgroundColor).toBe(tint('#7c3aed'));
    expect(screen.getByText('🐙')).toBeInTheDocument();
    expect(screen.queryByText('A')).not.toBeInTheDocument();
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

  it('counts off the members past the fifth', () => {
    renderRoster(
      Array.from({ length: 7 }, (_, i) =>
        member({ id: `author-${i}`, kind: 'agent', displayName: `Agent ${i}` })
      )
    );

    expect(screen.getByText('+2')).toBeInTheDocument();
    expect(screen.getAllByText(/^A$/)).toHaveLength(5);
  });
});

describe('RoomAvatar', () => {
  it('draws a direct message as the agent it is with', () => {
    const { container } = render(
      <RoomAvatar room={{ id: 'dm-1', kind: 'dm', title: 'Ana' }} participants={[YOU, ANA]} />
    );

    const disc = container.querySelector('[data-slot="room-avatar"]') as HTMLElement;
    expect(disc.textContent).toBe('🐙');
    expect(disc.style.backgroundColor).toBe(tint('#7c3aed'));
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
    expect(dm.querySelector('[data-slot="room-avatar"]')).toHaveClass('size-5');
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

  it('keeps the # for a channel and the branch glyph for a thread', () => {
    const { container: channel } = render(
      <RoomAvatar room={{ id: 'c-1', kind: 'channel', title: '#general' }} participants={[ANA]} />
    );
    const { container: thread } = render(
      <RoomAvatar room={{ id: 't-1', kind: 'thread', title: 'A thread' }} participants={[ANA]} />
    );

    expect(channel.querySelector('svg.lucide-hash')).not.toBeNull();
    expect(thread.querySelector('svg.lucide-messages-square')).not.toBeNull();
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
