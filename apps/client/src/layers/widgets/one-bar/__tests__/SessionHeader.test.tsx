// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { OneBarRouteState } from '../model/one-bar-context';
import { SessionHeader } from '../ui/SessionHeader';
import { BarHarness } from './bar-harness';

// The fixed cluster OneBar renders. Both are real widgets with their own data
// needs; this suite is about what the BAR says, so they are stubbed at the seam.
vi.mock('@/layers/widgets/inbox-bell', () => ({
  InboxBell: () => <button aria-label="Inbox">Inbox</button>,
}));
vi.mock('@/layers/features/right-panel', () => ({
  RightPanelToggle: () => <button aria-label="Toggle right panel">Panel</button>,
}));

// Mock app store (used by CommandPaletteTrigger)
vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      setGlobalPaletteOpen: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
}));

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

const VISUAL = { color: 'hsl(210 70% 55%)', emoji: '🤖' };

function renderBar(state: Partial<OneBarRouteState>) {
  return render(
    <BarHarness {...state}>
      <SessionHeader />
    </BarHarness>
  );
}

/** The identity zone's title element — the one that carries the session's name. */
function titleElement(text: string) {
  return screen.getByTitle(text);
}

describe('SessionHeader', () => {
  afterEach(() => {
    cleanup();
  });

  // --- Identity (D1): face · name · › · title ---

  it('shows the agent name and the session title', () => {
    renderBar({ agentName: 'dorkbot', agentVisual: VISUAL, sessionTitle: 'Fix the flaky test' });
    expect(screen.getByText('dorkbot')).toBeInTheDocument();
    expect(screen.getByText('Fix the flaky test')).toBeInTheDocument();
  });

  it("draws the agent's face from its resolved visual", () => {
    renderBar({ agentName: 'dorkbot', agentVisual: VISUAL, sessionTitle: 'Fix the flaky test' });
    expect(screen.getByText(VISUAL.emoji)).toBeInTheDocument();
    expect(screen.queryByTestId('session-directory-mark')).not.toBeInTheDocument();
  });

  it('drops the breadcrumb it replaced', () => {
    renderBar({ agentName: 'dorkbot', agentVisual: VISUAL, sessionTitle: 'Fix the flaky test' });
    expect(screen.queryByRole('link', { name: 'Team' })).not.toBeInTheDocument();
    expect(screen.queryByText('Session')).not.toBeInTheDocument();
  });

  // --- Fallbacks (spec §5.3) ---

  it('names a session the runtime has not titled yet "New session"', () => {
    renderBar({ agentName: 'dorkbot', agentVisual: VISUAL, sessionTitle: '' });
    expect(screen.getByText('New session')).toBeInTheDocument();
  });

  it('says "New session" before any title has been fetched at all', () => {
    renderBar({ agentName: 'dorkbot', agentVisual: VISUAL });
    expect(screen.getByText('New session')).toBeInTheDocument();
  });

  it('falls back to the directory name when the session has no agent', () => {
    renderBar({ sessionDirectoryName: 'dork-os', sessionTitle: 'Read the notes' });
    expect(screen.getByText('dork-os')).toBeInTheDocument();
  });

  it('draws a generic mark rather than an empty face when there is no agent', () => {
    renderBar({ sessionDirectoryName: 'dork-os' });
    expect(screen.queryByText(VISUAL.emoji)).not.toBeInTheDocument();
    // The identity still opens with a mark — a name with nothing beside it is
    // the empty-avatar hole this fallback exists to close.
    expect(screen.getByTestId('session-directory-mark')).toBeInTheDocument();
  });

  it('shows a live title beside the directory name, not the agent name it lacks', () => {
    renderBar({ sessionDirectoryName: 'dork-os', sessionTitle: 'Read the notes' });
    expect(screen.getByText('Read the notes')).toBeInTheDocument();
  });

  // --- Truncation (I2): everything yields, in order, and nothing yields to nothing ---
  //
  // jsdom paints nothing, so these assert the RULES that produce the ordering
  // rather than measured widths — the overlap itself was measured in a real
  // browser (see the branch report). What would make them red: putting
  // `shrink-0` back on the name or the chip, which is the exact regression that
  // let the identity paint straight through the origin chip.

  it('lets the title yield its width far sooner than the agent name', () => {
    renderBar({ agentName: 'dorkbot', agentVisual: VISUAL, sessionTitle: 'A very long title' });
    const title = screen.getByTestId('session-title');
    const name = screen.getByTestId('session-agent-name');
    expect(title).toHaveClass('truncate', 'shrink-[9999]');
    expect(name).toHaveClass('truncate', 'shrink');
    expect(name).not.toHaveClass('shrink-0');
  });

  it('gives the title and the name each a floor, so neither collapses to nothing', () => {
    renderBar({ agentName: 'dorkbot', agentVisual: VISUAL, sessionTitle: 'A very long title' });
    expect(screen.getByTestId('session-title')).toHaveClass('min-w-[3rem]');
    expect(screen.getByTestId('session-agent-name')).toHaveClass('min-w-[3.5rem]');
  });

  it('caps the origin chip and lets it shrink, so it cannot shove the identity', () => {
    renderBar({ agentName: 'dorkbot', agentVisual: VISUAL, origin: 'task' });
    const chip = screen.getByTestId('session-origin-chip');
    expect(chip).toHaveClass('min-w-0', 'max-w-[12rem]', 'shrink');
    expect(chip).not.toHaveClass('shrink-0');
  });

  it('keeps the full title reachable on hover when it is cut off', () => {
    const long = 'A title long enough that no bar in the product could show all of it at once';
    renderBar({ agentName: 'dorkbot', agentVisual: VISUAL, sessionTitle: long });
    expect(titleElement(long)).toHaveTextContent(long);
  });

  // --- I2 tier 2: the origin label collapses to its icon before the title dies ---

  it('renders both a labelled and an icon-only origin, gated on the bar container', () => {
    renderBar({ agentName: 'dorkbot', agentVisual: VISUAL, origin: 'task' });
    const chip = screen.getByTestId('session-origin-chip');
    // The words are hidden below the threshold; the bare mark is hidden above
    // it. Container queries do not resolve in jsdom, so what is pinned here is
    // that both arms exist and are gated on the SAME container — the mistake
    // that would ship an always-empty chip or a permanently doubled one.
    expect(chip.querySelector('.\\@max-md\\/bar\\:hidden')).not.toBeNull();
    expect(chip.querySelector('.hidden.\\@max-md\\/bar\\:inline-flex')).not.toBeNull();
  });

  it('lets the labelled arm shrink, so the chip’s cap actually caps it', () => {
    renderBar({ agentName: 'dorkbot', agentVisual: VISUAL, origin: 'task' });
    const labelled = screen
      .getByTestId('session-origin-chip')
      .querySelector('.\\@max-md\\/bar\\:hidden');
    // A flex item's automatic minimum size is its CONTENT. Without `min-w-0`
    // here the wrapper refuses to shrink, the truncate never engages, and the
    // label spills past the parent's `max-w` — measured at +182px, painting
    // over the fixed cluster. The cap only caps a box allowed to get smaller.
    expect(labelled).toHaveClass('min-w-0');
    expect(labelled?.querySelector('.truncate')).toHaveClass('min-w-0');
  });

  it('gives the collapsed origin its meaning back through an accessible label', () => {
    renderBar({
      agentName: 'dorkbot',
      agentVisual: VISUAL,
      origin: 'channel',
      originLabel: 'Telegram',
    });
    // Once the words are gone the icon is the only origin signal left, so it
    // has to carry the label itself. Without this the chip collapses to a
    // meaningless glyph on exactly the widths where it collapses.
    expect(screen.getByLabelText('Origin: Telegram')).toBeInTheDocument();
  });

  // --- Agent deleted mid-session (spec §5.3) ---

  it('holds the last-known agent when its record disappears mid-session', () => {
    const { rerender } = render(
      <BarHarness sessionId="s1" agentName="dorkbot" agentVisual={VISUAL} sessionTitle="Ship it">
        <SessionHeader />
      </BarHarness>
    );
    rerender(
      <BarHarness sessionId="s1" sessionDirectoryName="dork-os" sessionTitle="Ship it">
        <SessionHeader />
      </BarHarness>
    );
    // The conversation on screen is unchanged and every word in it is still
    // that agent's, so the bar keeps saying so rather than blinking over to a
    // folder icon and a directory name.
    expect(screen.getByText('dorkbot')).toBeInTheDocument();
    expect(screen.getByText(VISUAL.emoji)).toBeInTheDocument();
    expect(screen.queryByTestId('session-directory-mark')).not.toBeInTheDocument();
  });

  it('drops the held agent when you open a different session', () => {
    const { rerender } = render(
      <BarHarness sessionId="s1" agentName="dorkbot" agentVisual={VISUAL} sessionTitle="Ship it">
        <SessionHeader />
      </BarHarness>
    );
    rerender(
      <BarHarness sessionId="s2" sessionDirectoryName="dork-os" sessionTitle="Read the notes">
        <SessionHeader />
      </BarHarness>
    );
    // Holding across a session change would label a bare-directory conversation
    // with the previous conversation's agent — confidently, and wrongly.
    expect(screen.queryByText('dorkbot')).not.toBeInTheDocument();
    expect(screen.getByText('dork-os')).toBeInTheDocument();
    expect(screen.getByTestId('session-directory-mark')).toBeInTheDocument();
  });

  it('takes a rename immediately rather than holding the old name', () => {
    const renamed = { color: 'hsl(10 70% 55%)', emoji: '🦊' };
    const { rerender } = render(
      <BarHarness sessionId="s1" agentName="dorkbot" agentVisual={VISUAL} sessionTitle="Ship it">
        <SessionHeader />
      </BarHarness>
    );
    rerender(
      <BarHarness sessionId="s1" agentName="Scout" agentVisual={renamed} sessionTitle="Ship it">
        <SessionHeader />
      </BarHarness>
    );
    expect(screen.getByText('Scout')).toBeInTheDocument();
    expect(screen.queryByText('dorkbot')).not.toBeInTheDocument();
    expect(screen.getByText(renamed.emoji)).toBeInTheDocument();
  });

  // --- Origin chip (session-origin-legibility) ---

  it('shows a muted origin chip for a non-user session', () => {
    renderBar({
      agentName: 'dorkbot',
      agentVisual: VISUAL,
      origin: 'channel',
      originLabel: 'Telegram',
    });
    expect(screen.getByText('Telegram')).toBeInTheDocument();
  });

  it('falls back to the descriptor label when no originLabel is set', () => {
    renderBar({ agentName: 'dorkbot', agentVisual: VISUAL, origin: 'task' });
    expect(screen.getByText('Scheduled task')).toBeInTheDocument();
  });

  it('shows no origin chip for a user-origin session', () => {
    renderBar({ agentName: 'dorkbot', agentVisual: VISUAL, origin: 'user' });
    expect(screen.queryByLabelText(/^Origin:/)).not.toBeInTheDocument();
  });

  it('shows no origin chip when origin is absent', () => {
    renderBar({ agentName: 'dorkbot', agentVisual: VISUAL });
    expect(screen.queryByLabelText(/^Origin:/)).not.toBeInTheDocument();
  });
});
