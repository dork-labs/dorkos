// @vitest-environment jsdom
/**
 * A chat drawn as a DM folds each reply's work into one line under it
 * (DOR-3075): "Worked · N steps · <time>" with Show work, or, while the agent
 * works, what it is doing with Watch. Both open the Work tab. Asks and
 * approvals stay inline as cards, and thinking never shows. A session draws
 * all of it, as before.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChatMessage } from '@/layers/shared/model';
import { useAppStore } from '@/layers/shared/model';
import { SessionTranscript } from '../ui/SessionTranscript';
import { WORK_PANEL_ID } from '@/layers/shared/lib';
import { useWorkPanelFocusStore } from '../model/work-panel-focus';
import { createReadCursorHarness, renderWithTransport } from './session-transcript-test-helpers';

vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useEventSubscription: () => {},
}));
vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <div>{children}</div>,
}));
vi.mock('@/layers/features/entry-actions/ui/EntryRunWithMenu', () => ({
  EntryRunWithMenu: () => null,
}));
vi.mock('@/layers/features/conversation', async () => ({
  ...(await vi.importActual<object>('@/layers/features/conversation')),
  ScrollThumb: () => null,
}));
vi.mock('@/layers/entities/agent/model/use-current-agent', () => ({
  useCurrentAgent: () => ({ data: null }),
}));
vi.mock('@/layers/entities/session/model/query/use-session-runtime', () => ({
  useSessionRuntime: () => 'claude-code',
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({
        key: `v-${i}`,
        index: i,
        start: i * 80,
        size: 80,
      })),
    getTotalSize: () => count * 80,
    measureElement: vi.fn(),
    scrollToEnd: vi.fn(),
    scrollToIndex: vi.fn(),
    isAtEnd: () => true,
  }),
}));

const readState = createReadCursorHarness();

beforeEach(() => {
  readState.reset();
  useWorkPanelFocusStore.setState({ request: null });
  useAppStore.setState({ rightPanelOpen: false, activeRightPanelTab: null });
});
afterEach(cleanup);

const ASKED = '2026-10-20T14:41:00.000Z';
const REPLIED = '2026-10-20T14:42:12.000Z';

const tool = (id: string, toolName: string) => ({
  type: 'tool_call' as const,
  toolCallId: id,
  toolName,
  input: '{}',
  status: 'complete' as const,
});

const MESSAGES: ChatMessage[] = [
  {
    id: 'u1',
    role: 'user',
    content: 'Why is the sidebar busy?',
    parts: [{ type: 'text', text: 'Why is the sidebar busy?' }],
    timestamp: ASKED,
  },
  {
    id: 'a1',
    role: 'assistant',
    content: 'Three causes.',
    parts: [
      { type: 'thinking', text: 'Rows come from three sources' },
      tool('t1', 'Read'),
      tool('t2', 'Grep'),
      tool('t3', 'TodoWrite'),
      { type: 'text', text: 'Three causes.' },
    ],
    timestamp: REPLIED,
  },
];

const SCOUT = { id: 'scout-manifest', displayName: 'Scout', emoji: '🦊', color: 'hsl(20 80% 50%)' };
const DM = { agent: SCOUT, humanName: 'Dorian', settled: true };

function draw(messages: ChatMessage[], directMessage: typeof DM | null = DM) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithTransport(
    <QueryClientProvider client={queryClient}>
      <SessionTranscript
        sessionId="scout-direct"
        messages={messages}
        directMessage={directMessage}
      />
    </QueryClientProvider>,
    readState.transport
  );
}

describe('SessionTranscript folding a DM reply’s work', () => {
  it('folds tools, thinking and todos into one line under the reply', () => {
    draw(MESSAGES);

    expect(screen.getByText('Three causes.')).toBeInTheDocument();
    expect(screen.getByTestId('dm-worked-line')).toHaveTextContent('Worked · 3 steps · 1m 12s');
    // Thinking never shows inline, and neither does a tool card.
    expect(screen.queryByText('Rows come from three sources')).toBeNull();
    expect(document.querySelector('[data-testid="tool-call-card"]')).toBeNull();
  });

  it('opens the Work tab on that turn from Show work', () => {
    draw(MESSAGES);

    fireEvent.click(screen.getByRole('button', { name: 'Show work' }));

    expect(useAppStore.getState().rightPanelOpen).toBe(true);
    expect(useAppStore.getState().activeRightPanelTab).toBe(WORK_PANEL_ID);
    expect(useWorkPanelFocusStore.getState().request).toEqual({
      sessionId: 'scout-direct',
      turn: 'a1',
    });
  });

  it('says what the agent is doing while it works, and Watch opens the live turn', () => {
    const live: ChatMessage[] = [
      MESSAGES[0]!,
      { ...MESSAGES[1]!, id: '__in_progress_turn__', timestamp: '', _streaming: true },
    ];
    draw(live);

    expect(screen.getByTestId('dm-working-line')).toHaveTextContent('Working…');
    expect(screen.queryByTestId('dm-worked-line')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Watch' }));
    expect(useWorkPanelFocusStore.getState().request).toEqual({
      sessionId: 'scout-direct',
      turn: 'live',
    });
    expect(useAppStore.getState().activeRightPanelTab).toBe(WORK_PANEL_ID);
  });

  it('draws the live line only under the segment still being written after a steer', () => {
    const steered: ChatMessage[] = [
      MESSAGES[0]!,
      { ...MESSAGES[1]!, id: 'seg-1', timestamp: '', _streaming: true },
      {
        id: 'steer',
        role: 'user',
        content: 'Check the footer too',
        parts: [{ type: 'text', text: 'Check the footer too' }],
        timestamp: '',
        _streaming: true,
      },
      {
        id: '__in_progress_turn__',
        role: 'assistant',
        content: '',
        parts: [tool('t9', 'Read')],
        timestamp: '',
        _streaming: true,
      },
    ];
    draw(steered);

    expect(screen.getAllByTestId('dm-working-line')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Watch' })).toHaveLength(1);
    // The closed segment folds its work like any finished reply.
    expect(screen.getByTestId('dm-worked-line')).toHaveTextContent('Worked · 3 steps');
  });

  it('keeps the live line under the closed segment right after a steer, before the next one speaks', () => {
    const justSteered: ChatMessage[] = [
      MESSAGES[0]!,
      { ...MESSAGES[1]!, id: 'seg-1', timestamp: '', _streaming: true },
      {
        id: 'steer',
        role: 'user',
        content: 'Check the footer too',
        parts: [{ type: 'text', text: 'Check the footer too' }],
        timestamp: '',
        _streaming: true,
      },
    ];
    draw(justSteered);

    expect(screen.getAllByTestId('dm-working-line')).toHaveLength(1);
    expect(screen.queryByTestId('dm-worked-line')).toBeNull();
  });

  it('describes each Show work by the reply it opens', () => {
    draw(MESSAGES);
    const button = screen.getByRole('button', { name: 'Show work' });
    const described = document.getElementById(button.getAttribute('aria-describedby') ?? '');
    expect(described).toHaveTextContent('Three causes.');
  });

  it('keeps an approval inline as a card with its buttons', () => {
    const asking: ChatMessage[] = [
      MESSAGES[0]!,
      {
        ...MESSAGES[1]!,
        id: 'a2',
        _streaming: true,
        parts: [
          tool('t1', 'Read'),
          {
            type: 'tool_call',
            toolCallId: 'ask-1',
            toolName: 'Bash',
            input: '{"command":"rm -rf build"}',
            status: 'pending',
            interactiveType: 'approval',
          },
        ],
      },
    ];
    draw(asking);

    const card = screen.getByTestId('tool-approval');
    expect(card).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^allow/i })).toBeInTheDocument();
    // The tool call before it is work, folded under the live line.
    expect(screen.getByTestId('dm-working-line')).toBeInTheDocument();
  });

  it('names no time for a turn under a second', () => {
    const quick: ChatMessage[] = [
      MESSAGES[0]!,
      {
        ...MESSAGES[1]!,
        parts: [tool('t1', 'Read'), { type: 'text', text: 'Three causes.' }],
        timestamp: '2026-10-20T14:41:00.600Z',
      },
    ];
    draw(quick);

    expect(screen.getByTestId('dm-worked-line')).toHaveTextContent(/^Worked · 1 step\s*Show work$/);
  });

  it('names no time it does not know', () => {
    draw(MESSAGES.map((message) => ({ ...message, timestamp: '' })));

    expect(screen.getByTestId('dm-worked-line')).toHaveTextContent(
      /^Worked · 3 steps\s*Show work$/
    );
  });

  it('draws the session’s work as before outside a DM', () => {
    draw(MESSAGES, null);

    expect(screen.queryByTestId('dm-worked-line')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show work' })).toBeNull();
  });
});
