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
  useSearch: () => ({}),
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
import { TransportProvider } from '@/layers/shared/model';
import {
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
  transformContent?: (content: string) => Promise<string>
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <ChatPanel
          sessionId={SESSION_ID}
          {...(transformContent === undefined ? {} : { transformContent })}
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
