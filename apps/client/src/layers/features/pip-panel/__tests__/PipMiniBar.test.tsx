/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { PipContent } from '@/layers/shared/model';
import { PipMiniBar } from '../ui/PipMiniBar';

// The real component renders here (the global test-setup motion mock strips
// animation props to a plain portalled div). Entry/exit motion is browser-gate
// territory; these tests cover structure, wiring, and the --pip-dock hook.

const HAD_VV = Object.prototype.hasOwnProperty.call(window, 'visualViewport');
const ORIGINAL_VV_DESCRIPTOR = Object.getOwnPropertyDescriptor(window, 'visualViewport');

/** Report a bottom inset by shrinking the visual viewport under innerHeight. */
function setKeyboardInset(px: number) {
  Object.defineProperty(window, 'visualViewport', {
    value: {
      height: window.innerHeight - px,
      offsetTop: 0,
      scale: 1, // unzoomed — the hook returns 0 under pinch-zoom (scale > 1)
      addEventListener() {},
      removeEventListener() {},
    },
    configurable: true,
  });
}

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty('--pip-dock');
  if (HAD_VV && ORIGINAL_VV_DESCRIPTOR) {
    Object.defineProperty(window, 'visualViewport', ORIGINAL_VV_DESCRIPTOR);
  } else {
    delete (window as { visualViewport?: unknown }).visualViewport;
  }
});

const WIDGET: PipContent = { kind: 'widget', sessionId: 's1', title: 'Tic-Tac-Toe' };

describe('PipMiniBar', () => {
  it('renders the descriptor title as a labelled complementary region', () => {
    render(<PipMiniBar content={WIDGET} onRestore={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('complementary')).toHaveAttribute('aria-label', 'Tic-Tac-Toe');
    expect(screen.getByText('Tic-Tac-Toe')).toBeInTheDocument();
  });

  it('calls onRestore (not onClose) when the restore region is tapped', () => {
    const onRestore = vi.fn();
    const onClose = vi.fn();
    render(<PipMiniBar content={WIDGET} onRestore={onRestore} onClose={onClose} />);
    // The restore region is the full-width button named by the title text.
    fireEvent.click(screen.getByRole('button', { name: /Tic-Tac-Toe/ }));
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls onClose when the X button is clicked', () => {
    const onRestore = vi.fn();
    const onClose = vi.fn();
    render(<PipMiniBar content={WIDGET} onRestore={onRestore} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onRestore).not.toHaveBeenCalled();
  });

  it('sets --pip-dock on the document root while mounted and removes it on unmount', () => {
    const { unmount } = render(
      <PipMiniBar content={WIDGET} onRestore={vi.fn()} onClose={vi.fn()} />
    );
    expect(document.documentElement.style.getPropertyValue('--pip-dock')).toBe('64px');

    unmount();
    expect(document.documentElement.style.getPropertyValue('--pip-dock')).toBe('');
  });

  /**
   * The `bottom` the component actually asked for, as written.
   *
   * Read off the style attribute rather than through `toHaveStyle`: the value is
   * a `max()` over a custom property, which has no computed answer without a
   * layout engine — jsdom has none, so the only honest question here is what the
   * component declared. What it RESOLVES to at 390×844 is
   * `tests/pip/mobile-pip-dock.spec.ts`'s job.
   */
  const declaredBottom = () =>
    (screen.getByRole('complementary') as HTMLElement).style.getPropertyValue('bottom');

  it('docks above the phone cockpit rather than on the bottom edge (DOR-1177)', () => {
    render(<PipMiniBar content={WIDGET} onRestore={vi.fn()} onClose={vi.fn()} />);
    // The variable the mobile cockpit publishes while its bar is on screen.
    // Absent — desktop, the Obsidian embed — the fallback is the bottom edge the
    // bar has always sat on.
    expect(declaredBottom()).toBe('max(var(--mobile-tab-dock, 0px), 0px)');
  });

  it('lifts by the visual-viewport bottom inset when the keyboard is open', () => {
    setKeyboardInset(300);
    render(<PipMiniBar content={WIDGET} onRestore={vi.fn()} onClose={vi.fn()} />);
    // `max`, not a sum: a raised keyboard already covers the tab bar, so adding
    // the two would float the bar a tab bar's height clear of the keyboard.
    expect(declaredBottom()).toBe('max(var(--mobile-tab-dock, 0px), 300px)');
  });
});
