// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('motion/react', () => ({
  motion: {
    div: ({ children, ...props }: Record<string, unknown>) => (
      <div data-testid="motion-div" {...props}>
        {children as React.ReactNode}
      </div>
    ),
  },
}));

import { DesktopUpdateCard } from '../DesktopUpdateCard';

describe('DesktopUpdateCard', () => {
  afterEach(() => {
    cleanup();
  });

  it('never shows the npm update command (that is the web card only)', () => {
    render(
      <DesktopUpdateCard status={{ state: 'downloaded', version: '2.0.0' }} onRestart={vi.fn()} />
    );

    expect(screen.queryByText(/npm update/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/copy update command/i)).not.toBeInTheDocument();
  });

  it('shows a restart affordance when an update is downloaded', () => {
    render(
      <DesktopUpdateCard status={{ state: 'downloaded', version: '2.0.0' }} onRestart={vi.fn()} />
    );

    expect(screen.getByText(/Update ready — v2\.0\.0/)).toBeInTheDocument();
    expect(screen.getByText('Restart to finish updating')).toBeInTheDocument();
    expect(screen.getByLabelText('Restart to install the update')).toBeInTheDocument();
  });

  it('calls onRestart when the restart button is clicked', () => {
    const onRestart = vi.fn();
    render(
      <DesktopUpdateCard status={{ state: 'downloaded', version: '2.0.0' }} onRestart={onRestart} />
    );

    fireEvent.click(screen.getByLabelText('Restart to install the update'));
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it('uses amber accent styling once the update is ready', () => {
    const { container } = render(
      <DesktopUpdateCard status={{ state: 'downloaded', version: '2.0.0' }} onRestart={vi.fn()} />
    );

    const card = container.querySelector('[data-testid="motion-div"]');
    expect(card?.className).toContain('border-amber-500/20');
    expect(card?.className).toContain('bg-amber-500/5');
  });

  it('shows a subtle downloading state with no restart button', () => {
    render(
      <DesktopUpdateCard status={{ state: 'downloading', percent: 40 }} onRestart={vi.fn()} />
    );

    expect(screen.getByText('Downloading update…')).toBeInTheDocument();
    expect(screen.queryByLabelText('Restart to install the update')).not.toBeInTheDocument();

    const card = screen.getByTestId('motion-div');
    expect(card.className).toContain('border-border');
    expect(card.className).toContain('bg-muted/50');
  });
});
