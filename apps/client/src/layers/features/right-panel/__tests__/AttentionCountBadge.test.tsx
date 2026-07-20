/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Strip motion props so the pill renders as a plain span in jsdom.
vi.mock('motion/react', () => ({
  motion: {
    span: ({
      children,
      initial: _i,
      animate: _a,
      transition: _t,
      ...rest
    }: React.PropsWithChildren<Record<string, unknown>>) => (
      <span {...(rest as React.HTMLAttributes<HTMLSpanElement>)}>{children}</span>
    ),
  },
}));

import { AttentionCountBadge } from '../ui/AttentionCountBadge';

const BADGE = 'right-panel-attention-badge';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AttentionCountBadge', () => {
  it('renders nothing at zero — no decoration without signal', () => {
    render(<AttentionCountBadge count={0} />);
    expect(screen.queryByTestId(BADGE)).not.toBeInTheDocument();
  });

  it('renders nothing for a negative count (defensive)', () => {
    render(<AttentionCountBadge count={-1} />);
    expect(screen.queryByTestId(BADGE)).not.toBeInTheDocument();
  });

  it('shows the exact count from 1 through the cap', () => {
    render(<AttentionCountBadge count={3} />);
    expect(screen.getByTestId(BADGE)).toHaveTextContent('3');
  });

  it('shows the raw count at the cap boundary (9)', () => {
    render(<AttentionCountBadge count={9} />);
    expect(screen.getByTestId(BADGE)).toHaveTextContent('9');
  });

  it('caps the display at "9+" beyond the boundary', () => {
    render(<AttentionCountBadge count={10} />);
    expect(screen.getByTestId(BADGE)).toHaveTextContent('9+');
  });

  it('caps a large backlog at "9+" too', () => {
    render(<AttentionCountBadge count={250} />);
    expect(screen.getByTestId(BADGE)).toHaveTextContent('9+');
  });

  it('is purely visual (aria-hidden) — the accessible count lives on the toggle', () => {
    render(<AttentionCountBadge count={3} />);
    expect(screen.getByTestId(BADGE)).toHaveAttribute('aria-hidden');
  });
});
