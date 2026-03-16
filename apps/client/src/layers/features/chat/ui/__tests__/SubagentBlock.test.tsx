// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SubagentBlock } from '../SubagentBlock';
import type { SubagentPart } from '@dorkos/shared/types';

afterEach(() => {
  cleanup();
});

const basePart: SubagentPart = {
  type: 'subagent',
  taskId: 'task-1',
  description: 'Run code analysis',
  status: 'running',
};

describe('SubagentBlock', () => {
  it('renders the subagent description', () => {
    render(<SubagentBlock part={basePart} />);
    expect(screen.getByText('Run code analysis')).toBeDefined();
  });

  it('renders with data-testid and data attributes', () => {
    render(<SubagentBlock part={basePart} />);
    const block = screen.getByTestId('subagent-block');
    expect(block).toBeDefined();
    expect(block.getAttribute('data-task-id')).toBe('task-1');
    expect(block.getAttribute('data-status')).toBe('running');
  });

  it('sets aria-label on the button', () => {
    render(<SubagentBlock part={basePart} />);
    const button = screen.getByRole('button');
    expect(button.getAttribute('aria-label')).toBe('Subagent: Run code analysis');
  });

  it('does not show expand chevron when there is no expandable content', () => {
    render(<SubagentBlock part={basePart} />);
    // No toolUses, durationMs, summary, or lastToolName — chevron should be absent
    // aria-expanded is undefined when not expandable
    const button = screen.getByRole('button');
    expect(button.getAttribute('aria-expanded')).toBeNull();
  });

  it('shows tool summary when toolUses is provided', () => {
    render(<SubagentBlock part={{ ...basePart, toolUses: 3 }} />);
    expect(screen.getByText('3 tool calls')).toBeDefined();
  });

  it('shows singular "tool call" for toolUses of 1', () => {
    render(<SubagentBlock part={{ ...basePart, toolUses: 1 }} />);
    expect(screen.getByText('1 tool call')).toBeDefined();
  });

  it('shows duration in seconds when durationMs is provided', () => {
    render(<SubagentBlock part={{ ...basePart, durationMs: 5000 }} />);
    expect(screen.getByText('5s')).toBeDefined();
  });

  it('shows "<1s" for sub-second duration', () => {
    render(<SubagentBlock part={{ ...basePart, durationMs: 500 }} />);
    expect(screen.getByText('<1s')).toBeDefined();
  });

  it('shows duration in minutes and seconds for longer durations', () => {
    render(<SubagentBlock part={{ ...basePart, durationMs: 90000 }} />);
    expect(screen.getByText('1m 30s')).toBeDefined();
  });

  it('shows combined tool calls and duration in summary', () => {
    render(<SubagentBlock part={{ ...basePart, toolUses: 2, durationMs: 3000 }} />);
    expect(screen.getByText('2 tool calls · 3s')).toBeDefined();
  });

  it('shows chevron and sets aria-expanded when expandable content exists', () => {
    render(<SubagentBlock part={{ ...basePart, toolUses: 5 }} />);
    const button = screen.getByRole('button');
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('toggles expanded state on click when expandable content exists', () => {
    render(<SubagentBlock part={{ ...basePart, summary: 'Analysis complete' }} />);
    const button = screen.getByRole('button');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it('collapses on second click', () => {
    render(<SubagentBlock part={{ ...basePart, summary: 'Analysis complete' }} />);
    const button = screen.getByRole('button');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('does not toggle when there is no expandable content', () => {
    render(<SubagentBlock part={basePart} />);
    const button = screen.getByRole('button');
    // aria-expanded is undefined (not set) — clicking should not cause an error
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBeNull();
  });

  it('shows lastToolName when status is running and expanded', () => {
    render(
      <SubagentBlock
        part={{ ...basePart, status: 'running', lastToolName: 'Bash', toolUses: 1 }}
      />
    );
    const button = screen.getByRole('button');
    fireEvent.click(button);
    expect(screen.getByText('Bash')).toBeDefined();
  });

  it('does not show lastToolName when status is complete', () => {
    render(
      <SubagentBlock
        part={{
          ...basePart,
          status: 'complete',
          lastToolName: 'Bash',
          summary: 'Done',
        }}
      />
    );
    const button = screen.getByRole('button');
    fireEvent.click(button);
    expect(screen.queryByText('Last tool:')).toBeNull();
  });

  it('shows summary when expanded', () => {
    render(
      <SubagentBlock part={{ ...basePart, status: 'complete', summary: 'Task finished successfully.' }} />
    );
    const button = screen.getByRole('button');
    fireEvent.click(button);
    expect(screen.getByText('Task finished successfully.')).toBeDefined();
  });

  it('renders complete status with data-status attribute', () => {
    render(<SubagentBlock part={{ ...basePart, status: 'complete' }} />);
    const block = screen.getByTestId('subagent-block');
    expect(block.getAttribute('data-status')).toBe('complete');
  });

  it('renders error status with data-status attribute', () => {
    render(<SubagentBlock part={{ ...basePart, status: 'error' }} />);
    const block = screen.getByTestId('subagent-block');
    expect(block.getAttribute('data-status')).toBe('error');
  });
});
