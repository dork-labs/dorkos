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

vi.mock('../OutputRenderer', () => ({
  OutputRenderer: ({ content, toolName }: { content: string; toolName: string }) => {
    const isTruncated = content.length > 5120;
    const displayContent = isTruncated ? content.slice(0, 5120) : content;
    return (
      <div data-testid="output-renderer" data-tool-name={toolName}>
        <pre>{displayContent}</pre>
        {isTruncated && <button>Show full output ({(content.length / 1024).toFixed(1)}KB)</button>}
      </div>
    );
  },
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

    const renderer = screen.getByTestId('output-renderer');
    expect(renderer).toBeInTheDocument();
    expect(renderer.textContent).toContain(shortResult);
    expect(screen.queryByRole('button', { name: /show full output/i })).not.toBeInTheDocument();
  });

  it('truncates result over 5KB and shows expand button', () => {
    const longResult = 'x'.repeat(6000);
    render(<ToolCallCard toolCall={makeToolCall({ result: longResult })} defaultExpanded />);

    // Content should be truncated to 5120 chars by the OutputRenderer mock
    const pre = screen.getByText(/^x+$/);
    expect(pre.textContent!.length).toBe(5120);

    // Show-more button should be visible with size
    const button = screen.getByRole('button', { name: /show full output/i });
    expect(button).toBeInTheDocument();
    expect(button.textContent).toContain('5.9KB');
  });

  it('passes full result content to OutputRenderer for expansion handling', () => {
    const longResult = 'x'.repeat(6000);
    render(<ToolCallCard toolCall={makeToolCall({ result: longResult })} defaultExpanded />);

    // OutputRenderer receives the full content — expansion is its responsibility
    const renderer = screen.getByTestId('output-renderer');
    expect(renderer).toBeInTheDocument();
    // The expand button is present since content exceeds 5KB
    expect(screen.getByRole('button', { name: /show full output/i })).toBeInTheDocument();
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

describe('ToolCallCard streaming display', () => {
  it('shows "Preparing..." with spinner when running with empty input', () => {
    render(
      <ToolCallCard toolCall={makeToolCall({ status: 'running', input: '' })} defaultExpanded />
    );
    expect(screen.getByText('Preparing...')).toBeInTheDocument();
    expect(document.querySelector('.animate-spin')).toBeInTheDocument();
  });

  it('shows raw streaming input when running with partial input', () => {
    const partialJson = '{"command": "echo hel';
    render(
      <ToolCallCard
        toolCall={makeToolCall({ status: 'running', input: partialJson })}
        defaultExpanded
      />
    );
    // Raw partial text should appear, not a formatted key-value grid
    const pre = document.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toContain(partialJson);
    // Should also have the pulse dot
    expect(pre!.querySelector('.animate-pulse')).not.toBeNull();
  });

  it('does not show "Preparing..." for completed tool calls with empty input', () => {
    render(
      <ToolCallCard toolCall={makeToolCall({ status: 'complete', input: '' })} defaultExpanded />
    );
    expect(screen.queryByText('Preparing...')).not.toBeInTheDocument();
  });
});

describe('ToolCallCard duration badge', () => {
  it('shows formatted duration on a completed card with both timestamps', () => {
    render(
      <ToolCallCard
        toolCall={makeToolCall({ status: 'complete', startedAt: 1000, completedAt: 2234 })}
      />
    );

    expect(screen.getByText('1.2s')).toBeInTheDocument();
  });

  it('does not show duration on a running card without completedAt', () => {
    render(
      <ToolCallCard
        toolCall={makeToolCall({ status: 'running', startedAt: 1000, completedAt: undefined })}
      />
    );

    expect(screen.queryByText(/\d+(\.\d+)?(ms|s|m)/)).not.toBeInTheDocument();
  });

  it('does not show duration on a historical card without timestamps', () => {
    render(
      <ToolCallCard
        toolCall={makeToolCall({
          status: 'complete',
          startedAt: undefined,
          completedAt: undefined,
        })}
      />
    );

    expect(screen.queryByText(/\d+(\.\d+)?(ms|s|m)/)).not.toBeInTheDocument();
  });
});

describe('ToolCallCard MCP server badge', () => {
  it('shows "Slack" badge for mcp__slack__send_message', () => {
    render(<ToolCallCard toolCall={makeToolCall({ toolName: 'mcp__slack__send_message' })} />);

    expect(screen.getByText('Slack')).toBeInTheDocument();
  });

  it('does not show "DorkOS" badge for mcp__dorkos__relay_send', () => {
    render(<ToolCallCard toolCall={makeToolCall({ toolName: 'mcp__dorkos__relay_send' })} />);

    expect(screen.queryByText('DorkOS')).not.toBeInTheDocument();
  });

  it('does not show a badge for standard SDK tools like Bash', () => {
    render(<ToolCallCard toolCall={makeToolCall({ toolName: 'Bash' })} />);

    // The header has no badge span — only the tool label and status icon
    const header = screen.getByTestId('tool-call-card');
    // There should be no bg-muted badge element
    expect(header.querySelector('.bg-muted')).not.toBeInTheDocument();
  });

  it('shows "Custom Server" for mcp__custom_server__do_thing', () => {
    render(<ToolCallCard toolCall={makeToolCall({ toolName: 'mcp__custom_server__do_thing' })} />);

    expect(screen.getByText('Custom Server')).toBeInTheDocument();
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
