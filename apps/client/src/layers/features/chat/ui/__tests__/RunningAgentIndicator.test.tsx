/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { RunningAgentIndicator } from '../RunningAgentIndicator';
import type { RunningAgent } from '../../model/use-running-subagents';
import { AGENT_COLORS } from '../../model/use-running-subagents';

afterEach(cleanup);

function makeRunningAgent(overrides: Partial<RunningAgent> = {}): RunningAgent {
  return {
    taskId: `task-${Math.random().toString(36).slice(2)}`,
    description: 'Test agent task',
    status: 'running',
    color: AGENT_COLORS[0],
    toolUses: 5,
    lastToolName: 'Read',
    durationMs: 12000,
    ...overrides,
  };
}

describe('RunningAgentIndicator', () => {
  it('renders nothing when agents array is empty', () => {
    const { container } = render(<RunningAgentIndicator agents={[]} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(container.innerHTML).toBe('');
  });

  it('renders agent figures for each running agent', () => {
    const agents = [
      makeRunningAgent({ description: 'Agent alpha', color: AGENT_COLORS[0] }),
      makeRunningAgent({ description: 'Agent beta', color: AGENT_COLORS[1] }),
      makeRunningAgent({ description: 'Agent gamma', color: AGENT_COLORS[2] }),
    ];

    render(<RunningAgentIndicator agents={agents} />);

    const svgs = screen.getAllByLabelText(/^Agent (alpha|beta|gamma)$/);
    expect(svgs).toHaveLength(3);
  });

  it('shows overflow badge when more than 4 agents', () => {
    const agents = Array.from({ length: 6 }, (_, i) =>
      makeRunningAgent({
        description: `Agent ${i}`,
        color: AGENT_COLORS[i % AGENT_COLORS.length],
      })
    );

    render(<RunningAgentIndicator agents={agents} />);

    // Only 4 SVG figures should render
    const svgs = screen.getAllByLabelText(/^Agent \d$/);
    expect(svgs).toHaveLength(4);

    // Overflow badge shows +2
    expect(screen.getByText('+2')).toBeInTheDocument();
  });

  it('displays aggregate stats in the label', () => {
    const agents = [
      makeRunningAgent({ toolUses: 4, durationMs: 12000 }),
      makeRunningAgent({ toolUses: 5, durationMs: 34000 }),
      makeRunningAgent({ toolUses: 3, durationMs: 8000 }),
    ];

    render(<RunningAgentIndicator agents={agents} />);

    // Count label — the outer div has an aria-label summarizing the count
    expect(screen.getByLabelText('3 background agents running')).toBeInTheDocument();
    expect(screen.getByText(/agents running/)).toBeInTheDocument();

    // Stats: totalTools = 12, maxDuration = 34s
    // The aggregate stats span contains "12 tools · 34s"
    expect(screen.getByText(/12 tools/)).toBeInTheDocument();
    // Use getAllByText since per-agent tooltips also show "34s"
    const durationMatches = screen.getAllByText(/34s/);
    expect(durationMatches.length).toBeGreaterThanOrEqual(1);
  });

  it('shows tooltip content on agent description', () => {
    const agents = [makeRunningAgent({ description: 'Search codebase' })];

    render(<RunningAgentIndicator agents={agents} />);

    // The description appears in the SVG aria-label and in the tooltip text
    expect(screen.getByLabelText('Search codebase')).toBeInTheDocument();
    // The tooltip div also contains the description text
    expect(screen.getByText('Search codebase')).toBeInTheDocument();
  });
});
