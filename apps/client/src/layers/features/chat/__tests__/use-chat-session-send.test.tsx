/**
 * @vitest-environment jsdom
 *
 * `useChatSession`'s two ways of handing a message to the server: the ordinary
 * send that starts a turn, and the enqueue that puts one behind the turn already
 * running (spec `persistent-session-runtime`, task 2.6).
 *
 * Was `use-message-queue-origin.test.tsx`. Its DOR-81 origin-pinning suite went
 * with the local queue in task 2.6: there is no client-side flush left to
 * misdeliver, the queue belongs to a session on the server, and each window
 * watches one session at a time. Its DOR-480 restore suite went the same way —
 * the composer holds the words until the server confirms it has them, so there
 * is nothing dequeued to put back. Both promises are now kept by construction
 * and are covered where they live, in `use-chat-queue.test.ts`.
 */
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockSession, createMockTransport } from '@dorkos/test-utils/mock-factories';
import type { Transport } from '@dorkos/shared/transport';

// Stub the shared StreamManager so attach/connect never opens a real fetch in
// jsdom; we drive the per-session store directly to simulate `/events`.
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
      subscribeEvent: vi.fn().mockReturnValue(() => {}),
    },
  };
});

vi.mock('@/layers/shared/model', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/layers/shared/model');
  const mockState = { selectedCwd: '/test/cwd', enableMessagePolling: false };
  const useAppStore = Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) =>
      selector ? selector(mockState) : mockState,
    { getState: () => mockState }
  );
  return {
    ...actual,
    useAppStore,
    // The session's own reads take their directory from the URL, not the
    // store (DOR-1444); mirrored here so this harness keeps meaning what it
    // did when both came from `selectedCwd`.
    useSafeSearch: () => ({ dir: '/test/cwd' }),
  };
});

import { useChatSession } from '../model/use-chat-session';
import {
  useSessionStreamStore,
  useSessionChatStore,
  setSessionRouteContext,
  useSessionStatus,
  resetSessionStreamBinding,
} from '@/layers/entities/session';
import { TransportProvider } from '@/layers/shared/model';
import { resetUuidCounter } from './chat-session-test-helpers';

function createWrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetUuidCounter();
  useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [] });
  useSessionChatStore.setState({ sessions: {}, sessionAccessOrder: [] });
  resetSessionStreamBinding();
});

describe('useChatSession — first send during an allocated chat’s settings save', () => {
  /** Start a real settings edit on an allocated chat and hold its server acknowledgement. */
  async function editDraftSettings(id: string) {
    let confirm!: () => void;
    let refuse!: (reason: Error) => void;
    const saving = new Promise<void>((resolve, reject) => {
      confirm = resolve;
      refuse = reject;
    });
    let model = 'original-model';
    const saveModel: Transport['updateSession'] = async (sessionId, settings) => {
      model = settings.model ?? model;
      return createMockSession({ id: sessionId, model });
    };
    const received: { id: string; content: string; model: string }[] = [];
    const transport = createMockTransport({
      updateSession: vi.fn(saveModel).mockImplementationOnce(async (...args) => {
        await saving;
        return saveModel(...args);
      }),
      postMessage: vi.fn<Transport['postMessage']>(async (sessionId, content) => {
        received.push({ id: sessionId, content, model });
        return { sessionId };
      }),
    });
    setSessionRouteContext(id, { cwd: '/test/cwd', draft: true, runtime: 'codex' });
    const hook = renderHook(
      ({ id: sessionId }) => ({
        chat: useChatSession(sessionId, { launchRuntime: 'codex' }),
        settings: useSessionStatus(sessionId, null, false, 'codex'),
      }),
      { wrapper: createWrapper(transport), initialProps: { id } }
    );
    await waitFor(() => expect(hook.result.current.chat.status).toBe('idle'));
    act(() => hook.result.current.chat.setInput('First message'));
    let send!: Promise<void>;
    act(() => {
      void hook.result.current.settings.updateSession({ model: 'chosen-model' });
      send = hook.result.current.chat.handleSubmit();
    });
    return { ...hook, transport, received, confirm, refuse, send };
  }

  it('sends once to the allocated id with its confirmed model after a settings edit', async () => {
    const id = 'allocated-settings-success';
    const { result, received, confirm, send, transport } = await editDraftSettings(id);
    let repeated!: Promise<void>;
    act(() => {
      repeated = result.current.chat.handleSubmit();
    });
    expect(received).toEqual([]);
    expect(result.current.chat.input).toBe('First message');
    await act(async () => {
      confirm();
      await Promise.all([send, repeated]);
    });
    expect(received).toEqual([{ id, content: 'First message', model: 'chosen-model' }]);
    expect(transport.postMessage).toHaveBeenCalledWith(
      id,
      'First message',
      '/test/cwd',
      expect.objectContaining({ create: true, runtime: 'codex' })
    );
    expect(result.current.chat.input).toBe('');
  });

  it('keeps the draft when settings fail and allows an explicit retry', async () => {
    const id = 'allocated-settings-failure';
    const { result, received, refuse, send } = await editDraftSettings(id);
    await act(async () => {
      refuse(new Error('Save failed'));
      await send;
    });
    expect(received).toEqual([]);
    expect(result.current.chat.input).toBe('First message');
    expect(result.current.chat.error?.retryable).toBe(false);
    await act(async () => {
      await result.current.settings.updateSession({ model: 'chosen-model' });
      await result.current.chat.handleSubmit();
    });
    expect(received).toEqual([{ id, content: 'First message', model: 'chosen-model' }]);
  });

  it('leaves the first message in its draft if the person switches chats during the save', async () => {
    const id = 'allocated-settings-switch';
    const { result, rerender, received, confirm, send } = await editDraftSettings(id);
    rerender({ id: 'another-chat' });
    act(() => result.current.chat.setInput('Another draft'));
    await act(async () => {
      confirm();
      await send;
    });
    expect(received).toEqual([]);
    expect(result.current.chat.input).toBe('Another draft');
    rerender({ id });
    expect(result.current.chat.input).toBe('First message');
  });
});

describe('useChatSession — launch-runtime handoff (opencode connect → first send)', () => {
  // The tail of the connect handoff chain: connect success → requirements
  // invalidated → OpenCode ready → the toolbar chip's onChangeRuntime sets
  // pendingRuntime, which reaches useChatSession as `launchRuntime`. This proves
  // the final link — a new session's FIRST message binds the session to OpenCode.
  it("a new session’s first message posts runtime: 'opencode'", async () => {
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));
    const transport = createMockTransport({ postMessage });

    const { result } = renderHook(
      () => useChatSession('new-session', { launchRuntime: 'opencode' }),
      { wrapper: createWrapper(transport) }
    );
    await waitFor(() => expect(result.current.status).toBe('idle'));

    act(() => result.current.setInput('First message'));
    await waitFor(() => expect(result.current.input).toBe('First message'));
    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(postMessage).toHaveBeenCalledWith(
      'new-session',
      'First message',
      '/test/cwd',
      expect.objectContaining({ runtime: 'opencode' })
    );
  });

  it('omits the runtime hint entirely when no launch runtime is selected', async () => {
    // The negative of the handoff: with no pending selection, the send carries no
    // runtime hint, leaving the server's own resolution in charge.
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));
    const transport = createMockTransport({ postMessage });

    const { result } = renderHook(() => useChatSession('plain-session'), {
      wrapper: createWrapper(transport),
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    act(() => result.current.setInput('First message'));
    await waitFor(() => expect(result.current.input).toBe('First message'));
    await act(async () => {
      await result.current.handleSubmit();
    });

    const postOptions = postMessage.mock.calls[0]?.[3] as Record<string, unknown> | undefined;
    expect(postOptions).not.toHaveProperty('runtime');
  });
});

describe('useChatSession — enqueueContent (a message that waits its turn)', () => {
  it('posts the message with the queue disposition and the queued signal', async () => {
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));
    const transport = createMockTransport({ postMessage });

    const { result } = renderHook(() => useChatSession('busy-session'), {
      wrapper: createWrapper(transport),
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await result.current.enqueueContent('and then the docs');
    });

    expect(accepted).toBe(true);
    expect(postMessage).toHaveBeenCalledWith(
      'busy-session',
      'and then the docs',
      '/test/cwd',
      expect.objectContaining({
        disposition: 'queue',
        context: expect.objectContaining({ queued: true }),
      })
    );
  });

  it('shows no optimistic bubble and latches no trigger — nothing has been said yet', async () => {
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));
    const transport = createMockTransport({ postMessage });

    const { result } = renderHook(() => useChatSession('busy-session'), {
      wrapper: createWrapper(transport),
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    await act(async () => {
      await result.current.enqueueContent('and then the docs');
    });

    const session = useSessionStreamStore.getState().getSession('busy-session');
    expect(session.optimisticUserMessage).toBeNull();
    expect(session.triggerPending).toBe(false);
  });

  it('reports a refusal as a refusal, and says so once', async () => {
    const postMessage = vi.fn().mockRejectedValue(new Error('Failed to fetch'));
    const transport = createMockTransport({ postMessage });

    const { result } = renderHook(() => useChatSession('busy-session'), {
      wrapper: createWrapper(transport),
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await result.current.enqueueContent('and then the docs');
    });

    expect(accepted).toBe(false);
    expect(result.current.error?.heading).toBe('Couldn’t queue message');
    // Not retryable: the words are still in the composer, a keystroke away.
    expect(result.current.error?.retryable).toBe(false);
  });
});

describe('useChatSession — steer and add context (the other two dispositions)', () => {
  it('steerContent posts the steer disposition, WITHOUT the queue signal', async () => {
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));
    const transport = createMockTransport({ postMessage });

    const { result } = renderHook(() => useChatSession('busy-session'), {
      wrapper: createWrapper(transport),
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await result.current.steerContent('also check the tests');
    });

    expect(accepted).toBe(true);
    const options = postMessage.mock.calls.at(-1)?.[3] as Record<string, unknown>;
    expect(options.disposition).toBe('steer');
    // A steer joins the live turn — it is not a queued message, so it carries no
    // `<queue_note>`.
    expect((options.context as { queued?: boolean } | undefined)?.queued).toBeUndefined();
  });

  it('addContextContent posts the stage disposition, WITHOUT the queue signal', async () => {
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));
    const transport = createMockTransport({ postMessage });

    const { result } = renderHook(() => useChatSession('busy-session'), {
      wrapper: createWrapper(transport),
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    await act(async () => {
      await result.current.addContextContent('for later: keep the API stable');
    });

    const options = postMessage.mock.calls.at(-1)?.[3] as Record<string, unknown>;
    expect(options.disposition).toBe('stage');
    expect((options.context as { queued?: boolean } | undefined)?.queued).toBeUndefined();
  });

  it('Add context on a chat that has not started says create, so it is not a 404 (DOR-2712)', async () => {
    // Nothing lists this session yet: the staged words are what start it.
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));
    const transport = createMockTransport({ postMessage });

    const { result } = renderHook(() => useChatSession('unstarted-session'), {
      wrapper: createWrapper(transport),
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    await act(async () => {
      await result.current.addContextContent('mind the rate limit');
    });

    expect(postMessage.mock.calls.at(-1)?.[3]).toMatchObject({
      disposition: 'stage',
      create: true,
    });
  });

  it('names the right failure when a steer does not go through', async () => {
    const postMessage = vi.fn().mockRejectedValue(new Error('Failed to fetch'));
    const transport = createMockTransport({ postMessage });

    const { result } = renderHook(() => useChatSession('busy-session'), {
      wrapper: createWrapper(transport),
    });
    await waitFor(() => expect(result.current.status).toBe('idle'));

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await result.current.steerContent('also check the tests');
    });

    expect(accepted).toBe(false);
    expect(result.current.error?.heading).toBe('Couldn’t steer the agent');
  });
});
