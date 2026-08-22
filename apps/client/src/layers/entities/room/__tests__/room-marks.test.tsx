// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { AuthorRef, RoomRosterEntry } from '@dorkos/shared/room-schemas';
import { hashToHslColor } from '@/layers/shared/lib';
import { TooltipProvider } from '@/layers/shared/ui';
import { RoomAvatar } from '../ui/RoomAvatar';
import { RoomTitle } from '../ui/RoomTitle';

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

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
