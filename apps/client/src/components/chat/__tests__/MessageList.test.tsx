// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MessageList, computeGrouping } from '../MessageList';
import type { ChatMessage } from '../../../hooks/use-chat-session';

// jsdom does not implement IntersectionObserver
globalThis.IntersectionObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

afterEach(() => {
  cleanup();
});

// Mock motion/react to render plain elements (no animation delays)
vi.mock('motion/react', () => ({
  motion: {
    div: ({ children, initial, animate, exit, transition, ...props }: Record<string, unknown>) => {
      void initial; void animate; void exit; void transition;
      const { className, style, ...rest } = props as Record<string, unknown>;
      return <div className={className as string} style={style as React.CSSProperties} {...rest}>{children as React.ReactNode}</div>;
    },
    button: ({ children, initial, animate, exit, transition, whileHover, whileTap, ...props }: Record<string, unknown>) => {
      void initial; void animate; void exit; void transition; void whileHover; void whileTap;
      const { className, style, ...rest } = props as Record<string, unknown>;
      return <button className={className as string} style={style as React.CSSProperties} {...rest}>{children as React.ReactNode}</button>;
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
  ToolApproval: ({ toolName }: { toolName: string }) => <div data-testid="tool-approval">{toolName}</div>,
}));

// Mock QuestionPrompt to avoid needing TransportProvider in unit tests
vi.mock('../QuestionPrompt', () => ({
  QuestionPrompt: () => <div data-testid="question-prompt">Question prompt</div>,
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({
        key: `virt-${i}`,
        index: i,
        start: i * 80,
        size: 80,
      })),
    getTotalSize: () => count * 80,
    measureElement: () => {},
    scrollToIndex: () => {},
  }),
}));

describe('computeGrouping', () => {
  it('returns empty array for empty messages', () => {
    expect(computeGrouping([])).toEqual([]);
  });

  it('marks a single message as "only"', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'user', content: 'Hello', timestamp: '' },
    ];
    const result = computeGrouping(messages);
    expect(result).toEqual([{ position: 'only', groupIndex: 0 }]);
  });

  it('marks alternating messages as "only" with incrementing groupIndex', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'user', content: 'Hi', timestamp: '' },
      { id: '2', role: 'assistant', content: 'Hello', timestamp: '' },
      { id: '3', role: 'user', content: 'Bye', timestamp: '' },
    ];
    const result = computeGrouping(messages);
    expect(result).toEqual([
      { position: 'only', groupIndex: 0 },
      { position: 'only', groupIndex: 1 },
      { position: 'only', groupIndex: 2 },
    ]);
  });

  it('marks consecutive same-role messages with first/middle/last', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'user', content: 'A', timestamp: '' },
      { id: '2', role: 'user', content: 'B', timestamp: '' },
      { id: '3', role: 'user', content: 'C', timestamp: '' },
    ];
    const result = computeGrouping(messages);
    expect(result).toEqual([
      { position: 'first', groupIndex: 0 },
      { position: 'middle', groupIndex: 0 },
      { position: 'last', groupIndex: 0 },
    ]);
  });

  it('handles two consecutive messages as first/last', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'assistant', content: 'A', timestamp: '' },
      { id: '2', role: 'assistant', content: 'B', timestamp: '' },
    ];
    const result = computeGrouping(messages);
    expect(result).toEqual([
      { position: 'first', groupIndex: 0 },
      { position: 'last', groupIndex: 0 },
    ]);
  });

  it('handles mixed groups correctly', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'user', content: 'A', timestamp: '' },
      { id: '2', role: 'user', content: 'B', timestamp: '' },
      { id: '3', role: 'assistant', content: 'C', timestamp: '' },
      { id: '4', role: 'user', content: 'D', timestamp: '' },
    ];
    const result = computeGrouping(messages);
    expect(result).toEqual([
      { position: 'first', groupIndex: 0 },
      { position: 'last', groupIndex: 0 },
      { position: 'only', groupIndex: 1 },
      { position: 'only', groupIndex: 2 },
    ]);
  });
});

describe('MessageList', () => {
  it('renders empty list without error', () => {
    const { container } = render(<MessageList sessionId="test-session" messages={[]} />);
    expect(container).toBeDefined();
  });

  it('renders user message content', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'user', content: 'Hello world', timestamp: new Date().toISOString() },
    ];
    render(<MessageList sessionId="test-session" messages={messages} />);
    expect(screen.getByText('Hello world')).toBeDefined();
  });

  it('renders assistant message content', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'assistant', content: 'Hi there, how can I help?', parts: [{ type: 'text', text: 'Hi there, how can I help?' }], timestamp: new Date().toISOString() },
    ];
    render(<MessageList sessionId="test-session" messages={messages} />);
    expect(screen.getByText('Hi there, how can I help?')).toBeDefined();
  });

  it('renders multiple messages', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'user', content: 'Hello', parts: [{ type: 'text', text: 'Hello' }], timestamp: new Date().toISOString() },
      { id: '2', role: 'assistant', content: 'Hi there', parts: [{ type: 'text', text: 'Hi there' }], timestamp: new Date().toISOString() },
    ];
    render(<MessageList sessionId="test-session" messages={messages} />);
    expect(screen.getByText('Hello')).toBeDefined();
    expect(screen.getByText('Hi there')).toBeDefined();
  });

  it('renders tool calls within messages', () => {
    const messages: ChatMessage[] = [
      {
        id: '1',
        role: 'assistant',
        content: 'Let me read that file.',
        toolCalls: [
          { toolCallId: 'tc-1', toolName: 'Read', input: '{}', status: 'complete' },
        ],
        parts: [
          { type: 'text', text: 'Let me read that file.' },
          { type: 'tool_call', toolCallId: 'tc-1', toolName: 'Read', input: '{}', status: 'complete' },
        ],
        timestamp: new Date().toISOString(),
      },
    ];
    render(<MessageList sessionId="test-session" messages={messages} />);
    expect(screen.getByText('Read ...')).toBeDefined();
  });

  it('has scroll container with overflow', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'user', content: 'Test', timestamp: new Date().toISOString() },
    ];
    const { container } = render(<MessageList sessionId="test-session" messages={messages} />);
    const scrollContainer = container.querySelector('.overflow-y-auto');
    expect(scrollContainer).not.toBeNull();
  });
});
