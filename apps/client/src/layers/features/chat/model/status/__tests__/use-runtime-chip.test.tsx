// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ──────────────────────────────────────────────────────────────────────────────
// Mocks (hoisted before the hook import)
//
// The REAL app store is used deliberately: this suite proves two independent
// useRuntimeChip instances share one pending selection through it. Only the
// router-backed session list and the runtime-capability query are stubbed
// (both need providers absent here); useNavigate falls back to a warn-only
// no-op without a RouterProvider, so ?runtime= never actually changes — the
// store is the only channel carrying the selection between consumers.
// ──────────────────────────────────────────────────────────────────────────────

const mockSessionList = vi.fn<() => { sessions: unknown[]; isLoading: boolean }>(() => ({
  sessions: [],
  isLoading: false,
}));
vi.mock('@/layers/entities/session/model/use-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session/model/use-sessions')>()),
  useSessions: () => mockSessionList() as never,
}));

const mockCaps = vi.fn<() => unknown>(() => ({
  capabilities: { 'claude-code': { type: 'claude-code' }, codex: { type: 'codex' } },
  defaultRuntime: 'claude-code',
}));
vi.mock('@/layers/entities/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/runtime')>()),
  useRuntimeCapabilities: () => ({ data: mockCaps() }),
}));

// Without a RouterProvider the real useNavigate returns a function that throws
// when invoked; stub it to a no-op so onChangeRuntime's best-effort URL write is
// exercised without a router. The URL therefore never changes here — proving the
// shared store, not the URL, propagates the selection between consumers.
const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => mockNavigate,
}));

// ──────────────────────────────────────────────────────────────────────────────

import { useRuntimeChip } from '../use-runtime-chip';
import { useAppStore } from '@/layers/shared/model';

/** One useRuntimeChip consumer, exposing its resolved runtime + selection button. */
function ChipConsumer({ testid, sessionId }: { testid: string; sessionId: string }) {
  const chip = useRuntimeChip(sessionId);
  return (
    <div>
      <span data-testid={`${testid}-runtime`}>{chip.runtime ?? 'none'}</span>
      <button
        type="button"
        data-testid={`${testid}-pick-codex`}
        onClick={() => chip.onChangeRuntime('codex')}
      >
        pick codex
      </button>
    </div>
  );
}

/**
 * Two independent useRuntimeChip instances against the same session — mirrors
 * ChatStatusSection's status-bar chip and ChatPanel's command-palette query.
 */
function TwoConsumers({ sessionId = 'session-1' }: { sessionId?: string }) {
  return (
    <>
      <ChipConsumer testid="status-bar" sessionId={sessionId} />
      <ChipConsumer testid="palette" sessionId={sessionId} />
    </>
  );
}

beforeEach(() => {
  // A non-null cwd makes started-ness resolvable pre-launch; clear any pending
  // selection leaked from a prior test (the store is a module singleton).
  useAppStore.setState({ selectedCwd: '/test/dir', pendingRuntime: null });
  window.history.replaceState(null, '', '/');
  mockSessionList.mockReturnValue({ sessions: [], isLoading: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useRuntimeChip — shared pending selection', () => {
  it('a chip selection on one consumer is observed by a second, independent consumer', () => {
    render(<TwoConsumers />);

    // Both start on the server default (no ?runtime=, session not started).
    expect(screen.getByTestId('status-bar-runtime')).toHaveTextContent('claude-code');
    expect(screen.getByTestId('palette-runtime')).toHaveTextContent('claude-code');

    // The status-bar chip changes the runtime (its onChangeRuntime path).
    act(() => {
      fireEvent.click(screen.getByTestId('status-bar-pick-codex'));
    });

    // The palette — a SEPARATE useRuntimeChip instance — observes it immediately.
    // Before the fix the two diverged (per-instance local state); the shared
    // store closes that gap. The URL never changed (no router), so the store is
    // provably the channel carrying the selection.
    expect(screen.getByTestId('palette-runtime')).toHaveTextContent('codex');
    expect(screen.getByTestId('status-bar-runtime')).toHaveTextContent('codex');
    expect(useAppStore.getState().pendingRuntime).toBe('codex');
  });

  it('seeds both consumers from the ?runtime= launch param (deep-link parity preserved)', () => {
    window.history.replaceState(null, '', '/?runtime=codex');
    render(<TwoConsumers />);
    expect(screen.getByTestId('status-bar-runtime')).toHaveTextContent('codex');
    expect(screen.getByTestId('palette-runtime')).toHaveTextContent('codex');
  });

  it('a started session shows its server-bound runtime and is read-only, ignoring any pending pick', () => {
    useAppStore.setState({ pendingRuntime: 'claude-code' });
    mockSessionList.mockReturnValue({
      sessions: [{ id: 'session-1', runtime: 'codex' }],
      isLoading: false,
    });
    render(<TwoConsumers />);
    // Row runtime wins over the pending selection for a started session.
    expect(screen.getByTestId('status-bar-runtime')).toHaveTextContent('codex');
    expect(screen.getByTestId('palette-runtime')).toHaveTextContent('codex');
  });

  it('clears the shared selection when the active session changes', () => {
    const { rerender } = render(<TwoConsumers sessionId="session-1" />);
    act(() => {
      fireEvent.click(screen.getByTestId('status-bar-pick-codex'));
    });
    expect(useAppStore.getState().pendingRuntime).toBe('codex');

    // Switching sessions drops the prior session's pick so the new session
    // resolves from its own ?runtime= (none here → server default).
    act(() => {
      rerender(<TwoConsumers sessionId="session-2" />);
    });
    expect(useAppStore.getState().pendingRuntime).toBeNull();
    expect(screen.getByTestId('status-bar-runtime')).toHaveTextContent('claude-code');
    expect(screen.getByTestId('palette-runtime')).toHaveTextContent('claude-code');
  });
});
