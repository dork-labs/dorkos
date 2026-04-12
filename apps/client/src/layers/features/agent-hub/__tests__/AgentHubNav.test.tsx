/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useAgentHubStore } from '../model/agent-hub-store';
import { AgentHubNav } from '../ui/AgentHubNav';

const TAB_LABELS = ['Overview', 'Personality', 'Sessions', 'Channels', 'Tasks', 'Tools'];

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  useAgentHubStore.setState({ activeTab: 'overview', agentPath: null });
});

describe('AgentHubNav', () => {
  it('renders all six tab buttons', () => {
    render(<AgentHubNav />);
    for (const label of TAB_LABELS) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('renders the nav landmark with correct aria-label', () => {
    render(<AgentHubNav />);
    expect(screen.getByLabelText('Agent hub navigation')).toBeInTheDocument();
  });

  it('highlights the active tab with aria-current', () => {
    useAgentHubStore.setState({ activeTab: 'personality' });
    render(<AgentHubNav />);

    expect(screen.getByText('Personality').closest('button')).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(screen.getByText('Overview').closest('button')).not.toHaveAttribute('aria-current');
  });

  it('updates the store when a tab is clicked', () => {
    render(<AgentHubNav />);
    fireEvent.click(screen.getByText('Channels'));
    expect(useAgentHubStore.getState().activeTab).toBe('channels');
  });

  it('marks only the active tab with aria-current', () => {
    useAgentHubStore.setState({ activeTab: 'tools' });
    render(<AgentHubNav />);

    const buttons = screen.getAllByRole('button');
    const withAriaCurrent = buttons.filter((btn) => btn.hasAttribute('aria-current'));
    expect(withAriaCurrent).toHaveLength(1);
    expect(withAriaCurrent[0]).toHaveTextContent('Tools');
  });
});
