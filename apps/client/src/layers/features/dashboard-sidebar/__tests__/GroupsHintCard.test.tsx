// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { GroupsHintCard } from '../ui/GroupsHintCard';

describe('GroupsHintCard', () => {
  afterEach(() => cleanup());

  it('renders the heading, how-to, and both actions', () => {
    render(<GroupsHintCard onNewGroup={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText('Group your agents')).toBeInTheDocument();
    expect(screen.getByText(/Sort your agents into named groups/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New group' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss grouping tip' })).toBeInTheDocument();
  });

  it('opens the create flow via the CTA', () => {
    const onNewGroup = vi.fn();
    render(<GroupsHintCard onNewGroup={onNewGroup} onDismiss={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'New group' }));
    expect(onNewGroup).toHaveBeenCalledTimes(1);
  });

  it('dismisses via the X', () => {
    const onDismiss = vi.fn();
    render(<GroupsHintCard onNewGroup={() => {}} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss grouping tip' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('exposes keyboard-focusable actions with focus-visible rings', () => {
    render(<GroupsHintCard onNewGroup={() => {}} onDismiss={() => {}} />);
    const cta = screen.getByRole('button', { name: 'New group' });
    const dismiss = screen.getByRole('button', { name: 'Dismiss grouping tip' });
    cta.focus();
    expect(cta).toHaveFocus();
    expect(cta.className).toContain('focus-visible:ring-2');
    expect(dismiss.className).toContain('focus-visible:ring-2');
  });
});
