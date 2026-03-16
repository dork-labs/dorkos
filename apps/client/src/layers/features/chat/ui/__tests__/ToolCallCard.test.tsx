/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ToolCallCard } from '../ToolCallCard';
import type { ToolCallState } from '../../model/chat-types';

vi.mock('motion/react', () => ({
  motion: {
    div: ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => (
      <div {...props}>{children}</div>
    ),
  },
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

afterEach(() => {
  cleanup();
});

function makeToolCall(overrides: Partial<ToolCallState> = {}): ToolCallState {
  return {
    toolCallId: 'tc-1',
    toolName: 'Bash',
    status: 'complete',
    input: '{"command": "echo hello"}',
    result: undefined,
    progressOutput: undefined,
    ...overrides,
  };
}

describe('ToolCallCard truncation', () => {
  it('renders short result fully without a show-more button', () => {
    const shortResult = 'Hello world';
    render(<ToolCallCard toolCall={makeToolCall({ result: shortResult })} defaultExpanded />);

    expect(screen.getByText(shortResult)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show full output/i })).not.toBeInTheDocument();
  });

  it('truncates result over 5KB and shows expand button', () => {
    const longResult = 'x'.repeat(6000);
    render(<ToolCallCard toolCall={makeToolCall({ result: longResult })} defaultExpanded />);

    // Content should be truncated to 5120 chars
    const pre = screen.getByText(/^x+$/);
    expect(pre.textContent!.length).toBe(5120);

    // Show-more button should be visible with size
    const button = screen.getByRole('button', { name: /show full output/i });
    expect(button).toBeInTheDocument();
    expect(button.textContent).toContain('5.9KB');
  });

  it('expands to full content when show-more button is clicked', () => {
    const longResult = 'x'.repeat(6000);
    render(<ToolCallCard toolCall={makeToolCall({ result: longResult })} defaultExpanded />);

    const button = screen.getByRole('button', { name: /show full output/i });
    fireEvent.click(button);

    // Full content should now be visible
    const pre = screen.getByText(/^x+$/);
    expect(pre.textContent!.length).toBe(6000);

    // Button should be gone (one-way expand)
    expect(screen.queryByRole('button', { name: /show full output/i })).not.toBeInTheDocument();
  });

  it('truncates progress output over 5KB', () => {
    const longProgress = 'p'.repeat(6000);
    render(
      <ToolCallCard
        toolCall={makeToolCall({ progressOutput: longProgress, result: undefined, status: 'running' })}
        defaultExpanded
      />,
    );

    const pre = screen.getByText(/^p+$/);
    expect(pre.textContent!.length).toBe(5120);
    expect(screen.getByRole('button', { name: /show full output/i })).toBeInTheDocument();
  });

  it('renders short progress output fully without a show-more button', () => {
    const shortProgress = 'progress output';
    render(
      <ToolCallCard
        toolCall={makeToolCall({ progressOutput: shortProgress, result: undefined, status: 'running' })}
        defaultExpanded
      />,
    );

    expect(screen.getByText(shortProgress)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show full output/i })).not.toBeInTheDocument();
  });
});
