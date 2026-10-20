// @vitest-environment jsdom
/**
 * The Work tab's body (DOR-3075): every step the agent took, turn by turn,
 * under one line at the top that names the session with Show sessions on and
 * says what the tab is otherwise. A Show work press scrolls to its turn.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { ChatMessage } from '@/layers/shared/model';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { WorkView } from '../ui/work/WorkView';
import { useWorkPanelFocusStore } from '../model/work-panel-focus';

vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <div>{children}</div>,
}));
vi.mock('@/layers/features/status', () => ({
  useSessionDiagnostics: () => ({
    model: 'claude-opus-5-5',
    contextPercent: 63.6,
    runtime: 'claude-code',
  }),
  statusModelLabel: (model: string) => (model === 'claude-opus-5-5' ? 'Opus 5.5' : model),
}));

beforeEach(() => useWorkPanelFocusStore.setState({ request: null }));
afterEach(cleanup);

const tool = (id: string, toolName: string) => ({
  type: 'tool_call' as const,
  toolCallId: id,
  toolName,
  input: '{"file_path":"/src/sidebar.ts"}',
  status: 'complete' as const,
});

const MESSAGES: ChatMessage[] = [
  {
    id: 'u1',
    role: 'user',
    content: 'Make the dark image',
    parts: [{ type: 'text', text: 'Make the dark image' }],
    timestamp: '2026-10-19T17:02:00.000Z',
  },
  {
    id: 'a1',
    role: 'assistant',
    content: 'Done.',
    parts: [tool('t1', 'Read'), { type: 'text', text: 'Done.' }],
    timestamp: '2026-10-19T17:09:00.000Z',
  },
  {
    id: 'u2',
    role: 'user',
    content: 'Why is the sidebar busy?',
    parts: [{ type: 'text', text: 'Why is the sidebar busy?' }],
    timestamp: '2026-10-20T14:41:00.000Z',
  },
  {
    id: 'a2',
    role: 'assistant',
    content: 'Three causes.',
    parts: [
      { type: 'thinking', text: 'Rows come from three sources' },
      tool('t2', 'Grep'),
      { type: 'text', text: 'Three causes.' },
    ],
    timestamp: '2026-10-20T14:42:12.000Z',
  },
  // A reply with no work is no turn in the tab.
  {
    id: 'u3',
    role: 'user',
    content: 'Thanks',
    parts: [{ type: 'text', text: 'Thanks' }],
    timestamp: '2026-10-20T14:43:00.000Z',
  },
  {
    id: 'a3',
    role: 'assistant',
    content: 'Any time.',
    parts: [{ type: 'text', text: 'Any time.' }],
    timestamp: '2026-10-20T14:43:05.000Z',
  },
];

function draw(props: Partial<React.ComponentProps<typeof WorkView>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOpenSession = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={createMockTransport()}>
        <TooltipProvider>
          <WorkView
            sessionId="scout-direct"
            messages={MESSAGES}
            agentName="Scout"
            showSessions={false}
            onOpenSession={onOpenSession}
            {...props}
          />
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  return { onOpenSession };
}

describe('WorkView', () => {
  it('says what the tab is, for everyone, with Show sessions off', () => {
    draw();
    expect(screen.getByText('Every step Scout took, turn by turn.')).toBeInTheDocument();
    expect(screen.queryByTestId('work-session-line')).toBeNull();
  });

  it('names the session, its model and its context with Show sessions on, and opens it', () => {
    const { onOpenSession } = draw({ showSessions: true });
    const line = screen.getByTestId('work-session-line');
    expect(line).toHaveTextContent('Session · Opus 5.5 · 64% context');
    fireEvent.click(within(line).getByRole('button', { name: /open session/i }));
    expect(onOpenSession).toHaveBeenCalledOnce();
    expect(screen.queryByText(/Every step/)).toBeNull();
  });

  it('lists each turn that did work, headed by the words that opened it, with its steps', () => {
    draw();
    const turns = document.querySelectorAll('[data-work-turn]');
    expect(Array.from(turns, (turn) => turn.getAttribute('data-work-turn'))).toEqual(['a1', 'a2']);
    expect(turns[1]).toHaveTextContent('“Why is the sidebar busy?”');
    // Every step is drawn, thinking included; what the agent said is not.
    expect(within(turns[1] as HTMLElement).getAllByTestId('tool-call-card')).toHaveLength(1);
    expect(within(turns[1] as HTMLElement).getByTestId('thinking-block')).toBeInTheDocument();
    expect(within(turns[1] as HTMLElement).queryByText('Three causes.')).toBeNull();
  });

  it('scrolls to the turn Show work asked for, once', () => {
    const scrolled: string[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.getAttribute('data-work-turn') ?? '');
    };
    useWorkPanelFocusStore.setState({ request: { sessionId: 'scout-direct', turn: 'a1' } });
    draw();
    expect(scrolled).toEqual(['a1']);
    expect(useWorkPanelFocusStore.getState().request).toBeNull();
  });

  it('shows the live turn as it runs, and a turn that has not done anything yet', () => {
    const live = [
      ...MESSAGES.slice(0, 4),
      MESSAGES[4]!,
      { ...MESSAGES[3]!, id: '__in_progress_turn__', _streaming: true },
    ];
    draw({ messages: live, working: true });
    expect(screen.getByRole('region', { name: 'Now · replying to you' })).toBeInTheDocument();

    cleanup();
    draw({ messages: MESSAGES.slice(0, 5), working: true });
    expect(screen.getByRole('region', { name: 'Now · replying to you' })).toHaveTextContent(
      'Working…'
    );
  });

  it('says so when there is nothing yet', () => {
    draw({ messages: [] });
    expect(screen.getByText('No steps yet.')).toBeInTheDocument();
  });
});
