// @vitest-environment jsdom
/**
 * Where the Work tab's steps come from (DOR-3075). In a chat with one agent it
 * is the chat's own live list, so a turn running now shows as it runs. In a
 * group DM it is the session the picked member works in there, read again as
 * turns start and end, with honest words when it cannot be read.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SessionSnapshot } from '@dorkos/shared/session-stream';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { useSessionStreamStore } from '@/layers/entities/session';
import { WorkPanel } from '../ui/work/WorkPanel';

const panel = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => <div>{children}</div>,
}));
vi.mock('@/layers/features/status', () => ({
  useSessionDiagnostics: () => ({ model: null, contextPercent: null, runtime: null }),
  statusModelLabel: (model: string) => model,
}));
vi.mock('@/layers/features/direct-message', () => ({
  useDirectMessagePanel: () => panel.current,
  useDirectMessageAgent: () => ({ name: 'Scout' }),
  useSessionViewLinks: () => ({ openSessionView: vi.fn(), openDirectMessage: vi.fn() }),
}));

beforeEach(() => {
  useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [] });
  useAppStore.getState().setExplicitAgentPath(null);
});
afterEach(() => {
  cleanup();
  panel.current = null;
});

function draw(transport: Transport = createMockTransport()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TooltipProvider>
          <WorkPanel />
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  const view = render(tree());
  return { rerender: () => view.rerender(tree()) };
}

/** A session mid-turn: the words that opened it, and a step running now. */
function midTurn(): SessionSnapshot {
  return {
    messages: [
      { id: 'u1', role: 'user', content: 'Check the build', timestamp: '2026-10-20T14:00:00Z' },
    ],
    inProgressTurn: [
      { seq: 2, type: 'turn_start' },
      {
        seq: 3,
        type: 'tool_call',
        toolCallId: 't1',
        toolName: 'Read',
        input: '{}',
        status: 'running',
      },
    ],
    status: {
      contextUsage: null,
      cost: null,
      usage: null,
      cacheStats: null,
      model: 'claude-opus-4-6',
      permissionMode: 'default',
      todoCounts: null,
      runningSubagentCount: 0,
      lifecycle: 'streaming',
      lastError: null,
      limit: null,
      accountUsage: null,
    },
    pendingInteractions: [],
    queuedMessages: [],
    canvas: [],
    cursor: 3,
  } as unknown as SessionSnapshot;
}

describe('WorkPanel in a chat with one agent', () => {
  it('shows the turn running now, with its steps, as it runs', async () => {
    panel.current = {
      kind: 'one-to-one',
      sessionId: 's1',
      agentPath: '/agents/scout',
      showSessions: false,
    };
    draw();
    act(() => useSessionStreamStore.getState().applySnapshot('s1', midTurn()));

    const live = await screen.findByRole('region', { name: 'Now · working' });
    expect(within(live).getByTestId('tool-call-card')).toBeInTheDocument();

    // The next step lands in the same live turn.
    act(() =>
      useSessionStreamStore.getState().applyEvent('s1', {
        seq: 4,
        type: 'tool_call',
        toolCallId: 't2',
        toolName: 'Grep',
        input: '{}',
        status: 'running',
      })
    );
    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: 'Now · working' })).getAllByTestId(
          'tool-call-card'
        )
      ).toHaveLength(2)
    );
  });
});

describe('WorkPanel in a group DM', () => {
  const MEMBERS = [{ authorId: 'a1', agentPath: '/agents/qa', displayName: 'qa' }];
  const group = (working: boolean) => ({
    kind: 'group',
    roomId: 'g1',
    members: MEMBERS,
    working,
    showSessions: false,
  });
  const HISTORY = {
    messages: [
      {
        id: 'u1',
        role: 'user',
        content: 'Run the upgrade check',
        timestamp: '2026-10-20T13:02:00Z',
      },
      {
        id: 'a1',
        role: 'assistant',
        content: 'It passed.',
        timestamp: '2026-10-20T13:10:00Z',
        toolCalls: [{ toolCallId: 't1', toolName: 'Bash', input: '{}', status: 'complete' }],
      },
    ],
  };

  it('shows the picked member’s steps from the session they work in here', async () => {
    panel.current = group(false);
    useAppStore.getState().setExplicitAgentPath('/agents/qa');
    const getMessages = vi.fn(async () => HISTORY);
    draw(
      createMockTransport({
        listRoomSessions: vi.fn(async () => ({
          bindings: [{ authorId: 'a1', sessionId: 'qa-in-g1' }],
        })),
        getMessages,
      } as Partial<Transport>)
    );

    expect(await screen.findByText('Every step qa took, turn by turn.')).toBeInTheDocument();
    await waitFor(() =>
      expect(document.querySelector('[data-work-turn="a1"]')).toHaveTextContent(
        '“Run the upgrade check”'
      )
    );
    expect(getMessages).toHaveBeenCalledWith('qa-in-g1');
  });

  it('asks the room again where they work when a turn starts or ends', async () => {
    panel.current = group(false);
    useAppStore.getState().setExplicitAgentPath('/agents/qa');
    const listRoomSessions = vi.fn(async () => ({
      bindings: [{ authorId: 'a1', sessionId: 'qa-in-g1' }],
    }));
    const { rerender } = draw(
      createMockTransport({
        listRoomSessions,
        getMessages: vi.fn(async () => HISTORY),
      } as Partial<Transport>)
    );
    await waitFor(() => expect(listRoomSessions).toHaveBeenCalledTimes(1));

    panel.current = group(true);
    rerender();
    await waitFor(() => expect(listRoomSessions).toHaveBeenCalledTimes(2));
    panel.current = group(false);
    rerender();
    await waitFor(() => expect(listRoomSessions).toHaveBeenCalledTimes(3));
  });

  it('says it could not load the steps when the room cannot be read', async () => {
    panel.current = group(false);
    useAppStore.getState().setExplicitAgentPath('/agents/qa');
    draw(
      createMockTransport({
        listRoomSessions: vi.fn(async () => {
          throw new Error('403');
        }),
      } as Partial<Transport>)
    );
    expect(await screen.findByText('Couldn’t load these steps.')).toBeInTheDocument();
  });

  it('says the member has not worked here when the room binds no session for them', async () => {
    panel.current = group(false);
    useAppStore.getState().setExplicitAgentPath('/agents/qa');
    draw(
      createMockTransport({
        listRoomSessions: vi.fn(async () => ({ bindings: [] })),
      } as Partial<Transport>)
    );
    expect(await screen.findByText('qa hasn’t worked in this DM yet.')).toBeInTheDocument();
  });
});
