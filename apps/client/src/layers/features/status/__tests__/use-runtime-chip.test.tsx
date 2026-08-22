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

import { useResolvedSessionRuntime, useRuntimeChip } from '../model/use-runtime-chip';
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
 * A READ-ONLY consumer: `useResolvedSessionRuntime` runs no effects, so nothing
 * here can clear the store. That makes it the only honest place to assert what
 * the resolution itself does with a pick belonging to another session.
 */
function ReadoutConsumer({ sessionId }: { sessionId: string }) {
  const resolved = useResolvedSessionRuntime(sessionId);
  return <span data-testid="readout-runtime">{resolved.runtime ?? 'none'}</span>;
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
  useAppStore.setState({ selectedCwd: '/test/dir', pendingRuntime: null, pendingAccount: null });
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
    expect(useAppStore.getState().pendingRuntime).toEqual({
      type: 'codex',
      sessionId: 'session-1',
    });
  });

  it('seeds both consumers from the ?runtime= launch param (deep-link parity preserved)', () => {
    window.history.replaceState(null, '', '/?runtime=codex');
    render(<TwoConsumers />);
    expect(screen.getByTestId('status-bar-runtime')).toHaveTextContent('codex');
    expect(screen.getByTestId('palette-runtime')).toHaveTextContent('codex');
  });

  it('a started session shows its server-bound runtime and is read-only, ignoring any pending pick', () => {
    useAppStore.setState({ pendingRuntime: { type: 'claude-code', sessionId: 'session-1' } });
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
    expect(useAppStore.getState().pendingRuntime).toEqual({
      type: 'codex',
      sessionId: 'session-1',
    });

    // Switching sessions drops the prior session's pick so the new session
    // resolves from its own ?runtime= (none here → server default).
    act(() => {
      rerender(<TwoConsumers sessionId="session-2" />);
    });
    expect(useAppStore.getState().pendingRuntime).toBeNull();
    expect(screen.getByTestId('status-bar-runtime')).toHaveTextContent('claude-code');
    expect(screen.getByTestId('palette-runtime')).toHaveTextContent('claude-code');
  });

  it('does NOT clear a held pick when a second consumer mounts on the same session', () => {
    // The hook's contract says one owner, but two surfaces call it today
    // (ChatPanel and ChatStatusSection). A clear-on-MOUNT deletes whatever the
    // other one is holding the moment either remounts — a person's billing pick
    // discarded by a re-render they never asked for.
    render(<ChipConsumer testid="status-bar" sessionId="session-1" />);
    act(() => {
      useAppStore.setState({
        pendingAccount: { id: 'acme-corp', sessionId: 'session-1' },
        pendingRuntime: { type: 'codex', sessionId: 'session-1' },
      });
    });

    // A second surface arrives on the SAME session — a conditional mount, a tab
    // opening, a remount after a layout change.
    render(<ChipConsumer testid="palette" sessionId="session-1" />);

    expect(useAppStore.getState().pendingAccount).toEqual({
      id: 'acme-corp',
      sessionId: 'session-1',
    });
    expect(useAppStore.getState().pendingRuntime).toEqual({
      type: 'codex',
      sessionId: 'session-1',
    });
  });

  it('never lets a pick made on one session reach another, even with nothing mounted between', () => {
    // The leak a lifetime-based guard cannot close: the store is a module global
    // and SessionPage is not. Pick on a draft, walk to /tasks (everything
    // unmounts), start a different chat — a fresh mount has no memory of the
    // transition it never observed, so only the pick's OWN session id can refuse
    // it.
    //
    // Asserted through the PURE READ, deliberately. `useRuntimeChip` also sweeps
    // a foreign pick out of the store on mount, and that sweep would make this
    // pass even with the read guard removed — a test that cannot fail. The read
    // is the property under test, so the read is what gets tested.
    useAppStore.setState({ pendingRuntime: { type: 'codex', sessionId: 'session-a' } });
    render(<ReadoutConsumer sessionId="session-b" />);

    expect(screen.getByTestId('readout-runtime')).toHaveTextContent('claude-code');
  });

  it('sweeps a pick belonging to another session out of the store', () => {
    // The housekeeping half, which is litter collection rather than the safety
    // property — stated separately so neither can stand in for the other.
    useAppStore.setState({
      pendingRuntime: { type: 'codex', sessionId: 'session-a' },
      pendingAccount: { id: 'acme-corp', sessionId: 'session-a' },
    });
    render(<ChipConsumer testid="status-bar" sessionId="session-b" />);

    expect(useAppStore.getState().pendingRuntime).toBeNull();
    expect(useAppStore.getState().pendingAccount).toBeNull();
  });

  it('clears the pre-launch billing pick when the active session changes', () => {
    // "This session only" is a promise about MONEY: a pick that survived into
    // the next session would bill work the person never chose it for. The first
    // send also changes the session id (the canonical rekey), so this is the
    // same effect that spends the hint.
    const { rerender } = render(<TwoConsumers sessionId="session-1" />);
    act(() => {
      useAppStore.setState({ pendingAccount: { id: 'acme-corp', sessionId: 'session-1' } });
    });
    expect(useAppStore.getState().pendingAccount).toEqual({
      id: 'acme-corp',
      sessionId: 'session-1',
    });

    act(() => {
      rerender(<TwoConsumers sessionId="session-2" />);
    });
    expect(useAppStore.getState().pendingAccount).toBeNull();
  });
});
