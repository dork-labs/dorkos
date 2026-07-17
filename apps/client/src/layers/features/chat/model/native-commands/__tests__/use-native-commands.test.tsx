/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { useNativeCommands } from '../use-native-commands';
import { useUsageReveal } from '../../use-usage-reveal';

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
    compact?: { supported: boolean; runtimeLabel: string }
  ) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
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
    expect(outcome).toEqual({ handled: true, ran: true });
    await waitFor(() =>
      expect(transport.updateSession).toHaveBeenCalledWith('s1', { title: 'Foo' }, '/repo')
    );
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Renamed session to "Foo"'));
  });

  it('only shows the success toast after the rename succeeds, never on a failure', async () => {
    // Finding 2/7: the success toast moved into the mutation's onSuccess. A
    // rejected updateSession rolls the title back and surfaces an error toast —
    // it must NOT also flash a green "Renamed session" success.
    vi.mocked(transport.updateSession).mockRejectedValue(new Error('boom'));
    const { result } = setup('s1', '/repo');
    act(() => {
      result.current.tryRun('/rename Foo');
    });
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Failed to rename session'));
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
      expect(outcome).toEqual({ handled: true, ran: true });
      expect(transport.runCommandIntent).toHaveBeenCalledWith('s1', 'compact');
      expect(transport.postMessage).not.toHaveBeenCalled();
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
