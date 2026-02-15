// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { ToolCallCard } from '../ui/ToolCallCard';
import type { ToolCallState } from '../model/use-chat-session';

// Mock motion/react to render plain elements (no animation delays)
vi.mock('motion/react', () => ({
  motion: {
    div: ({ children, initial, animate, exit, transition, ...props }: Record<string, unknown>) => {
      void initial; void animate; void exit; void transition;
      const { className, style, ...rest } = props as Record<string, unknown>;
      return <div className={className as string} style={style as React.CSSProperties} {...rest}>{children as React.ReactNode}</div>;
    },
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

afterEach(() => {
  cleanup();
});

const baseToolCall: ToolCallState = {
  toolCallId: 'tc-1',
  toolName: 'Read',
  input: '{"file_path":"/test.ts"}',
  status: 'complete',
};

describe('ToolCallCard', () => {
  it('renders tool name', () => {
    render(<ToolCallCard toolCall={baseToolCall} />);
    expect(screen.getByText('Read test.ts')).toBeDefined();
  });

  it('does not show input details initially (collapsed)', () => {
    render(<ToolCallCard toolCall={baseToolCall} />);
    expect(screen.queryByText(/File path/)).toBeNull();
  });

  it('expands on click to show pretty-printed input', () => {
    render(<ToolCallCard toolCall={baseToolCall} />);
    fireEvent.click(screen.getByText('Read test.ts'));
    // After expanding, should show the pretty-printed JSON key
    expect(screen.getByText(/File path/)).toBeDefined();
  });

  it('shows result when available and expanded', () => {
    render(<ToolCallCard toolCall={{ ...baseToolCall, result: 'file contents here' }} />);
    fireEvent.click(screen.getByText('Read test.ts'));
    expect(screen.getByText('file contents here')).toBeDefined();
  });

  it('collapses on second click', () => {
    render(<ToolCallCard toolCall={baseToolCall} />);
    const button = screen.getByText('Read test.ts');
    fireEvent.click(button);
    expect(screen.getByText(/File path/)).toBeDefined();
    fireEvent.click(button);
    expect(screen.queryByText(/File path/)).toBeNull();
  });

  it('renders pending status', () => {
    render(<ToolCallCard toolCall={{ ...baseToolCall, status: 'pending' }} />);
    expect(screen.getByText('Read test.ts')).toBeDefined();
  });

  it('renders error status', () => {
    render(<ToolCallCard toolCall={{ ...baseToolCall, status: 'error' }} />);
    expect(screen.getByText('Read test.ts')).toBeDefined();
  });

  it('handles non-JSON input gracefully', () => {
    render(<ToolCallCard toolCall={{ ...baseToolCall, input: 'raw text input' }} />);
    fireEvent.click(screen.getByText('Read'));
    expect(screen.getByText('raw text input')).toBeDefined();
  });
});
