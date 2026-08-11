// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { AuthorRef, RoomRosterEntry } from '@dorkos/shared/room-schemas';
import { hashToHslColor, type AgentVisual } from '@/layers/shared/lib';
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
    joinedSeq: 0,
    lastReadSeq: 0,
    author: { id: 'author-Ana', displayName: 'Ana', handle: null, ...author },
    origin: 'local',
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
    onRungPreview: vi.fn(),
    savingRung: false,
    rungError: null,
    roomTitle: '#general',
    onRemoveRequested: vi.fn(),
    confirmingRemoval: false,
    onConfirmRemoval: vi.fn(),
    onCancelRemoval: vi.fn(),
    engagedWindow: null,
    dormantReasonId: null,
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

/** The same colour, put through jsdom's own parser so the two forms compare. */
function probeColor(color: string): string {
  const probe = document.createElement('span');
  probe.style.backgroundColor = color;
  return probe.style.backgroundColor;
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

    it('draws a letter on the same hashed colour the rest of the room uses', () => {
      // This row used to answer `currentColor` here, on the argument that a
      // hashed colour would be confident about a face nobody knows. It matches
      // the roster three inches away, which hashes the same id — so refusing to
      // hash is what made one member two colours at once (DOR-968).
      //
      // Red if the colour stops being THIS hash: a different one is worse than
      // no colour, because it looks deliberate. And red if an emoji ever
      // appears: this row holds an AUTHOR id, not the agent's manifest id, so a
      // hashed emoji here would be a different face from the one /team and the
      // sidebar draw for the same agent (DOR-1122 review). The roster invents an
      // agent's emoji in `teamMemberFace`, which does hold the manifest id; this
      // row gets one only when the fleet hands it a real `visual`, and DOR-1002
      // is what threads that here.
      renderRow({ member: member({ kind: 'agent' }), visual: null });

      expect(within(disc()).getByText('A')).toBeInTheDocument();
      expect(tint()).toContain(probeColor(hashToHslColor('author-Ana')));
    });

    it('draws a letter for a person with no face of their own', () => {
      // The half that stays a letter under every future version of this ladder:
      // an invented emoji beside a person's name claims a face nobody chose.
      renderRow({ member: PERSON, visual: null });

      expect(within(disc()).getByText('D')).toBeInTheDocument();
      expect(tint()).toContain(probeColor(hashToHslColor('me')));
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

    it('pulses that dot, and drops only the pulse when motion is unwanted', () => {
      // The dot reports something happening RIGHT NOW, and a still one says the
      // same about a state that ended an hour ago. `AgentAvatar` has had this
      // ping since it shipped and it never reached here — this row draws the
      // identity disc, and a room's working signal is not an agent's mesh
      // health. Red if the ping goes, and red if `motion-reduce:hidden` ever
      // lands on the dot itself: the preference would then delete the fact
      // rather than the movement. Whether it actually animates is the browser's
      // to say — jsdom runs no animations at all.
      const { container } = renderRow({
        presence: { authorId: 'author-Ana', state: 'working', since: '', elapsedMs: 1000 },
      });

      const ping = container.querySelector('.animate-ping');
      expect(ping).not.toBeNull();
      expect(ping!.className).toContain('motion-reduce:hidden');
      expect(ping!.parentElement!.className).not.toContain('motion-reduce:hidden');
    });

    it('turns the pill’s caret over while the scale is open', () => {
      // A meter beside a word does not look like a control that opens
      // something. Red if the caret goes, or if it stops answering to the open
      // state — a mark that points the same way in both is decoration.
      const shut = renderRow().container.querySelector('.lucide-chevron-down');
      expect(shut).not.toBeNull();
      expect(shut!.getAttribute('class')).not.toContain('rotate-180');

      cleanup();
      const open = renderRow({ expanded: true }).container.querySelector('.lucide-chevron-down');
      expect(open!.getAttribute('class')).toContain('rotate-180');
    });

    it('is a thumb’s worth of row on touch, and its contents’ worth above it', () => {
      // A row carrying a face and two lines of text comes to about 36px if
      // nothing asks for more, which on a phone reads as a list of dots with
      // captions. jsdom measures everything as 0 × 0, so the 56px itself is the
      // browser's to confirm; what is settleable is that the floor is asked for
      // below 768px and given back above it. Red if either half goes.
      const { container } = renderRow();

      const row = container.querySelector('[data-slot="room-member-row"] > div');
      expect(row!.className).toContain('min-h-14');
      expect(row!.className).toContain('md:min-h-0');
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

  describe('pointing at a rung without committing it', () => {
    it('reports the rung the reader arrowed onto', () => {
      const { props } = renderRow({ expanded: true, member: AGENT });

      fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'End' });

      expect(props.onRungPreview).toHaveBeenLastCalledWith('everything');
    });

    it('reports nothing at all in an archived room', () => {
      // There is nothing to preview into: the sheet replaces its loudness line
      // with the sentence saying these settings are on hold, so a report would
      // describe a consequence that is not on screen and is not true anyway.
      // The scale still explains each rung — reading that is worth doing on a
      // room you are deciding whether to revive. Red if the guard goes.
      const { props } = renderRow({
        expanded: true,
        member: AGENT,
        dormantReasonId: 'why-on-hold',
      });

      fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'End' });

      expect(props.onRungPreview).not.toHaveBeenCalled();
      expect(screen.getByText('Answers every message in this room.')).toBeInTheDocument();
    });
  });

  describe('the origin mark (chats-as-channels spec §4.3, §9, DOR-879)', () => {
    it('marks an external member with their platform, legible without a hover', () => {
      const external: RoomRosterEntry = {
        ...member({ kind: 'human', id: 'author-miguel', displayName: 'Miguel' }),
        origin: { platform: 'telegram' },
      };

      renderRow({ member: external });

      const mark = screen.getByTestId('origin-mark');
      expect(mark).toHaveTextContent('Telegram');
      // Legible AT A GLANCE (spec §9) — not inside a `title` attribute or a
      // hover-only element nobody can see without a pointer.
      expect(mark).toBeVisible();
    });

    it('marks nothing for the operator — a local human draws no origin mark', () => {
      renderRow({ member: PERSON });
      expect(screen.queryByTestId('origin-mark')).not.toBeInTheDocument();
    });

    it('marks nothing for an agent — agents are always local', () => {
      renderRow({ member: AGENT });
      expect(screen.queryByTestId('origin-mark')).not.toBeInTheDocument();
    });
  });
});
