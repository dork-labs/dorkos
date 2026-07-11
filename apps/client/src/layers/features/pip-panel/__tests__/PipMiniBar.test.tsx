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

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty('--pip-dock');
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
});
