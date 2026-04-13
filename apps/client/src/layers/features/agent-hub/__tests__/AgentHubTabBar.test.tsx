/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useAgentHubStore } from '../model/agent-hub-store';
import { AgentHubTabBar } from '../ui/AgentHubTabBar';

const TAB_LABELS = ['Sessions', 'Config'];

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  useAgentHubStore.setState({ activeTab: 'sessions', agentPath: null });
});

describe('AgentHubTabBar', () => {
  it('renders both tab buttons', () => {
    render(<AgentHubTabBar />);
    for (const label of TAB_LABELS) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('renders a tablist with correct aria-label', () => {
    render(<AgentHubTabBar />);
    expect(screen.getByRole('tablist', { name: 'Agent hub tabs' })).toBeInTheDocument();
  });

  it('marks the active tab with aria-selected', () => {
    useAgentHubStore.setState({ activeTab: 'config' });
    render(<AgentHubTabBar />);

    expect(screen.getByText('Config').closest('button')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Sessions').closest('button')).toHaveAttribute(
      'aria-selected',
      'false'
    );
  });

  it('updates the store when a tab is clicked', () => {
    render(<AgentHubTabBar />);
    fireEvent.click(screen.getByText('Sessions'));
    expect(useAgentHubStore.getState().activeTab).toBe('sessions');
  });

  it('marks only the active tab with aria-selected=true', () => {
    useAgentHubStore.setState({ activeTab: 'sessions' });
    render(<AgentHubTabBar />);

    const buttons = screen.getAllByRole('tab');
    const selected = buttons.filter((btn) => btn.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveTextContent('Sessions');
  });
});
