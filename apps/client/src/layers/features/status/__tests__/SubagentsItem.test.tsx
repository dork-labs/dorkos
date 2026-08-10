// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Radix's Tooltip needs a provider and a hover to open. Pass both trigger and
// content straight through so the copy under test is assertable inline.
vi.mock('@/layers/shared/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/ui')>();
  const Pass = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  const PassChild = ({ children }: { children: React.ReactNode; asChild?: boolean }) => (
    <>{children}</>
  );
  return { ...actual, Tooltip: Pass, TooltipTrigger: PassChild, TooltipContent: Pass };
});

import { SubagentsItem } from '../ui/SubagentsItem';
import type { ActiveSubagent } from '../model/session-diagnostics';

const ROW: ActiveSubagent = {
  taskId: 'bt1',
  status: 'running',
  description: 'Run the test suite',
  toolUses: 4,
  lastToolName: 'Bash',
};

afterEach(cleanup);

describe('SubagentsItem', () => {
  // During a turn the count is work happening alongside the agent, and saying so
  // would be noise: nothing about a busy session needs explaining.
  it('says nothing extra while the agent is still talking', () => {
    render(<SubagentsItem count={1} running={[ROW]} waiting={false} />);

    expect(screen.getByLabelText('1 subagent running')).toBeInTheDocument();
    expect(screen.queryByText(/background/i)).not.toBeInTheDocument();
    expect(screen.getByText('Run the test suite')).toBeInTheDocument();
  });

  // The row is `aria-live="polite"`, so re-wording the same fact when the turn
  // ends would announce a change to a screen reader that nothing changed for.
  // One phrasing; only the number in it moves.
  it('keeps one accessible phrasing across the turn boundary', () => {
    const { rerender } = render(<SubagentsItem count={2} running={[ROW]} waiting={false} />);
    expect(screen.getByLabelText('2 subagents running')).toBeInTheDocument();

    rerender(<SubagentsItem count={2} running={[ROW]} waiting />);
    expect(screen.getByLabelText('2 subagents running')).toBeInTheDocument();

    rerender(<SubagentsItem count={1} running={[ROW]} waiting />);
    expect(screen.getByLabelText('1 subagent running')).toBeInTheDocument();
  });

  // DOR-1100: the same number after the turn closes is the reason the session
  // looks finished and is not, so this is the one moment it earns a sentence.
  it('explains the wait once the agent has stopped talking', () => {
    render(<SubagentsItem count={2} running={[ROW]} waiting />);

    expect(screen.getByLabelText('2 subagents running')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Still working in the background. The agent picks up again when they finish.'
      )
    ).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  // The count outlives the rows, so it must never be capped by them: the drawn
  // number is the server's, and the tooltip owns up to what it cannot name.
  it('draws the server count even when the turn can name none of them', () => {
    render(<SubagentsItem count={3} running={[]} waiting />);

    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('3 tasks from earlier')).toBeInTheDocument();
  });

  it('owns up to the ones it cannot name beside the ones it can', () => {
    render(<SubagentsItem count={3} running={[ROW]} waiting />);

    expect(screen.getByText('Run the test suite')).toBeInTheDocument();
    expect(screen.getByText('and 2 more')).toBeInTheDocument();
  });
});
