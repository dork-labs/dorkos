/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SystemStatusRow } from '../ui/SystemStatusRow';
import type { SubsystemStatus } from '../model/use-subsystem-status';

// Render motion.* as plain host elements.
vi.mock('motion/react', () => ({
  motion: new Proxy(
    {},
    {
      get:
        (_t, tag: string) =>
        ({ children, ...props }: { children?: React.ReactNode }) =>
          React.createElement(tag, props, children),
    }
  ),
}));

let mockStatus: SubsystemStatus;
vi.mock('../model/use-subsystem-status', () => ({
  useSubsystemStatus: () => mockStatus,
}));

let mockActivity: number[] = [];
vi.mock('../model/use-session-activity', () => ({
  useSessionActivity: () => mockActivity,
}));

const mockTasksOpen = vi.fn();
const mockRelayOpen = vi.fn();
vi.mock('@/layers/shared/model', () => ({
  useTasksDeepLink: () => ({ open: mockTasksOpen }),
  useRelayDeepLink: () => ({ open: mockRelayOpen }),
}));

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mockNavigate }));

function button(text: string): HTMLButtonElement {
  return screen.getByText(text).closest('button') as HTMLButtonElement;
}

describe('SystemStatusRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActivity = [1, 2, 0, 0, 0, 0, 0];
    mockStatus = {
      tasks: { enabled: true, scheduleCount: 3, nextRunIn: '47m', failedRunCount: 0 },
      relay: { enabled: true, adapterCount: 1, connectedNames: ['telegram'], deadLetterCount: 0 },
      mesh: { totalAgents: 2, offlineCount: 0 },
    };
  });

  afterEach(() => cleanup());

  it('reads in outcomes, not raw metrics', () => {
    render(<SystemStatusRow />);
    expect(screen.getByText('3 scheduled')).toBeInTheDocument();
    expect(screen.getByText('Next run in 47m')).toBeInTheDocument();
    expect(screen.getByText('Connected to Telegram')).toBeInTheDocument();
    expect(screen.getByText('2 agents ready')).toBeInTheDocument();
    expect(screen.getByText('3 runs this week')).toBeInTheDocument();
    // No raw "1 adapter" primary line anywhere.
    expect(screen.queryByText(/\badapter(s)?\b/)).not.toBeInTheDocument();
  });

  it('reads the empty shapes in outcomes', () => {
    mockStatus = {
      tasks: { enabled: true, scheduleCount: 0, nextRunIn: null, failedRunCount: 0 },
      relay: { enabled: true, adapterCount: 0, connectedNames: [], deadLetterCount: 0 },
      mesh: { totalAgents: 1, offlineCount: 0 },
    };
    mockActivity = [0, 0, 0, 0, 0, 0, 0];
    render(<SystemStatusRow />);
    expect(screen.getByText('Nothing scheduled yet')).toBeInTheDocument();
    expect(screen.getByText('No channels connected yet')).toBeInTheDocument();
    expect(screen.getByText('1 agent ready')).toBeInTheDocument();
    expect(screen.getByText('Quiet this week')).toBeInTheDocument();
  });

  it('keeps the subsystem deep-links unchanged', () => {
    render(<SystemStatusRow />);

    fireEvent.click(button('3 scheduled'));
    expect(mockTasksOpen).toHaveBeenCalledTimes(1);

    fireEvent.click(button('Connected to Telegram'));
    expect(mockRelayOpen).toHaveBeenCalledTimes(1);

    fireEvent.click(button('2 agents ready'));
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/agents', search: { view: 'topology' } });
  });
});
