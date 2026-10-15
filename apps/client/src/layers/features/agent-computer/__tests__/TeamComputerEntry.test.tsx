// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TeamComputerEntry } from '../ui/TeamComputerEntry';

const state = vi.hoisted(() => ({
  enabled: false,
  navigate: vi.fn(),
  setContext: vi.fn(),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => state.navigate }));
vi.mock('@/layers/entities/config', () => ({
  useExperimentEnabledState: (path: string) => ({
    enabled: path === 'computers.enabled' && state.enabled,
  }),
}));
vi.mock('@/layers/entities/session', () => ({ setSessionRouteContext: state.setContext }));
vi.mock('../ui/AgentComputerPanel', () => ({
  AgentComputerPanel: ({
    onOpenSession,
  }: {
    onOpenSession: (session: { id: string; cwd: string; runtime: string }) => void;
  }) => (
    <button
      onClick={() =>
        onOpenSession({
          id: 'guest-session',
          cwd: '/owned/computer-anchor',
          runtime: 'computer-opencode',
        })
      }
    >
      Chat
    </button>
  ),
}));

beforeEach(() => {
  state.enabled = false;
  state.navigate.mockReset();
  state.setContext.mockReset();
});

describe('TeamComputerEntry', () => {
  it('does not mount the computer while the experiment is off or loading', () => {
    render(<TeamComputerEntry />);
    expect(screen.queryByRole('button', { name: 'Chat' })).not.toBeInTheDocument();
  });

  it('opens exactly the server-issued session and keeps the anchor out of the URL', () => {
    state.enabled = true;
    render(<TeamComputerEntry />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    expect(state.setContext).toHaveBeenCalledWith('guest-session', {
      cwd: '/owned/computer-anchor',
      runtime: 'computer-opencode',
      draft: false,
    });
    expect(state.navigate).toHaveBeenCalledWith({
      to: '/session',
      search: { session: 'guest-session', runtime: 'computer-opencode', dir: undefined },
    });
  });
});
