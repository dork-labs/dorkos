/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { PipContent } from '@/layers/shared/model';
import { PipSheet } from '../ui/PipSheet';

// The real component renders here (the global test-setup motion mock strips
// animation/drag props to a plain portalled div). Drag/snap mechanics are
// browser-gate territory (task 1.3); these tests cover structure and wiring.

afterEach(cleanup);

const WIDGET: PipContent = { kind: 'widget', sessionId: 's1', title: 'Tic-Tac-Toe' };

describe('PipSheet', () => {
  it('renders the descriptor title and its content children', () => {
    render(
      <PipSheet content={WIDGET} onClose={vi.fn()} onMinimize={vi.fn()}>
        <div data-testid="pip-body">live board</div>
      </PipSheet>
    );
    expect(screen.getByText('Tic-Tac-Toe')).toBeInTheDocument();
    expect(screen.getByTestId('pip-body')).toHaveTextContent('live board');
  });

  it('exposes the sheet as a labelled complementary region (non-modal, like FloatingPanel)', () => {
    render(
      <PipSheet content={WIDGET} onClose={vi.fn()} onMinimize={vi.fn()}>
        <div />
      </PipSheet>
    );
    expect(screen.getByRole('complementary')).toHaveAttribute('aria-label', 'Tic-Tac-Toe');
  });

  it('calls onClose when the X button is clicked', () => {
    const onClose = vi.fn();
    render(
      <PipSheet content={WIDGET} onClose={onClose} onMinimize={vi.fn()}>
        <div />
      </PipSheet>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onMinimize (not onClose) when the Minimize chevron is clicked', () => {
    const onClose = vi.fn();
    const onMinimize = vi.fn();
    render(
      <PipSheet content={WIDGET} onClose={onClose} onMinimize={onMinimize}>
        <div />
      </PipSheet>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }));
    expect(onMinimize).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('never hides the rest of the app from assistive technology (vaul regression, Amendment 1)', () => {
    // vaul was rejected because its Radix Dialog ran fully modal and applied
    // aria-hidden="true" to #root while the sheet was open. The cockpit-native
    // sheet has no portal-modality machinery, so no element OUTSIDE the sheet
    // may carry aria-hidden / data-aria-hidden after it mounts. (Inside the
    // sheet, the decorative lucide icon legitimately hides itself — its button
    // carries the accessible name.)
    render(<div data-testid="app-root">the rest of the app</div>);
    render(
      <PipSheet content={WIDGET} onClose={vi.fn()} onMinimize={vi.fn()}>
        <div />
      </PipSheet>
    );
    const sheet = screen.getByRole('complementary');
    for (const el of document.querySelectorAll('[aria-hidden], [data-aria-hidden]')) {
      expect(sheet.contains(el)).toBe(true);
    }
    expect(screen.getByTestId('app-root')).not.toHaveAttribute('aria-hidden');
    expect(screen.getByTestId('app-root')).toBeVisible();
  });
});
