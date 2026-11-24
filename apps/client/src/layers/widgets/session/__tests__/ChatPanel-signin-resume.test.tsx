// @vitest-environment jsdom
/** Sign in from the error card, and the message that failed sends itself (DOR-1650). */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import type { Transport } from '@dorkos/shared/transport';
import type { Session } from '@dorkos/shared/types';
import type { SessionSnapshot } from '@dorkos/shared/session-stream';

// The durable stream: attach/connect must never open a real fetch in jsdom.
vi.mock('@/layers/features/continue-on-account', () => ({
  AccountLimitBanner: () => null,
  AccountLimitMarker: () => null,
  useLimitComposer: () => ({ canSubmit: true, placeholder: null }),
  useSessionHasLimit: () => false,
}));

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
      getListConnectionState: vi.fn().mockReturnValue('connected'),
      getListFailedAttempts: vi.fn().mockReturnValue(0),
      subscribeEvent: vi.fn().mockReturnValue(() => {}),
    },
  };
});

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
  useRouter: () => ({ state: { location: { pathname: '/session', search: {} } } }),
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: '/session' } }),
  useSearch: () => ({}),
  useLocation: () => ({ pathname: '/session' }),
}));

// The settings deep-link needs router context; everything else stays real,
// because the card reaches the transport through the real provider.
const { openSettings } = vi.hoisted(() => ({ openSettings: vi.fn() }));
vi.mock('@/layers/shared/model', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/layers/shared/model');
  return { ...actual, useSettingsDeepLink: () => ({ open: openSettings }) };
});

// The card resolves the failing runtime off the session list. Mocking the LIST
// rather than a lookup keeps the card's own resolution running for real.
vi.mock('@/layers/entities/session/model/query/use-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session/model/query/use-sessions')>()),
  useSessions: () => ({
    sessions: [{ id: 's1', runtime: 'claude-code' } as Session],
    isLoading: false,
  }),
}));

vi.mock('@/layers/entities/config/model/use-config', () => ({
  useConfig: () => ({ data: { version: '0.66.0', latestVersion: null } }),
}));
vi.mock('@/layers/entities/command/model/use-commands', () => ({
  useCommands: () => ({ data: { commands: [] } }),
}));
vi.mock('@/layers/features/chat/ui/tasks/TaskListPanel', () => ({ TaskListPanel: () => null }));
vi.mock('@/layers/features/chat/ui/CelebrationOverlay', () => ({ CelebrationOverlay: () => null }));
/** Standing state for the mocked permission-picker store — see the mock below. */
const PICKER_STUB = {
  available: false,
  open: false,
  setOpen: () => {},
  setAvailable: () => {},
};
vi.mock('@/layers/features/status', () => ({
  // The panel closes the permission picker as the session changes.
  useSessionPermissionPicker: (select: (s: typeof PICKER_STUB) => unknown) => select(PICKER_STUB),
  // The panel reads this to decide whether a read-only session needs its one explanation
  // (DOR-2019).
  useReadOnlyModeHint: () => ({ eligible: false, runtimeLabel: 'Codex', dismiss: () => {} }),
  ReadOnlyModeNotice: () => null,
  useRuntimeChip: () => ({ runtime: 'claude-code' }),
}));

// The composer, reduced to a box — the draft is one of the reasons the resume
// declines, so a test needs to be able to type into it.
vi.mock('../ui/SessionComposer', () => ({
  SessionComposer: ({ input, setInput }: { input: string; setInput: (v: string) => void }) => (
    <textarea data-testid="composer" value={input} onChange={(e) => setInput(e.target.value)} />
  ),
}));

import { ChatPanel } from '../ui/ChatPanel';
import { EventStreamProvider, TransportProvider } from '@/layers/shared/model';
import {
  useSessionChatStore,
  useSessionListStore,
  useSessionStreamStore,
  resetSessionStreamBinding,
} from '@/layers/entities/session';

const SESSION_ID = 's1';
const FAILED_PROMPT = 'fix the build';

/** A conversation whose last turn died on a dead sign-in. */
function authFailedSnapshot({
  inline,
  queued = [],
}: {
  inline: boolean;
  queued?: { id: string; content: string }[];
}): SessionSnapshot {
  return {
    messages: [
      { id: 'h1', role: 'user', content: FAILED_PROMPT, timestamp: '2026-01-01T00:00:00Z' },
      ...(inline
        ? [
            {
              id: 'h2',
              role: 'assistant' as const,
              content: '',
              parts: [
                {
                  type: 'error' as const,
                  message: 'Your Claude sign-in stopped working.',
                  category: 'auth_error' as const,
                },
              ],
              timestamp: '2026-01-01T00:00:01Z',
            },
          ]
        : []),
    ],
    inProgressTurn: null,
    status: {
      contextUsage: null,
      cost: null,
      usage: null,
      cacheStats: null,
      model: 'claude-opus-4-6',
      permissionMode: 'default',
      todoCounts: null,
      runningSubagentCount: 0,
      lifecycle: 'error',
      lastError: {
        type: 'error',
        message: 'Your Claude sign-in stopped working.',
        category: 'auth_error',
      },
    },
    pendingInteractions: [],
    queuedMessages: queued.map((q) => ({
      ...q,
      disposition: 'queue',
      enqueuedAt: 1,
      // Another client's id — the case the rule is actually about.
      enqueuedBy: 'some-other-window',
    })),
    cursor: 2,
  } as unknown as SessionSnapshot;
}

/** Mount the panel and hydrate it with a session that just auth-failed. */
async function mountFailedSession(
  transport: Transport,
  opts: { inline: boolean; queued?: { id: string; content: string }[] }
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <EventStreamProvider>
          <ChatPanel sessionId={SESSION_ID} />
        </EventStreamProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  act(() => {
    useSessionStreamStore.getState().applySnapshot(SESSION_ID, authFailedSnapshot(opts));
  });
  return view;
}

/**
 * A `BroadcastChannel` that fans a post out to every OTHER instance, so a test
 * can act as the second browser window. jsdom ships none.
 */
function installFakeBroadcastChannel() {
  const instances: FakeChannel[] = [];
  class FakeChannel {
    listeners = new Set<(event: MessageEvent) => void>();
    constructor(public name: string) {
      instances.push(this);
    }
    postMessage(data: unknown): void {
      for (const other of instances) {
        if (other === this || other.name !== this.name) continue;
        for (const listener of other.listeners) listener({ data } as MessageEvent);
      }
    }
    addEventListener(_t: string, h: (event: MessageEvent) => void): void {
      this.listeners.add(h);
    }
    removeEventListener(_t: string, h: (event: MessageEvent) => void): void {
      this.listeners.delete(h);
    }
    close(): void {
      this.listeners.clear();
    }
  }
  const original = globalThis.BroadcastChannel;
  globalThis.BroadcastChannel = FakeChannel as unknown as typeof BroadcastChannel;
  return () => {
    globalThis.BroadcastChannel = original;
  };
}

/** Type into the panel's composer, the way a person would mid-sign-in. */
async function typeDraft(text: string) {
  const composer = screen.getByTestId('composer') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value'
  )!.set!;
  act(() => {
    setter.call(composer, text);
    composer.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await waitFor(() => expect(composer.value).toBe(text));
}

/** A transport whose sign-in and send are both recorded. */
function recordingTransport() {
  const postMessage = vi
    .fn()
    .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));
  const delegateRuntimeLogin = vi.fn(async () => ({ ok: true }));
  return {
    transport: createMockTransport({ postMessage, delegateRuntimeLogin }),
    postMessage,
    delegateRuntimeLogin,
  };
}

/** Press the card's own Sign in button and let the login settle. */
async function clickSignIn() {
  const button = await screen.findByTestId('auth-error-signin-button');
  await act(async () => {
    button.click();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

/** Press Sign in and wait for the card to confirm the login landed. */
async function signInAndSettle() {
  await clickSignIn();
  await waitFor(() => {
    expect(screen.getByTestId('auth-error-signin-success')).toBeInTheDocument();
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

describe('ChatPanel — signing in re-sends the turn that failed (DOR-1650)', () => {
  it('re-sends the failed prompt from the inline card in the transcript', async () => {
    // **Seeded defect:** drop `onSigninComplete` at any hop on the TRANSCRIPT path — `ChatPanel`
    // → `SessionTranscript` → `SessionMessage` → `MessageProvider` → `AssistantMessageContent` →
    // `ErrorMessageBlock` — and this is what goes red.
    const { transport, postMessage } = recordingTransport();
    await mountFailedSession(transport, { inline: true });

    await clickSignIn();

    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    expect(postMessage.mock.calls[0][1]).toBe(FAILED_PROMPT);
  });

  it('sends nothing when another client has a message waiting on the queue', async () => {
    // Purpose: the seam between the rule and where its input comes from, which the rule's own
    // unit tests cannot cross — they are handed `queuedCount`.
    const { transport, postMessage } = recordingTransport();
    await mountFailedSession(transport, {
      inline: true,
      queued: [{ id: 'q1', content: 'and then deploy it' }],
    });

    await clickSignIn();

    expect(postMessage).not.toHaveBeenCalled();
  });

  it('sends once per sign-in, not once per settled read', async () => {
    // The once-only latch lives in `useDelegateRuntimeLogin`, keyed by mutation id per
    // QueryClient.
    const { transport, postMessage, delegateRuntimeLogin } = recordingTransport();
    await mountFailedSession(transport, { inline: true });

    await clickSignIn();

    await waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    expect(delegateRuntimeLogin).toHaveBeenCalledTimes(1);
    // Settle anything still queued behind the login before counting.
    await act(async () => {
      await Promise.resolve();
    });
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when the person is already typing something else', async () => {
    // The moved-on rule, at the seam that owns it.
    const { transport, postMessage } = recordingTransport();
    await mountFailedSession(transport, { inline: true });
    await typeDraft('actually, do this instead');

    // Nothing is sent, so the status stays `error` and the card stays put —
    // which is the whole point: it is the surface that hands the choice back.
    await signInAndSettle();

    expect(postMessage).not.toHaveBeenCalled();
    expect(screen.getByTestId('composer')).toHaveValue('actually, do this instead');
    // The card says so honestly and hands the decision back.
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('sends nothing when another window already announced this resume', async () => {
    // Purpose: the wiring of the cross-window claim, at the seam that owns it.
    const restore = installFakeBroadcastChannel();
    try {
      const { transport, postMessage } = recordingTransport();
      await mountFailedSession(transport, { inline: true });

      // The other window gets there first.
      const otherWindow = new BroadcastChannel('dorkos:signin-resume');
      act(() => otherWindow.postMessage({ sessionId: SESSION_ID }));

      await clickSignIn();

      expect(postMessage).not.toHaveBeenCalled();
      otherWindow.close();
    } finally {
      restore();
    }
  });

  it('sends nothing when the sign-in itself failed', async () => {
    // No retry loop, and no send: a sign-in that did not land fixed nothing.
    const postMessage = vi
      .fn()
      .mockImplementation((sessionId: string) => Promise.resolve({ sessionId }));
    const transport = createMockTransport({
      postMessage,
      delegateRuntimeLogin: vi.fn(async () => ({ ok: false, error: 'Sign-in timed out.' })),
    });
    await mountFailedSession(transport, { inline: true });

    const button = await screen.findByTestId('auth-error-signin-button');
    await act(async () => {
      button.click();
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Sign-in timed out.');
    expect(postMessage).not.toHaveBeenCalled();
  });
});
