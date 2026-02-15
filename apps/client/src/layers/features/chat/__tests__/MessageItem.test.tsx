// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { MessageItem } from '../ui/MessageItem';
import { useAppStore } from '@/layers/shared/model';
import type { MessageGrouping } from '../model/use-chat-session';

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  // Disable auto-hide so existing tests see all tool calls
  useAppStore.getState().setAutoHideToolCalls(false);
});

// Mock motion/react to render plain elements (no animation delays)
vi.mock('motion/react', () => ({
  motion: {
    div: ({ children, initial, animate, exit, transition, ...props }: Record<string, unknown>) => {
      void initial; void animate; void exit; void transition;
      const { className, style, ...rest } = props as Record<string, unknown>;
      return <div className={className as string} style={style as React.CSSProperties} data-initial={JSON.stringify(initial)} {...rest}>{children as React.ReactNode}</div>;
    },
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock Streamdown to avoid complex rendering in unit tests
vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <div data-testid="streamdown">{children}</div>,
}));

// Mock ToolApproval to avoid needing TransportProvider in unit tests
vi.mock('../ToolApproval', () => ({
  ToolApproval: ({ toolName, toolCallId }: { toolName: string; toolCallId: string }) => (
    <div data-testid="tool-approval" data-tool-name={toolName} data-tool-call-id={toolCallId}>
      Tool approval: {toolName}
    </div>
  ),
}));

// Mock QuestionPrompt to avoid needing TransportProvider in unit tests
vi.mock('../QuestionPrompt', () => ({
  QuestionPrompt: ({ toolCallId }: { toolCallId: string }) => (
    <div data-testid="question-prompt" data-tool-call-id={toolCallId}>
      Question prompt
    </div>
  ),
}));

const onlyGrouping: MessageGrouping = { position: 'only', groupIndex: 0 };
const firstGrouping: MessageGrouping = { position: 'first', groupIndex: 0 };
const middleGrouping: MessageGrouping = { position: 'middle', groupIndex: 0 };
const lastGrouping: MessageGrouping = { position: 'last', groupIndex: 0 };

describe('MessageItem', () => {
  it('renders user messages as plain text', () => {
    const msg = { id: '1', role: 'user' as const, content: '**not bold**', parts: [{ type: 'text' as const, text: '**not bold**' }], timestamp: new Date().toISOString() };
    render(<MessageItem message={msg} sessionId="test-session" grouping={onlyGrouping} />);
    expect(screen.getByText('**not bold**')).toBeDefined();
    expect(screen.queryByTestId('streamdown')).toBeNull();
  });

  it('renders assistant messages with Streamdown', () => {
    const msg = { id: '1', role: 'assistant' as const, content: '# Heading', parts: [{ type: 'text' as const, text: '# Heading' }], timestamp: new Date().toISOString() };
    render(<MessageItem message={msg} sessionId="test-session" grouping={onlyGrouping} />);
    expect(screen.getByTestId('streamdown')).toBeDefined();
    expect(screen.getByText('# Heading')).toBeDefined();
  });

  it('does not render name labels', () => {
    const msg = { id: '1', role: 'user' as const, content: 'Test', parts: [{ type: 'text' as const, text: 'Test' }], timestamp: new Date().toISOString() };
    render(<MessageItem message={msg} sessionId="test-session" grouping={onlyGrouping} />);
    expect(screen.queryByText('You')).toBeNull();
    expect(screen.queryByText('Claude')).toBeNull();
  });

  it('renders tool calls for assistant messages', () => {
    const msg = {
      id: '1',
      role: 'assistant' as const,
      content: 'Let me check.',
      toolCalls: [
        { toolCallId: 'tc-1', toolName: 'Read', input: '{}', status: 'complete' as const },
      ],
      parts: [
        { type: 'text' as const, text: 'Let me check.' },
        { type: 'tool_call' as const, toolCallId: 'tc-1', toolName: 'Read', input: '{}', status: 'complete' as const },
      ],
      timestamp: new Date().toISOString(),
    };
    render(<MessageItem message={msg} sessionId="test-session" grouping={onlyGrouping} />);
    expect(screen.getByText('Read ...')).toBeDefined();
  });

  it('renders parts in correct interleaved order (text -> tool -> text)', () => {
    const msg = {
      id: '1',
      role: 'assistant' as const,
      content: 'Before toolAfter tool',
      parts: [
        { type: 'text' as const, text: 'Before tool' },
        { type: 'tool_call' as const, toolCallId: 'tc-1', toolName: 'Read', input: '{}', status: 'complete' as const },
        { type: 'text' as const, text: 'After tool' },
      ],
      timestamp: new Date().toISOString(),
    };
    const { container } = render(<MessageItem message={msg} sessionId="test-session" grouping={onlyGrouping} />);
    const contentDiv = container.querySelector('.max-w-\\[80ch\\]');
    const children = Array.from(contentDiv!.children);
    // First child: text part "Before tool"
    expect(children[0].textContent).toContain('Before tool');
    // Second child: tool call card "Read"
    expect(children[1].textContent).toContain('Read');
    // Third child: text part "After tool"
    expect(children[2].textContent).toContain('After tool');
  });

  it('sets animation initial state when isNew is true', () => {
    const msg = { id: '1', role: 'assistant' as const, content: 'New message', parts: [{ type: 'text' as const, text: 'New message' }], timestamp: new Date().toISOString() };
    const { container } = render(<MessageItem message={msg} sessionId="test-session" grouping={onlyGrouping} isNew={true} />);
    const motionDiv = container.firstElementChild;
    const initial = motionDiv?.getAttribute('data-initial');
    expect(initial).toBeDefined();
    const parsed = JSON.parse(initial!);
    expect(parsed.opacity).toBe(0);
    expect(parsed.y).toBe(8);
  });

  it('disables animation when isNew is false', () => {
    const msg = { id: '1', role: 'assistant' as const, content: 'Old message', parts: [{ type: 'text' as const, text: 'Old message' }], timestamp: new Date().toISOString() };
    const { container } = render(<MessageItem message={msg} sessionId="test-session" grouping={onlyGrouping} isNew={false} />);
    const motionDiv = container.firstElementChild;
    const initial = motionDiv?.getAttribute('data-initial');
    expect(initial).toBe('false');
  });

  it('renders dot indicator for assistant messages (first in group)', () => {
    const msg = { id: '1', role: 'assistant' as const, content: 'Reply', parts: [{ type: 'text' as const, text: 'Reply' }], timestamp: new Date().toISOString() };
    render(<MessageItem message={msg} sessionId="test-session" grouping={firstGrouping} />);
    expect(screen.getByText('●')).toBeDefined();
  });

  it('hides indicator for middle messages in a group', () => {
    const msg = { id: '1', role: 'assistant' as const, content: 'Reply', parts: [{ type: 'text' as const, text: 'Reply' }], timestamp: new Date().toISOString() };
    render(<MessageItem message={msg} sessionId="test-session" grouping={middleGrouping} />);
    expect(screen.queryByText('●')).toBeNull();
  });

  it('hides indicator for last messages in a group', () => {
    const msg = { id: '1', role: 'assistant' as const, content: 'Reply', parts: [{ type: 'text' as const, text: 'Reply' }], timestamp: new Date().toISOString() };
    render(<MessageItem message={msg} sessionId="test-session" grouping={lastGrouping} />);
    expect(screen.queryByText('●')).toBeNull();
  });

  it('shows chevron indicator for user on first and only positions', () => {
    const msg = { id: '1', role: 'user' as const, content: 'Test', parts: [{ type: 'text' as const, text: 'Test' }], timestamp: new Date().toISOString() };
    const { container: c1 } = render(<MessageItem message={msg} sessionId="test-session" grouping={firstGrouping} />);
    // ChevronRight renders as an SVG
    expect(c1.querySelector('svg')).not.toBeNull();
    cleanup();
    const { container: c2 } = render(<MessageItem message={msg} sessionId="test-session" grouping={onlyGrouping} />);
    expect(c2.querySelector('svg')).not.toBeNull();
  });

  it('renders timestamp from message on hover', () => {
    const ts = '2026-02-07T10:30:00.000Z';
    const msg = { id: '1', role: 'user' as const, content: 'Test', parts: [{ type: 'text' as const, text: 'Test' }], timestamp: ts };
    const { container } = render(<MessageItem message={msg} sessionId="test-session" grouping={onlyGrouping} />);
    const timeEl = container.querySelector('.group-hover\\:text-muted-foreground\\/60');
    expect(timeEl).not.toBeNull();
    expect(timeEl!.textContent).toBeTruthy();
  });

  it('passes isStreaming to StreamingText for assistant messages', () => {
    const msg = { id: '1', role: 'assistant' as const, content: 'Streaming...', parts: [{ type: 'text' as const, text: 'Streaming...' }], timestamp: new Date().toISOString() };
    const { container } = render(<MessageItem message={msg} sessionId="test-session" grouping={onlyGrouping} isStreaming={true} />);
    const cursorWrapper = container.querySelector('.streaming-cursor');
    expect(cursorWrapper).not.toBeNull();
  });

  it('renders divider on first-in-group when not the first group', () => {
    const msg = { id: '1', role: 'assistant' as const, content: 'Reply', parts: [{ type: 'text' as const, text: 'Reply' }], timestamp: new Date().toISOString() };
    const grouping: MessageGrouping = { position: 'first', groupIndex: 1 };
    const { container } = render(<MessageItem message={msg} sessionId="test-session" grouping={grouping} />);
    const divider = container.querySelector('.bg-border\\/20');
    expect(divider).not.toBeNull();
  });

  it('does not render divider on the first group', () => {
    const msg = { id: '1', role: 'user' as const, content: 'Hello', parts: [{ type: 'text' as const, text: 'Hello' }], timestamp: new Date().toISOString() };
    const grouping: MessageGrouping = { position: 'first', groupIndex: 0 };
    const { container } = render(<MessageItem message={msg} sessionId="test-session" grouping={grouping} />);
    const divider = container.querySelector('.bg-border\\/20');
    expect(divider).toBeNull();
  });

  it('uses msg-assistant class and max-width on content container', () => {
    const msg = { id: '1', role: 'assistant' as const, content: 'Reply', parts: [{ type: 'text' as const, text: 'Reply' }], timestamp: new Date().toISOString() };
    const { container } = render(<MessageItem message={msg} sessionId="test-session" grouping={onlyGrouping} />);
    const el = container.querySelector('.msg-assistant');
    expect(el).not.toBeNull();
    // max-w-[80ch] is on the parent content container (applies to text + tool calls)
    const contentContainer = container.querySelector('.max-w-\\[80ch\\]');
    expect(contentContainer).not.toBeNull();
    expect(contentContainer?.querySelector('.msg-assistant')).not.toBeNull();
  });

  it('applies tight spacing for middle messages', () => {
    const msg = { id: '1', role: 'user' as const, content: 'Mid', parts: [{ type: 'text' as const, text: 'Mid' }], timestamp: new Date().toISOString() };
    const { container } = render(<MessageItem message={msg} sessionId="test-session" grouping={middleGrouping} />);
    const el = container.firstElementChild;
    expect(el?.className).toContain('pt-0.5');
    expect(el?.className).toContain('pb-0.5');
  });

  it('applies larger spacing for first-in-group messages', () => {
    const msg = { id: '1', role: 'user' as const, content: 'First', parts: [{ type: 'text' as const, text: 'First' }], timestamp: new Date().toISOString() };
    const { container } = render(<MessageItem message={msg} sessionId="test-session" grouping={firstGrouping} />);
    const el = container.firstElementChild;
    expect(el?.className).toContain('pt-4');
  });
});

describe('Auto-hide tool calls', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  const toolCallPart = (status: string) => ({
    type: 'tool_call' as const,
    toolCallId: 'tc-1',
    toolName: 'Read',
    input: '{}',
    status: status as 'pending' | 'running' | 'complete' | 'error',
  });

  const makeMsg = (status: string) => ({
    id: '1',
    role: 'assistant' as const,
    content: 'text',
    parts: [
      { type: 'text' as const, text: 'text' },
      toolCallPart(status),
    ],
    timestamp: new Date().toISOString(),
  });

  it('hides tool calls that are already complete on mount when autoHide is ON', () => {
    useAppStore.getState().setAutoHideToolCalls(true);
    render(<MessageItem message={makeMsg('complete')} sessionId="s" grouping={onlyGrouping} />);
    expect(screen.queryByText('Read ...')).toBeNull();
  });

  it('shows tool calls during streaming, hides 5s after completion', () => {
    useAppStore.getState().setAutoHideToolCalls(true);
    const msg = makeMsg('running');
    const { rerender } = render(<MessageItem message={msg} sessionId="s" grouping={onlyGrouping} />);
    expect(screen.getByText('Read ...')).toBeDefined();

    // Transition to complete
    const completedMsg = makeMsg('complete');
    rerender(<MessageItem message={completedMsg} sessionId="s" grouping={onlyGrouping} />);
    // Still visible immediately after completion
    expect(screen.getByText('Read ...')).toBeDefined();

    // Advance past 5s timer
    act(() => { vi.advanceTimersByTime(5_000); });
    expect(screen.queryByText('Read ...')).toBeNull();
  });

  it('never hides tool calls with error status', () => {
    useAppStore.getState().setAutoHideToolCalls(true);
    render(<MessageItem message={makeMsg('error')} sessionId="s" grouping={onlyGrouping} />);
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(screen.getByText('Read ...')).toBeDefined();
  });

  it('shows all tool calls when autoHide is OFF', () => {
    useAppStore.getState().setAutoHideToolCalls(false);
    render(<MessageItem message={makeMsg('complete')} sessionId="s" grouping={onlyGrouping} />);
    expect(screen.getByText('Read ...')).toBeDefined();
  });
});
