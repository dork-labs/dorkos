// @vitest-environment jsdom
/**
 * The composer empties when the words are genuinely on their way, and not one
 * moment sooner.
 *
 * This used to be structural: `useSessionSubmit.handleSubmit` hard-coded a
 * `true` in the `clearInput` position of `executeSubmission`, so no caller
 * could get it wrong. DOR-1354 made it a caller-supplied option — `ChatPanel` passes
 * `{ clearInput: true }` into the session's `ConversationTarget.send` — which
 * moved the guarantee out of the function and into one line of wiring that
 * nothing was watching. Dropping that line left every one of the repo's 954
 * client test files green while the box stopped emptying on every send.
 *
 * So both halves are pinned here, at the seam that owns them, with the REAL
 * submit path underneath: the clear happens on a confirmed send, and it does
 * NOT happen when the attachment transform throws (DOR-480 — the words are the
 * only copy, and an upload that failed must leave them where they were typed).
 *
 * The panel is mounted with the composer stubbed down to a textarea and a send
 * button that calls `target.send` — the same port Enter reaches in the real
 * composer. Everything under it is real: `useChatSession`, `useSessionSubmit`,
 * `executeSubmission`, the chat store the draft lives in.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { Session } from '@dorkos/shared/types';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

const routerSearch = vi.hoisted(() => ({ current: {} as Record<string, string> }));

// The durable stream: attach/connect must never open a real fetch in jsdom.
vi.mock('@/layers/entities/attention', () => ({
  usePendingInteractions: () => ({ interactions: [], isLoading: false }),
}));

vi.mock('@/layers/shared/lib/transport', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/layers/shared/lib/transport');
  return {
    ...actual,
    streamManager: {
      connectList: vi.fn(),
      setListeners: vi.fn(),
      attachSession: vi.fn(),
      detachSession: vi.fn(),
      releaseSession: vi.fn(),
      getAttachedSessionId: vi.fn().mockReturnValue(null),
      subscribeListConnectionState: vi.fn().mockReturnValue(() => {}),
    },
  };
});

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => ({ state: { location: { pathname: '/session', search: {} } } }),
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: '/session' } }),
  useSearch: () => routerSearch.current,
  useLocation: () => ({ pathname: '/session' }),
}));

vi.mock('@/layers/entities/config/model/use-config', () => ({
  useConfig: () => ({ data: { version: '0.58.0', latestVersion: null } }),
}));

// The panel's neighbours. None of them is the subject; each would otherwise
// drag in a provider stack of its own.
vi.mock('@/layers/entities/command/model/use-commands', () => ({
  useCommands: () => ({ data: { commands: [] } }),
}));
vi.mock('../ui/SessionTranscript', () => ({
  SessionTranscript: () => <div data-testid="chat-message-area" />,
}));
vi.mock('@/layers/features/chat/ui/tasks/TaskListPanel', () => ({ TaskListPanel: () => null }));
vi.mock('@/layers/features/chat/ui/CelebrationOverlay', () => ({ CelebrationOverlay: () => null }));
vi.mock('@/layers/features/status', () => ({
  useRuntimeChip: () => ({ runtime: null }),
  TurnFailedNotice: () => null,
  TerminalReasonChip: () => null,
}));
vi.mock('@/layers/features/chat/ui/status', () => ({
  TurnFailedNotice: () => null,
  TerminalReasonChip: () => null,
  ChatStatusSection: () => null,
}));

// The composer, reduced to a box and a send that goes through the port.
vi.mock('../ui/SessionComposer', async () => {
  const { useConversation } = await import('@/layers/features/conversation');
  return {
    SessionComposer: ({ input, setInput }: { input: string; setInput: (v: string) => void }) => {
      const { target } = useConversation();
      return (
        <div>
          <textarea
            data-testid="composer"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button data-testid="send" onClick={() => void target?.send({ text: input })}>
            send
          </button>
        </div>
      );
    },
  };
});

import { ChatPanel } from '../ui/ChatPanel';
import { TransportProvider, useAgentBirthStore, useAppStore } from '@/layers/shared/model';
import { agentKeys } from '@/layers/entities/agent';
import {
  sessionKeys,
  useSessionChatStore,
  useSessionListStore,
  useSessionStreamStore,
  resetSessionStreamBinding,
} from '@/layers/entities/session';

const SESSION_ID = 's1';

/** The draft this session is holding right now, straight out of the store. */
function draft(): string {
  return useSessionChatStore.getState().getSession(SESSION_ID).input;
}

function renderPanel(
  transport: Transport,
  transformContent?: (content: string) => Promise<string>,
  seedQuery?: (queryClient: QueryClient) => void,
  panelProps?: Partial<React.ComponentProps<typeof ChatPanel>>
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  seedQuery?.(queryClient);
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <ChatPanel
          sessionId={SESSION_ID}
          {...(transformContent === undefined ? {} : { transformContent })}
          {...panelProps}
        />
      </TransportProvider>
    </QueryClientProvider>
  );
}

/** Type something and press the panel's own submit. */
async function send(text: string) {
  const composer = screen.getByTestId('composer') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value'
  )!.set!;
  act(() => {
    setter.call(composer, text);
    composer.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await waitFor(() => expect(draft()).toBe(text));
  await act(async () => {
    screen.getByTestId('send').click();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  routerSearch.current = {};
  useAppStore.setState({ selectedCwd: null });
  useAgentBirthStore.setState({ records: {} });
  useSessionChatStore.setState({ sessions: {}, sessionAccessOrder: [] });
  useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [] });
  useSessionListStore.setState({
    sessions: {},
    statuses: {},
    statusCwds: {},
    unseen: {},
    rekeys: {},
  });
  resetSessionStreamBinding();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(cleanup);

describe('ChatPanel — the send owns the clear (DOR-1354)', () => {
  it('waits for newborn-agent provenance, then starts Codex with the registered path', async () => {
    let resolveAgent!: (agent: AgentManifest | null) => void;
    const getAgentByPath = vi.fn(
      () =>
        new Promise<AgentManifest | null>((resolve) => {
          resolveAgent = resolve;
        })
    );
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));
    useAppStore.setState({ selectedCwd: '/test/dir' });
    useAgentBirthStore.getState().register(SESSION_ID, {
      name: 'scout',
      displayName: 'Scout',
      agentId: 'agent-scout',
      bornAt: '2026-09-08T00:00:00.000Z',
      path: '/test/dir',
      runtime: 'codex',
      kickoffMessage: '<dork-kickoff>Say hello</dork-kickoff>',
    });

    renderPanel(createMockTransport({ getAgentByPath, postMessage }), undefined, undefined, {
      launchRuntime: 'codex',
    });
    await waitFor(() => expect(getAgentByPath).toHaveBeenCalledWith('/test/dir'));

    expect(postMessage).not.toHaveBeenCalled();
    expect(useAgentBirthStore.getState().records[SESSION_ID].fired).toBe(false);

    act(() => {
      resolveAgent({
        workspace: { mode: 'home' },
        id: 'agent-scout',
        name: 'scout',
        description: '',
        runtime: 'codex',
        capabilities: [],
        behavior: { responseMode: 'always' },
        registeredAt: '2026-09-08T00:00:00.000Z',
        registeredBy: 'test',
        personaEnabled: true,
        enabledToolGroups: {},
        mcpServers: [],
      });
    });

    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    expect(postMessage).toHaveBeenCalledWith(
      SESSION_ID,
      '<dork-kickoff>Say hello</dork-kickoff>',
      '/test/dir',
      expect.objectContaining({ runtime: 'codex', agentPath: '/test/dir' })
    );
  });

  it('keeps a manual first send closed while agent provenance is pending', async () => {
    const getAgentByPath = vi.fn(() => new Promise<never>(() => {}));
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));

    useAppStore.setState({ selectedCwd: '/test/dir' });
    renderPanel(createMockTransport({ getAgentByPath, postMessage }));
    await waitFor(() => expect(getAgentByPath).toHaveBeenCalledWith('/test/dir'));
    await send('wait for provenance');

    expect(postMessage).not.toHaveBeenCalled();
    expect(draft()).toBe('wait for provenance');
  });

  it('keeps an auto-send launch armed until agent provenance resolves', async () => {
    let resolveAgent!: (agent: AgentManifest | null) => void;
    const getAgentByPath = vi.fn(
      () =>
        new Promise<AgentManifest | null>((resolve) => {
          resolveAgent = resolve;
        })
    );
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));
    const onLaunchConsumed = vi.fn();
    const streamState = useSessionStreamStore.getState().getSession(SESSION_ID);
    useSessionStreamStore.setState({
      sessions: { [SESSION_ID]: { ...streamState, streamReadyCursor: 0 } },
      sessionAccessOrder: [SESSION_ID],
    });
    useAppStore.setState({ selectedCwd: '/test/dir' });

    renderPanel(createMockTransport({ getAgentByPath, postMessage }), undefined, undefined, {
      launchPrompt: 'run after provenance resolves',
      launchSend: true,
      onLaunchConsumed,
    });
    await waitFor(() => expect(getAgentByPath).toHaveBeenCalledWith('/test/dir'));
    await waitFor(() => expect(draft()).toBe('run after provenance resolves'));

    expect(postMessage).not.toHaveBeenCalled();
    expect(onLaunchConsumed).not.toHaveBeenCalled();

    act(() => {
      resolveAgent({
        workspace: { mode: 'home' },
        id: 'agent-a',
        name: 'agent-a',
        description: '',
        runtime: 'claude-code',
        capabilities: [],
        behavior: { responseMode: 'always' },
        registeredAt: '2026-09-06T00:00:00.000Z',
        registeredBy: 'test',
        personaEnabled: true,
        enabledToolGroups: {},
        mcpServers: [],
      });
    });

    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    expect(postMessage.mock.calls[0]?.[3]).toMatchObject({ agentPath: '/test/dir' });
    expect(onLaunchConsumed).toHaveBeenCalledTimes(1);
  });

  it('uses the URL-first directory for a cached-provenance launch auto-send', async () => {
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));
    const getAgentByPath = vi.fn().mockRejectedValue(new Error('cache should satisfy this lookup'));
    const cachedAgent = {
      workspace: { mode: 'home' },
      id: 'agent-url',
      name: 'URL agent',
      description: '',
      runtime: 'claude-code',
      capabilities: [],
      behavior: { responseMode: 'always' },
      registeredAt: '2026-09-06T00:00:00.000Z',
      registeredBy: 'test',
      personaEnabled: true,
      enabledToolGroups: {},
      mcpServers: [],
    } satisfies AgentManifest;
    const streamState = useSessionStreamStore.getState().getSession(SESSION_ID);
    useSessionStreamStore.setState({
      sessions: { [SESSION_ID]: { ...streamState, streamReadyCursor: 0 } },
      sessionAccessOrder: [SESSION_ID],
    });
    useAppStore.setState({ selectedCwd: '/store/default' });
    routerSearch.current = { dir: '/url/agent' };

    renderPanel(
      createMockTransport({ getAgentByPath, postMessage }),
      undefined,
      (queryClient) => {
        queryClient.setQueryData(agentKeys.byPath('/url/agent'), cachedAgent);
      },
      {
        launchPrompt: 'run in the URL directory',
        launchSend: true,
      }
    );

    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    expect(getAgentByPath).not.toHaveBeenCalled();
    expect(postMessage.mock.calls[0]?.[2]).toBe('/url/agent');
    expect(postMessage.mock.calls[0]?.[3]).toMatchObject({ agentPath: '/url/agent' });
  });

  it('keeps a first send closed until a failed agent lookup is retried', async () => {
    const getAgentByPath = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary lookup failure'))
      .mockResolvedValue(null);
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));

    useAppStore.setState({ selectedCwd: '/test/dir' });
    renderPanel(createMockTransport({ getAgentByPath, postMessage }));
    await waitFor(() => expect(getAgentByPath).toHaveBeenCalledWith('/test/dir'));
    await send('do not lose my owner');

    expect(postMessage).not.toHaveBeenCalled();
    expect(draft()).toBe('do not lose my owner');
    expect(screen.getByText('Couldn’t check this directory')).toBeInTheDocument();
    screen.getByRole('button', { name: 'Retry' }).click();
    await waitFor(() => expect(getAgentByPath).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByText('Couldn’t check this directory')).not.toBeInTheDocument()
    );

    await send('ordinary directories stay unowned');
    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    expect(postMessage.mock.calls[0]?.[3]).not.toHaveProperty('agentPath');
  });

  it('allows an existing session reply when the agent lookup is unavailable', async () => {
    const getAgentByPath = vi.fn().mockRejectedValue(new Error('temporary lookup failure'));
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));
    const existing = {
      id: SESSION_ID,
      title: 'Existing session',
      createdAt: '2026-09-06T00:00:00.000Z',
      updatedAt: '2026-09-06T00:00:00.000Z',
      runtime: 'claude-code',
    } as Session;

    useAppStore.setState({ selectedCwd: '/test/dir' });
    renderPanel(
      createMockTransport({
        getAgentByPath,
        postMessage,
        listSessions: vi.fn().mockResolvedValue({ sessions: [existing] }),
      }),
      undefined,
      (queryClient) => {
        queryClient.setQueryData(sessionKeys.list('/test/dir'), [existing]);
      }
    );
    await waitFor(() => expect(getAgentByPath).toHaveBeenCalledWith('/test/dir'));

    await send('reply to the existing session');

    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Couldn’t check this directory')).not.toBeInTheDocument();
  });

  it('empties the composer once the trigger has been accepted', async () => {
    // **Seeded defect:** drop `{ clearInput: true }` from `sendMessage` in
    // `ChatPanel` and this is the only assertion in the client suite that goes
    // red. That is the entire reason this file exists.
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));

    renderPanel(createMockTransport({ postMessage }));
    await send('ship it');

    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    expect(postMessage.mock.calls[0][1]).toBe('ship it');
    await waitFor(() => expect(draft()).toBe(''));
  });

  it('leaves the words in the box when the attachment transform throws', async () => {
    // DOR-480, restated at the new seam: the clear runs INSIDE the submit,
    // after the transform succeeds. Hoisting it up to the caller — clearing
    // beside `target.send` rather than passing the option — would empty the box
    // on a failed upload with nothing anywhere holding the sentence.
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));
    const transformContent = vi.fn().mockRejectedValue(new Error('The attachment did not upload.'));

    renderPanel(createMockTransport({ postMessage }), transformContent);
    await send('look at this file');

    await waitFor(() => expect(transformContent).toHaveBeenCalledTimes(1));
    // Nothing was sent, and the sentence is still exactly where it was typed.
    expect(postMessage).not.toHaveBeenCalled();
    expect(draft()).toBe('look at this file');
  });
});
