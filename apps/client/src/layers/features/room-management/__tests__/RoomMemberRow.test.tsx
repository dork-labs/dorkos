// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { AuthorRef, RoomRosterEntry } from '@dorkos/shared/room-schemas';
import type { AgentVisual } from '@/layers/shared/lib';
import { RoomMemberRow, type RoomMemberRowProps } from '../ui/RoomMemberRow';

/** Put the viewport below or above the 768px breakpoint for one test. */
function viewport(width: 'phone' | 'desktop') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: width === 'phone',
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

function member(author: Partial<AuthorRef> & Pick<AuthorRef, 'kind'>): RoomRosterEntry {
  return {
    roomId: 'room-1',
    authorId: 'author-Ana',
    responseMode: 'mention-only',
    joinedAt: '2026-07-26T10:00:00.000Z',
    lastReadSeq: 0,
    author: { id: 'author-Ana', displayName: 'Ana', ...author },
  };
}

const AGENT = member({ kind: 'agent', agentRef: 'ref-ana' });
const PERSON = member({ kind: 'human', id: 'me', displayName: 'Dorian' });

function renderRow(overrides: Partial<RoomMemberRowProps> = {}) {
  const props: RoomMemberRowProps = {
    member: AGENT,
    roomKind: 'channel',
    isReader: false,
    visual: null,
    presence: null,
    lastSpokeAt: null,
    expanded: false,
    onExpandedChange: vi.fn(),
    onRungChange: vi.fn(),
    savingRung: false,
    rungError: null,
    roomTitle: '#general',
    onRemoveRequested: vi.fn(),
    confirmingRemoval: false,
    onConfirmRemoval: vi.fn(),
    onCancelRemoval: vi.fn(),
    engagedWindow: null,
    ...overrides,
  };
  return { ...render(<RoomMemberRow {...props} />), props };
}

/** The tinted disc. */
function disc(): HTMLElement {
  const found = document.querySelector('[data-slot="identity-avatar"]');
  if (found === null) throw new Error('no disc drawn');
  return found as HTMLElement;
}

/**
 * The colour the disc was told to tint itself with.
 *
 * jsdom re-serialises what it parses — a hex becomes `rgb(...)` and
 * `currentColor` loses its capital — so the assertion compares against what
 * comes back out rather than against what went in.
 */
function tint(): string {
  return disc().getAttribute('style') ?? '';
}

afterEach(() => {
  cleanup();
  viewport('desktop');
});

describe('RoomMemberRow', () => {
  it('marks an agent with the bot glyph and leaves a person unmarked', () => {
    // Absence is the signal. A badge on every row would be a column of
    // identical marks, and one reading "person" would put the burden of proof
    // on the humans.
    const { container: agent } = renderRow();
    expect(agent.querySelector('.lucide-bot')).not.toBeNull();

    cleanup();
    const { container: person } = renderRow({ member: PERSON });
    expect(person.querySelector('.lucide-bot')).toBeNull();
  });

  it('marks the reader, and only the reader', () => {
    renderRow({ member: PERSON, isReader: true });

    expect(screen.getByText('(you)')).toBeInTheDocument();
  });

  describe('the face, from the freshest source that has one', () => {
    const MANIFEST: AgentVisual = { color: '#6366f1', emoji: '🔍' };

    it('prefers the agent’s own manifest, so it looks like itself everywhere', () => {
      renderRow({
        member: member({ kind: 'agent', emoji: '📦', color: '#ff0000' }),
        visual: MANIFEST,
      });

      expect(within(disc()).getByText('🔍')).toBeInTheDocument();
      expect(tint()).toContain('rgb(99, 102, 241)');
    });

    it('falls back to the author record when the fleet has no face for it', () => {
      // A render cache the server refreshed the last time it resolved this
      // author. Stale after a rename, and still better than nothing.
      renderRow({ member: member({ kind: 'agent', emoji: '📦', color: '#ff0000' }), visual: null });

      expect(within(disc()).getByText('📦')).toBeInTheDocument();
      expect(tint()).toContain('rgb(255, 0, 0)');
    });

    it('draws a letter, and never a confident face it invented', () => {
      // Red if anything ever hashes the author id into a colour here: it would
      // be perfectly stable, perfectly confident, and match no other surface in
      // the cockpit. `currentColor` is the row's own text colour, which reads
      // as a shade of the surface rather than as a colour that means something.
      renderRow({ member: member({ kind: 'agent' }), visual: null });

      expect(within(disc()).getByText('A')).toBeInTheDocument();
      expect(tint()).toContain('currentcolor');
      expect(tint()).not.toMatch(/hsl|rgb|#[0-9a-f]{3,}/i);
    });
  });

  describe('what the row says about this member', () => {
    it('shows a live dot only while the agent is working', () => {
      const { container: quiet } = renderRow();
      expect(quiet.querySelector('.bg-status-success')).toBeNull();

      cleanup();
      const { container: busy } = renderRow({
        presence: { authorId: 'author-Ana', state: 'working', since: '', elapsedMs: 1000 },
      });
      expect(busy.querySelector('.bg-status-success')).not.toBeNull();
    });

    it('gives a person no loudness and no menu', () => {
      // There is no verb for the reader, and nothing triggers them. The empty
      // slot is the statement.
      renderRow({ member: PERSON, isReader: true });

      expect(screen.queryByRole('button', { name: /How loud/ })).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/actions$/)).not.toBeInTheDocument();
    });

    it('names the rung on the pill, so the scale is readable without opening it', () => {
      renderRow();

      expect(screen.getByRole('button', { name: 'How loud Ana is here' })).toHaveTextContent(
        '@only'
      );
    });
  });

  describe('where Remove lives', () => {
    it('is behind the "…" on desktop', () => {
      renderRow();

      expect(screen.getByLabelText('Ana actions')).toBeInTheDocument();
    });

    it('has no "…" at all on a phone, and puts Remove in the opened row', () => {
      // A dropdown portalled inside a vaul drawer is a known-hazard nesting.
      // Red if the menu comes back below 768px, or if Remove goes missing there
      // — an agent you cannot take out of a room is worse than either.
      viewport('phone');
      renderRow({ expanded: true });

      expect(screen.queryByLabelText('Ana actions')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Remove from this room' })).toBeInTheDocument();
    });

    it('takes the keyboard to the confirmation when one is raised without a menu', () => {
      // The touch path: Remove is a plain button, so nothing is trapping focus
      // and the row's own effect can place it. The desktop path cannot use this
      // — see the menu's `onCloseAutoFocus`.
      viewport('phone');
      renderRow({ expanded: true, confirmingRemoval: true });

      expect(
        within(screen.getByRole('group', { name: 'Remove Ana from #general?' })).getByRole(
          'button',
          { name: 'Remove' }
        )
      ).toHaveFocus();
    });
  });
});
