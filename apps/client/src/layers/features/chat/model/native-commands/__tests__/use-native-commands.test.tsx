/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { TransportProvider } from '@/layers/shared/model';
import { createQueryClientConfig } from '@/layers/shared/lib';
import { createMockTransport } from '@dorkos/test-utils';
import { useNativeCommands, isNativeCommandContent } from '../use-native-commands';
import { useUsageReveal } from '../../use-usage-reveal';
import { parseNativeCommand } from '../registry';

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (message: string) => toastSuccess(message),
    error: (message: string) => toastError(message),
  },
}));

// `/clear` navigation is injected by the host; a spy stands in for it here.
const startFreshSession = vi.fn();

describe('useNativeCommands', () => {
  let transport: ReturnType<typeof createMockTransport>;

  beforeEach(() => {
    vi.clearAllMocks();
    useUsageReveal.setState({ open: false });
    transport = createMockTransport();
    vi.mocked(transport.updateSession).mockResolvedValue({
      id: 's1',
      title: 'Foo',
      createdAt: '',
      updatedAt: '',
      permissionMode: 'default',
      runtime: 'claude-code',
    });
  });

  function setup(
    sessionId: string | null = 's1',
    cwd: string | null = '/repo',
    compact?: { supported: boolean; runtimeLabel: string },
    queryClient: QueryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
  ) {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
    return renderHook(() => useNativeCommands(cwd, sessionId, { startFreshSession, compact }), {
      wrapper,
    });
  }

  it('renames the current session for "/rename Foo" and reports handled + ran', async () => {
    // Happy path: the title is forwarded to the existing rename transport.
    const { result } = setup('s1', '/repo');
    let outcome: ReturnType<typeof result.current.tryRun> = { handled: false };
    act(() => {
      outcome = result.current.tryRun('/rename Foo');
    });
    // `confirmed` rides along because the rename is an optimistic mutation that
    // outlives `tryRun` — `ran: true` here only means "the write was fired".
    expect(outcome).toEqual({ handled: true, ran: true, confirmed: expect.any(Promise) });
    await waitFor(() =>
      expect(transport.updateSession).toHaveBeenCalledWith('s1', { title: 'Foo' }, '/repo')
    );
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Renamed session to "Foo"'));
  });

  it('settles /rename even when the composer unmounts before the mutation lands', async () => {
    // React Query drops a mutation's PER-CALL onSuccess/onError if the component
    // unmounts first. Building `confirmed` from those left a queued `/rename`
    // neither restored nor confirmed — permanent limbo, holding its restore
    // closure forever (DOR-480). The mutation's own promise always settles.
    // Under the per-call implementation this assertion never resolves at all.
    const { result, unmount } = setup('s1', '/repo');
    let confirmed: Promise<boolean> | undefined;
    act(() => {
      const outcome = result.current.tryRun('/rename Foo');
      if (outcome.handled) confirmed = outcome.confirmed;
    });
    expect(confirmed).toBeInstanceOf(Promise);

    unmount();

    await expect(confirmed).resolves.toBe(true);
  });

  it('reports a failed /rename as not confirmed rather than leaving it pending', async () => {
    vi.mocked(transport.updateSession).mockRejectedValue(new Error('boom'));
    const { result } = setup('s1', '/repo');
    let confirmed: Promise<boolean> | undefined;
    act(() => {
      const outcome = result.current.tryRun('/rename Foo');
      if (outcome.handled) confirmed = outcome.confirmed;
    });

    // `false`, never a rejection — the caller's undo runs off a resolved value.
    await expect(confirmed).resolves.toBe(false);
  });

  it('only shows the success toast after the rename succeeds, never on a failure', async () => {
    // Finding 2/7: the success toast moved into the mutation's onSuccess. A
    // rejected updateSession rolls the title back and surfaces an error toast —
    // it must NOT also flash a green "Renamed session" success. The failure
    // toast is now the shared mutation cache's (`useRenameSession`'s
    // `meta.errorLabel`), so this needs the REAL error policy
    // (`createQueryClientConfig`) rather than the bare client — a hand-rolled
    // one has no `MutationCache.onError` and would report a silence that was
    // never true.
    vi.mocked(transport.updateSession).mockRejectedValue(new Error('boom'));
    const { result } = setup('s1', '/repo', undefined, new QueryClient(createQueryClientConfig()));
    act(() => {
      result.current.tryRun('/rename Foo');
    });
    // The sonner mock above forwards only the headline. Since DOR-1755 the
    // server's own words are the toast's `description`, not part of the line.
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Couldn't rename that session"));
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('collapses internal whitespace/newlines in the title before renaming', async () => {
    // Finding 5: a Shift+Enter multi-line title must not render garbled in the
    // sidebar — runs of whitespace collapse to single spaces.
    const { result } = setup('s1', '/repo');
    act(() => {
      result.current.tryRun('/rename Line1\n\n  Line2   Line3');
    });
    await waitFor(() =>
      expect(transport.updateSession).toHaveBeenCalledWith(
        's1',
        { title: 'Line1 Line2 Line3' },
        '/repo'
      )
    );
  });

  it('treats "/rename" with no argument as handled-but-not-ran (usage hint, no rename)', () => {
    // No-arg is a no-op per ideation Decision 2 — never reaches the runtime, and
    // `ran: false` lets the send path keep the composer text so the user can fix it.
    const { result } = setup('s1', '/repo');
    let outcome: ReturnType<typeof result.current.tryRun> = { handled: false };
    act(() => {
      outcome = result.current.tryRun('/rename');
    });
    expect(outcome).toEqual({ handled: true, ran: false });
    expect(transport.updateSession).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('Usage: /rename'));
  });

  it('guards against renaming when there is no active session (handled, not ran)', () => {
    const { result } = setup(null, '/repo');
    let outcome: ReturnType<typeof result.current.tryRun> = { handled: false };
    act(() => {
      outcome = result.current.tryRun('/rename Foo');
    });
    expect(outcome).toEqual({ handled: true, ran: false });
    expect(transport.updateSession).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalled();
  });

  it('falls through (handled: false) for unregistered commands and plain text', () => {
    const { result } = setup('s1', '/repo');
    expect(result.current.tryRun('/unknown thing')).toEqual({ handled: false });
    expect(result.current.tryRun('hello world')).toEqual({ handled: false });
    expect(transport.updateSession).not.toHaveBeenCalled();
  });

  it('/clear opens a fresh linked session and sends no message', () => {
    // /clear delegates to the injected navigation with the prior session id (the
    // "linked back" reference) and never POSTs a message (no model turn).
    const { result } = setup('s1', '/repo');
    let outcome: ReturnType<typeof result.current.tryRun> = { handled: false };
    act(() => {
      outcome = result.current.tryRun('/clear');
    });
    expect(outcome).toEqual({ handled: true, ran: true });
    expect(startFreshSession).toHaveBeenCalledWith('s1');
    expect(transport.postMessage).not.toHaveBeenCalled();
  });

  it('routes a cross-agent alias (/new) to a fresh session', () => {
    // Muscle memory: Codex/OpenCode's /new opens a fresh session, same as /clear.
    const { result } = setup('s1', '/repo');
    act(() => {
      result.current.tryRun('/new');
    });
    expect(startFreshSession).toHaveBeenCalledWith('s1');
  });

  it('/context reveals the usage surface and sends no message', () => {
    const { result } = setup('s1', '/repo');
    let outcome: ReturnType<typeof result.current.tryRun> = { handled: false };
    act(() => {
      outcome = result.current.tryRun('/context');
    });
    expect(outcome).toEqual({ handled: true, ran: true });
    expect(useUsageReveal.getState().open).toBe(true);
    expect(startFreshSession).not.toHaveBeenCalled();
    expect(transport.postMessage).not.toHaveBeenCalled();
  });

  it('routes a cross-agent alias (/usage) to the context reveal', () => {
    // Muscle memory: another agent's word for the same intent still works.
    const { result } = setup('s1', '/repo');
    act(() => {
      result.current.tryRun('/usage');
    });
    expect(useUsageReveal.getState().open).toBe(true);
  });

  describe('compact dispatch (DOR-109 VC1)', () => {
    it('dispatches /compress via runCommandIntent when the runtime supports compact', () => {
      // Supported runtime: fire the trigger, clear the composer (ran:true), no POST.
      const { result } = setup('s1', '/repo', { supported: true, runtimeLabel: 'Claude Code' });
      let outcome: ReturnType<typeof result.current.tryRun> = { handled: false };
      act(() => {
        outcome = result.current.tryRun('/compress');
      });
      // `confirmed` rides along because the dispatch is trigger-only (202) and
      // returns before it settles — `ran: true` here only means "it was fired".
      // A caller holding an undo must settle on this, not on `ran`.
      expect(outcome).toEqual({ handled: true, ran: true, confirmed: expect.any(Promise) });
      expect(transport.runCommandIntent).toHaveBeenCalledWith('s1', 'compact', undefined);
      expect(transport.postMessage).not.toHaveBeenCalled();
    });

    it('threads trailing instructions through the dispatch, never dropping them', () => {
      // `/compact <instructions>` carried the remainder to the CLI pre-DOR-109;
      // recognition must forward it, not silently discard it (review Important 1).
      const { result } = setup('s1', '/repo', { supported: true, runtimeLabel: 'Claude Code' });
      act(() => {
        result.current.tryRun('/compact focus on the API changes');
      });
      expect(transport.runCommandIntent).toHaveBeenCalledWith(
        's1',
        'compact',
        'focus on the API changes'
      );
    });

    it('passes no instructions for a bare intent token (undefined, not empty string)', () => {
      const { result } = setup('s1', '/repo', { supported: true, runtimeLabel: 'Claude Code' });
      act(() => {
        result.current.tryRun('/compact');
      });
      expect(transport.runCommandIntent).toHaveBeenCalledWith('s1', 'compact', undefined);
    });

    it('dispatches the canonical /compact and the /summarize alias too', () => {
      const { result } = setup('s1', '/repo', { supported: true, runtimeLabel: 'OpenCode' });
      act(() => {
        result.current.tryRun('/compact');
        result.current.tryRun('/summarize');
      });
      expect(transport.runCommandIntent).toHaveBeenCalledTimes(2);
    });

    it('refuses on an unsupported runtime: toasts and never sends the text', () => {
      // Codex can't compact — honest toast, keep the composer text (ran:false),
      // and NEVER call runCommandIntent or postMessage (no silent send-as-text).
      const { result } = setup('s1', '/repo', { supported: false, runtimeLabel: 'Codex' });
      let outcome: ReturnType<typeof result.current.tryRun> = { handled: false };
      act(() => {
        outcome = result.current.tryRun('/compact');
      });
      expect(outcome).toEqual({ handled: true, ran: false });
      expect(toastError).toHaveBeenCalledWith(expect.stringContaining('Codex'));
      expect(transport.runCommandIntent).not.toHaveBeenCalled();
      expect(transport.postMessage).not.toHaveBeenCalled();
    });

    it('falls through (handled: false) when no compact support is injected', () => {
      // Without the injected gate, compact tokens are not recognized here.
      const { result } = setup('s1', '/repo');
      expect(result.current.tryRun('/compress')).toEqual({ handled: false });
      expect(transport.runCommandIntent).not.toHaveBeenCalled();
    });
  });
});

describe('isNativeCommandContent — what the funnel will swallow (DOR-480)', () => {
  // The predicate a caller needs when asking "would this be intercepted rather
  // than sent?". Gating on `parseNativeCommand` instead let `/compact` through,
  // and a `/compact` that reaches the queue flushes without starting a turn, so
  // the pump never re-arms and everything behind it strands.
  it('recognizes the runtime-fulfilled compact intent and its aliases', () => {
    expect(isNativeCommandContent('/compact')).toBe(true);
    expect(isNativeCommandContent('/compact focus on the API changes')).toBe(true);
    expect(isNativeCommandContent('/compress')).toBe(true);
    expect(isNativeCommandContent('/summarize')).toBe(true);
  });

  it('recognizes client-native commands and their cross-agent aliases', () => {
    for (const content of ['/rename Foo', '/clear', '/new', '/context', '/usage']) {
      expect(isNativeCommandContent(content)).toBe(true);
    }
  });

  it('leaves ordinary prose and unknown slash words alone', () => {
    expect(isNativeCommandContent('explain what /rename does')).toBe(false);
    expect(isNativeCommandContent('run the tests')).toBe(false);
    expect(isNativeCommandContent('/not-a-real-command')).toBe(false);
    expect(isNativeCommandContent('')).toBe(false);
  });

  it('is strictly broader than the client-native parser it replaced', () => {
    // The exact gap that caused the bug, pinned so it cannot silently return.
    expect(parseNativeCommand('/compact')).toBeNull();
    expect(isNativeCommandContent('/compact')).toBe(true);
  });
});

describe('useNativeCommands — the in-flight latch (DOR-479)', () => {
  let transport: ReturnType<typeof createMockTransport>;

  beforeEach(() => {
    vi.clearAllMocks();
    transport = createMockTransport();
  });

  function setup() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
    return renderHook(
      () =>
        useNativeCommands('/repo', 's1', {
          startFreshSession,
          compact: { supported: true, runtimeLabel: 'Claude Code' },
        }),
      { wrapper }
    );
  }

  it('is not latched when nothing has been dispatched', () => {
    expect(setup().result.current.commandPending).toBe(false);
  });

  // The composer keeps the command's text until it confirms, so a refused
  // `/compact` cannot eat its instructions. That window is exactly when a second
  // Enter would turn one intent into two triggers, so it has to be observable.
  it('latches while a dispatched /compact is still in flight', async () => {
    let settle: () => void = () => {};
    vi.mocked(transport.runCommandIntent).mockImplementation(
      () =>
        new Promise<{ sessionId: string }>((resolve) => {
          settle = () => resolve({ sessionId: 's1' });
        })
    );
    const { result } = setup();

    act(() => {
      result.current.tryRun('/compact focus on the API changes');
    });
    await waitFor(() => expect(result.current.commandPending).toBe(true));

    await act(async () => {
      settle();
    });
    await waitFor(() => expect(result.current.commandPending).toBe(false));
  });

  // The reason this is a counter and not a boolean. Nothing else in the suite
  // distinguishes the two: a boolean would pass every other test here, then
  // unlatch on the FIRST settle and leave a still-in-flight dispatch
  // re-triggerable by the next Enter.
  it('stays latched when the first of two overlapping dispatches settles', async () => {
    const settlers: Array<() => void> = [];
    vi.mocked(transport.runCommandIntent).mockImplementation(
      () =>
        new Promise<{ sessionId: string }>((resolve) => {
          settlers.push(() => resolve({ sessionId: 's1' }));
        })
    );
    const { result } = setup();

    act(() => {
      result.current.tryRun('/compact first');
    });
    act(() => {
      result.current.tryRun('/compact second');
    });
    await waitFor(() => expect(result.current.commandPending).toBe(true));
    expect(settlers).toHaveLength(2);

    await act(async () => {
      settlers[0]();
    });
    expect(result.current.commandPending).toBe(true);

    await act(async () => {
      settlers[1]();
    });
    await waitFor(() => expect(result.current.commandPending).toBe(false));
  });

  it('releases the latch when the dispatch is REFUSED, not just when it succeeds', async () => {
    let reject: (err: Error) => void = () => {};
    vi.mocked(transport.runCommandIntent).mockImplementation(
      () =>
        new Promise<{ sessionId: string }>((_resolve, rej) => {
          reject = rej;
        })
    );
    const { result } = setup();

    act(() => {
      result.current.tryRun('/compact');
    });
    await waitFor(() => expect(result.current.commandPending).toBe(true));

    await act(async () => {
      reject(Object.assign(new Error('locked'), { code: 'SESSION_LOCKED' }));
    });
    // A refusal must hand the composer back — otherwise the honest "keep the
    // text" behavior becomes a box you can never send from again.
    await waitFor(() => expect(result.current.commandPending).toBe(false));
  });
});
