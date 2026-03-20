/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ToolCallCard } from '../ToolCallCard';
import type { ToolCallState, HookState } from '../../model/chat-types';

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

function makeHook(overrides: Partial<HookState> = {}): HookState {
  return {
    hookId: 'hook-1',
    hookName: 'pre-commit',
    hookEvent: 'PreToolUse',
    status: 'success',
    stdout: '',
    stderr: '',
    ...overrides,
  };
}

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
        toolCall={makeToolCall({
          progressOutput: longProgress,
          result: undefined,
          status: 'running',
        })}
        defaultExpanded
      />
    );

    const pre = screen.getByText(/^p+$/);
    expect(pre.textContent!.length).toBe(5120);
    expect(screen.getByRole('button', { name: /show full output/i })).toBeInTheDocument();
  });

  it('renders short progress output fully without a show-more button', () => {
    const shortProgress = 'progress output';
    render(
      <ToolCallCard
        toolCall={makeToolCall({
          progressOutput: shortProgress,
          result: undefined,
          status: 'running',
        })}
        defaultExpanded
      />
    );

    expect(screen.getByText(shortProgress)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show full output/i })).not.toBeInTheDocument();
  });
});

describe('ToolCallCard HookRow', () => {
  it('renders hook name when hooks are present', () => {
    render(
      <ToolCallCard toolCall={makeToolCall({ hooks: [makeHook({ hookName: 'pre-commit' })] })} />
    );

    expect(screen.getByText('pre-commit')).toBeInTheDocument();
  });

  it('shows a spinner for a running hook', () => {
    render(<ToolCallCard toolCall={makeToolCall({ hooks: [makeHook({ status: 'running' })] })} />);

    const spinner = document.querySelector('.animate-spin');
    expect(spinner).toBeInTheDocument();
  });

  it('shows muted styling for a successful hook', () => {
    render(
      <ToolCallCard
        toolCall={makeToolCall({ hooks: [makeHook({ status: 'success', hookName: 'lint' })] })}
      />
    );

    const hookName = screen.getByText('lint');
    expect(hookName).toHaveClass('text-muted-foreground');
  });

  it('shows destructive styling and "failed" label for an errored hook', () => {
    render(
      <ToolCallCard
        toolCall={makeToolCall({
          hooks: [
            makeHook({ status: 'error', hookName: 'type-check', stderr: 'Type error found' }),
          ],
        })}
      />
    );

    const hookName = screen.getByText('type-check');
    expect(hookName).toHaveClass('text-destructive');
    expect(screen.getByText('failed')).toBeInTheDocument();
  });

  it('error hook starts expanded and shows stderr', () => {
    render(
      <ToolCallCard
        toolCall={makeToolCall({
          hooks: [makeHook({ status: 'error', stderr: 'fatal: type mismatch' })],
        })}
      />
    );

    expect(screen.getByText('fatal: type mismatch')).toBeInTheDocument();
  });

  it('expands to show stderr on click for a non-error hook with output', () => {
    render(
      <ToolCallCard
        toolCall={makeToolCall({
          hooks: [makeHook({ status: 'success', hookName: 'lint', stderr: 'warning: unused var' })],
        })}
      />
    );

    // Output not visible before click
    expect(screen.queryByText('warning: unused var')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /pre-commit|lint/i }));
    expect(screen.getByText('warning: unused var')).toBeInTheDocument();
  });

  it('does not render hook section when hooks array is empty', () => {
    const { container } = render(<ToolCallCard toolCall={makeToolCall({ hooks: [] })} />);

    expect(container.querySelector('.border-border\\/50')).not.toBeInTheDocument();
  });

  it('does not render hook section when hooks is undefined', () => {
    const { container } = render(<ToolCallCard toolCall={makeToolCall({ hooks: undefined })} />);

    expect(container.querySelector('.border-border\\/50')).not.toBeInTheDocument();
  });
});
