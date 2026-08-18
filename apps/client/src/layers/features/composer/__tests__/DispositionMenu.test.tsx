// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';

// Render the menu's parts inline rather than through the real Radix/Drawer
// portal, so the rows are always in the tree and the "which rows exist" question
// — the whole point of hidden-not-disabled — is answerable without opening
// anything. (Same approach as EntryRunWithMenu's test.)
vi.mock('@/layers/shared/ui', () => ({
  ResponsiveDropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResponsiveDropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  ResponsiveDropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ResponsiveDropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children: ReactNode;
    onSelect?: () => void;
  }) => (
    <button type="button" onClick={onSelect}>
      {children}
    </button>
  ),
}));

const { DispositionMenu } = await import('../ui/DispositionMenu');

afterEach(() => cleanup());

describe('DispositionMenu — hidden, not disabled', () => {
  it('renders nothing when the runtime offers neither Steer nor Add context', () => {
    const { container } = render(<DispositionMenu />);
    // A queue-only runtime (codex/opencode) gets no caret at all — the composer
    // collapses to a single Queue button rather than a dead menu.
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('button', { name: 'More ways to send' })).toBeNull();
  });

  it('offers only Steer when the runtime can steer but not stage', () => {
    render(<DispositionMenu onSteer={() => {}} />);
    expect(screen.getByRole('button', { name: 'More ways to send' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Steer' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add context' })).toBeNull();
  });

  it('offers only Add context when the runtime can stage but not steer', () => {
    render(<DispositionMenu onStage={() => {}} />);
    expect(screen.getByRole('button', { name: 'Add context' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Steer' })).toBeNull();
  });

  it('routes each row to its own callback', () => {
    const onSteer = vi.fn();
    const onStage = vi.fn();
    render(<DispositionMenu onSteer={onSteer} onStage={onStage} />);

    fireEvent.click(screen.getByRole('button', { name: 'Steer' }));
    expect(onSteer).toHaveBeenCalledTimes(1);
    expect(onStage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Add context' }));
    expect(onStage).toHaveBeenCalledTimes(1);
    expect(onSteer).toHaveBeenCalledTimes(1);
  });
});
