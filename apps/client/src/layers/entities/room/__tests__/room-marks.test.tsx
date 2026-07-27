// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { AuthorRef, RoomRosterEntry } from '@dorkos/shared/room-schemas';
import { hashToHslColor } from '@/layers/shared/lib';
import { TooltipProvider } from '@/layers/shared/ui';
import { RoomAvatar } from '../ui/RoomAvatar';
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
