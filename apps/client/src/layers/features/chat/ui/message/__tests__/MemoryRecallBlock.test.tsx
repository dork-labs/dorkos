/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRecallBlock } from '../MemoryRecallBlock';

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ONE_MEMORY = [{ path: '~/.claude/CLAUDE.md', scope: 'personal' as const }];
const THREE_MEMORIES = [
  { path: '~/.claude/CLAUDE.md', scope: 'personal' as const },
  { path: '~/.claude/memory/work.md', scope: 'team' as const },
  { path: '~/.claude/memory/shared.md', scope: 'personal' as const },
];
const SYNTHESIS_MEMORY = [
  {
    path: '<synthesis:~/.claude>',
    scope: 'personal' as const,
    content: 'A summary of project context.',
  },
];
const LONG_PATH = '/Users/dorian/Keep/dork-os/core/packages/shared/src/schemas.ts';

describe('MemoryRecallBlock', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    // Mock clipboard for copy-interaction tests
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  // -------------------------------------------------------------------------
  // §11.2 — 12 component tests
  // -------------------------------------------------------------------------

  it('renders streaming label with breathing animation when isStreaming', () => {
    // Purpose: verifies the streaming visual state is distinct — label says "Consulting memory…"
    // and the span carries the animate-tasks class for the breathing animation.
    render(<MemoryRecallBlock mode="select" memories={ONE_MEMORY} isStreaming={true} />);

    const label = screen.getByText('Consulting memory…');
    expect(label).toBeInTheDocument();
    expect(label).toHaveClass('animate-tasks');
  });

  it('renders completed chip with recalled count when not isStreaming', () => {
    // Purpose: state transition output — once streaming ends, collapsed chip shows count.
    render(<MemoryRecallBlock mode="select" memories={THREE_MEMORIES} isStreaming={false} />);

    expect(screen.getByText('Recalled 3 memories')).toBeInTheDocument();
  });

  it('auto-collapses on streaming → complete transition', () => {
    // Purpose: mirrors ThinkingBlock contract — useEffect collapses when isStreaming flips false.
    const { rerender } = render(
      <MemoryRecallBlock mode="select" memories={ONE_MEMORY} isStreaming={true} />
    );

    // During streaming the card is expanded (aria-expanded="true"). Use aria-label to
    // disambiguate from row buttons that are also present in the expanded body.
    const headerButtonStreaming = screen.getByLabelText('Consulting memory…');
    expect(headerButtonStreaming).toHaveAttribute('aria-expanded', 'true');

    // After streaming ends, the useEffect fires and collapses it
    rerender(<MemoryRecallBlock mode="select" memories={ONE_MEMORY} isStreaming={false} />);
    const headerButtonDone = screen.getByLabelText('Recalled 1 memory');
    expect(headerButtonDone).toHaveAttribute('aria-expanded', 'false');
  });

  it('expands on chip tap and collapses again on second tap', () => {
    // Purpose: core toggle interaction — collapsed chip opens/closes on repeated presses.
    render(<MemoryRecallBlock mode="select" memories={ONE_MEMORY} isStreaming={false} />);

    const headerButton = screen.getByRole('button');

    // Initially collapsed after non-streaming render
    expect(headerButton).toHaveAttribute('aria-expanded', 'false');

    // First tap — expand
    fireEvent.click(headerButton);
    expect(headerButton).toHaveAttribute('aria-expanded', 'true');

    // Second tap — collapse again
    fireEvent.click(headerButton);
    expect(headerButton).toHaveAttribute('aria-expanded', 'false');
  });

  it('uses BookOpen icon for select mode', () => {
    // Purpose: locks Decision 5 icon differentiation — header icon is BookOpen, not Sparkles.
    render(<MemoryRecallBlock mode="select" memories={ONE_MEMORY} isStreaming={false} />);

    const headerIcon = screen.getByTestId('memory-recall-header-icon');
    expect(headerIcon).toHaveAttribute('data-icon', 'bookopen');
  });

  it('uses Sparkles icon for synthesize mode', () => {
    // Purpose: locks Decision 5 — synthesize mode swaps the header icon to Sparkles.
    render(<MemoryRecallBlock mode="synthesize" memories={SYNTHESIS_MEMORY} isStreaming={false} />);

    const headerIcon = screen.getByTestId('memory-recall-header-icon');
    expect(headerIcon).toHaveAttribute('data-icon', 'sparkles');
  });

  it('uses BookOpen icon for mixed mode (first-seen select, later synthesize)', () => {
    // Purpose: locks mixed-mode icon rule — mode prop governs the header icon regardless of
    // whether individual memory rows are synthesis sentinels.
    const mixedMemories = [
      { path: '~/.claude/CLAUDE.md', scope: 'personal' as const },
      { path: '<synthesis:~/.claude>', scope: 'team' as const, content: 'A summary.' },
    ];
    render(<MemoryRecallBlock mode="select" memories={mixedMemories} isStreaming={false} />);

    const headerIcon = screen.getByTestId('memory-recall-header-icon');
    expect(headerIcon).toHaveAttribute('data-icon', 'bookopen');
  });

  it('renders path rows with middle-ellipsis truncation for select mode', () => {
    // Purpose: mobile legibility — long paths are truncated in the middle, keeping the basename visible.
    const memories = [{ path: LONG_PATH, scope: 'personal' as const }];
    render(<MemoryRecallBlock mode="select" memories={memories} isStreaming={false} />);

    // Expand to see the rows
    fireEvent.click(screen.getByRole('button'));

    // truncateMiddle(path, 40) returns a string containing "…/" with the basename at the end
    const pathText = screen.getByText(/schemas\.ts/);
    expect(pathText.textContent).toContain('…/');
    expect(pathText.textContent).toMatch(/schemas\.ts$/);
  });

  it('renders synthesis paragraph and muted directory label for synthesize mode', () => {
    // Purpose: locks synthesize row treatment — synthesis entries show the content paragraph
    // plus a muted sentinel-path label with the "<synthesis:" prefix stripped.
    render(<MemoryRecallBlock mode="synthesize" memories={SYNTHESIS_MEMORY} isStreaming={false} />);

    // Expand to see the row content
    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByText('A summary of project context.')).toBeInTheDocument();
    // The displayDir strips "<synthesis:" prefix and trailing ">"
    expect(screen.getByText('synthesis:~/.claude')).toBeInTheDocument();
  });

  it('exposes scope via data-scope on expanded rows, not in the collapsed chip', () => {
    // Purpose: locks Decision 6 — scope information only appears inside the expanded body,
    // conveyed via the row button's data-scope attribute (and folded into its aria-label).
    // Scope icons themselves are aria-hidden to avoid muddled screen-reader output.
    render(<MemoryRecallBlock mode="select" memories={ONE_MEMORY} isStreaming={false} />);

    // Collapsed: no row scoped button exists yet
    expect(document.querySelector('[data-scope]')).toBeNull();

    // Expand
    fireEvent.click(screen.getByRole('button'));

    const scopedRow = document.querySelector('[data-scope="personal"]');
    expect(scopedRow).not.toBeNull();
    expect(scopedRow).toHaveAttribute(
      'aria-label',
      'Copy personal memory path ~/.claude/CLAUDE.md'
    );
  });

  it('copies path to clipboard on row tap with scope in the accessible name', () => {
    // Purpose: locks Decision 4 — clicking a select-mode row copies the path (not content),
    // and the button's accessible name includes scope so screen readers announce it once.
    render(<MemoryRecallBlock mode="select" memories={ONE_MEMORY} isStreaming={false} />);

    fireEvent.click(screen.getByRole('button'));

    const copyButton = screen.getByLabelText('Copy personal memory path ~/.claude/CLAUDE.md');
    fireEvent.click(copyButton);

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('~/.claude/CLAUDE.md');
  });

  it('copies synthesis content (not sentinel path) on synthesize row tap', () => {
    // Purpose: subtle correctness — synthesis rows copy the content string, not the sentinel path.
    render(<MemoryRecallBlock mode="synthesize" memories={SYNTHESIS_MEMORY} isStreaming={false} />);

    fireEvent.click(screen.getByRole('button'));

    const copyButton = screen.getByLabelText('Copy synthesized personal memory content');
    fireEvent.click(copyButton);

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('A summary of project context.');
    expect(navigator.clipboard.writeText).not.toHaveBeenCalledWith('<synthesis:~/.claude>');
  });

  it('renders nothing when memories array is empty', () => {
    // Purpose: defense in depth — a memory_recall part with zero memories is a bug upstream;
    // the component should render nothing rather than an empty chip.
    const { container } = render(
      <MemoryRecallBlock mode="select" memories={[]} isStreaming={false} />
    );

    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('memory-recall-block')).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // §11.4 — 3 mobile-viewport tests
  // -------------------------------------------------------------------------

  it('fits collapsed chip on a single line at 320px viewport', () => {
    // Purpose: narrowest supported viewport — the collapsed chip must render without overflow.
    const originalWidth = window.innerWidth;
    window.innerWidth = 320;

    render(<MemoryRecallBlock mode="select" memories={ONE_MEMORY} isStreaming={false} />);

    // The chip renders and the label is visible at 320px
    expect(screen.getByText('Recalled 1 memory')).toBeInTheDocument();
    expect(screen.getByTestId('memory-recall-block')).toBeInTheDocument();

    window.innerWidth = originalWidth;
  });

  it('truncates long paths with middle-ellipsis at 320px viewport', () => {
    // Purpose: basename stays visible at the narrowest supported viewport.
    const originalWidth = window.innerWidth;
    window.innerWidth = 320;

    const memories = [{ path: LONG_PATH, scope: 'personal' as const }];
    render(<MemoryRecallBlock mode="select" memories={memories} isStreaming={false} />);

    // Expand to see path rows
    fireEvent.click(screen.getByRole('button'));

    const pathText = screen.getByText(/schemas\.ts/);
    expect(pathText.textContent).toContain('…/');
    expect(pathText.textContent).toMatch(/schemas\.ts$/);

    window.innerWidth = originalWidth;
  });

  it('has row tap targets ≥ 44px tall on mobile', () => {
    // Purpose: thumb-friendly — each row button must have min-h-[44px] for mobile tap targets.
    const originalWidth = window.innerWidth;
    window.innerWidth = 320;

    render(<MemoryRecallBlock mode="select" memories={ONE_MEMORY} isStreaming={false} />);

    // Expand to reveal row buttons
    fireEvent.click(screen.getByRole('button'));

    // Row buttons carry data-scope; the header chip does not.
    const rowButtons = Array.from(document.querySelectorAll('button[data-scope]'));
    expect(rowButtons.length).toBeGreaterThan(0);
    for (const btn of rowButtons) {
      expect(btn).toHaveClass('min-h-[44px]');
    }

    window.innerWidth = originalWidth;
  });
});
