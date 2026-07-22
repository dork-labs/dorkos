/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('motion/react', () => ({
  motion: {
    div: 'div',
  },
  useReducedMotion: () => false,
}));

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

const mockAgentCreationOpen = vi.fn();
const mockOpenSettingsToTab = vi.fn();
vi.mock('@/layers/shared/model', () => ({
  useAgentCreationStore: { getState: () => ({ open: mockAgentCreationOpen }) },
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ openSettingsToTab: mockOpenSettingsToTab }),
}));

import { ProgressCard } from '../ui/ProgressCard';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProgressCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the Getting started heading and three deep-link rows', () => {
    render(<ProgressCard onDismiss={vi.fn()} />);

    expect(screen.getByText('Getting started')).toBeTruthy();
    expect(screen.getByText('Create an agent')).toBeTruthy();
    expect(screen.getByText('Schedule a task')).toBeTruthy();
    expect(screen.getByText('Add more agents')).toBeTruthy();
  });

  it('"Create an agent" opens the agent creation dialog', () => {
    render(<ProgressCard onDismiss={vi.fn()} />);

    fireEvent.click(screen.getByText('Create an agent'));

    expect(mockAgentCreationOpen).toHaveBeenCalledWith('new');
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('"Schedule a task" navigates to /tasks', () => {
    render(<ProgressCard onDismiss={vi.fn()} />);

    fireEvent.click(screen.getByText('Schedule a task'));

    expect(mockNavigate).toHaveBeenCalledWith({ to: '/tasks' });
  });

  it('"Add more agents" opens Settings on the runtimes tab', () => {
    render(<ProgressCard onDismiss={vi.fn()} />);

    fireEvent.click(screen.getByText('Add more agents'));

    expect(mockOpenSettingsToTab).toHaveBeenCalledWith('runtimes');
  });

  it('dismiss button calls onDismiss', () => {
    const onDismiss = vi.fn();

    render(<ProgressCard onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss getting started' }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
