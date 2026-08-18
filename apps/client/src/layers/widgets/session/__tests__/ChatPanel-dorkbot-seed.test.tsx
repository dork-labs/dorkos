// @vitest-environment jsdom
/**
 * The one seam Ask DorkBot's two well-tested halves meet at.
 *
 * `useDorkBotSeed` builds the background and `useSessionSubmit` puts it on the
 * wire; each is covered on its own. What joins them is three lines in
 * `ChatPanel` — an effect that parks the provider's callback in a ref the submit
 * path reads — and that shim has no shape a unit test of either half can see.
 * Deleting it is silent: the composer is still empty, the URL is still stripped,
 * no error is raised, and the feature simply does nothing. So this file mounts
 * the REAL panel with the REAL session hook and asserts the background reaches
 * `postMessage`.
 *
 * The panel is mounted with the composer container stubbed down to a submit
 * button. Everything under test — the seed hook, the shim, `useChatSession`,
 * `useSessionSubmit`, the transport call — is the real thing; only the surface
 * a finger would touch is replaced, because "typing into the composer" is
 * already `SessionComposer`'s own suite's job.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';

// The durable stream: attach/connect must never open a real fetch in jsdom.
// Nothing is waiting on anybody. The lane reads the fleet-wide list now, and a
// bare render has no global stream behind it.
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
  useSearch: () => ({}),
  useLocation: () => ({ pathname: '/session' }),
}));

// The roster the seed reads its fleet size from.
vi.mock('@/layers/entities/mesh/model/use-mesh-agent-paths', () => ({
  useMeshAgentPaths: () => ({
    data: { agents: [{ id: 'a1', name: 'dorkbot', projectPath: '/dorkbot' }] },
  }),
}));
vi.mock('@/layers/entities/config/model/use-config', () => ({
  useConfig: () => ({ data: { version: '0.58.0', latestVersion: null } }),
}));

// The panel's neighbours. None of them is the subject; each would otherwise drag
// in a provider stack of its own.
vi.mock('@/layers/entities/command/model/use-commands', () => ({
  useCommands: () => ({ data: { commands: [] } }),
}));
vi.mock('../ui/SessionTranscript', () => ({
  SessionTranscript: vi.fn(() => <div data-testid="message-list" />),
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

// The composer, reduced to the two things this test needs: a way to put text in
// and a way to send it. `handleSubmit` is the panel's own — the same callback
// Enter reaches — so the send path under test is untouched.
vi.mock('../ui/SessionComposer', () => ({
  SessionComposer: ({
    input,
    setInput,
    handleSubmit,
  }: {
    input: string;
    setInput: (v: string) => void;
    handleSubmit: () => void;
  }) => (
    <div>
      <textarea data-testid="composer" value={input} onChange={(e) => setInput(e.target.value)} />
      <button data-testid="send" onClick={() => handleSubmit()}>
        send
      </button>
    </div>
  ),
}));

import { ChatPanel } from '../ui/ChatPanel';
import { TransportProvider } from '@/layers/shared/model';
import { setAskDorkBotOrigin, takeAskDorkBotOrigin } from '@/layers/shared/lib';
import {
  useSessionChatStore,
  useSessionListStore,
  useSessionStreamStore,
  resetSessionStreamBinding,
} from '@/layers/entities/session';
import { __resetDorkBotSeedsForTest } from '@/layers/features/chat/model/launch/use-dorkbot-seed';
import { __resetLaunchPromptsForTest } from '@/layers/features/chat/model/launch/use-launch-prompt';

function renderPanel(transport: Transport, launchSeed?: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <ChatPanel sessionId="s1" launchSeed={launchSeed} onLaunchConsumed={vi.fn()} />
      </TransportProvider>
    </QueryClientProvider>
  );
}

/** Type something and press the panel's own submit. */
async function send(text: string) {
  const composer = screen.getByTestId('composer') as HTMLTextAreaElement;
  act(() => {
    composer.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value'
  )!.set!;
  act(() => {
    setter.call(composer, text);
    composer.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await waitFor(() =>
    expect((screen.getByTestId('composer') as HTMLTextAreaElement).value).toBe(text)
  );
  await act(async () => {
    screen.getByTestId('send').click();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetDorkBotSeedsForTest();
  __resetLaunchPromptsForTest();
  takeAskDorkBotOrigin();
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

describe('ChatPanel — the Ask DorkBot seam', () => {
  it('puts the background on the first turn when the panel was launched with the seed', async () => {
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));
    setAskDorkBotOrigin('/marketplace');

    renderPanel(createMockTransport({ postMessage }), 'dorkbot-help');
    await send('why is my agent stuck?');

    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    const options = postMessage.mock.calls[0][3] as { seedContext?: string };
    expect(options.seedContext).toBeDefined();
    // The facts the mocks above establish — so this fails if the shim is wired
    // but the builder is fed nothing.
    expect(options.seedContext).toContain('/marketplace');
    expect(options.seedContext).toContain('1 agent registered');
    expect(options.seedContext).toContain('v0.58.0');
  });

  it('sends nothing extra when the panel was launched without it', async () => {
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));
    setAskDorkBotOrigin('/marketplace');

    renderPanel(createMockTransport({ postMessage }));
    await send('an ordinary question');

    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    expect(postMessage.mock.calls[0][3]).not.toHaveProperty('seedContext');
  });
});
