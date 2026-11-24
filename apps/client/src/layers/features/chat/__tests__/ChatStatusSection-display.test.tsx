// @vitest-environment jsdom
/**
 * What the status line reads off the session: the snapshot on a cold mount, the
 * context percent the compact action names, and children still running after
 * their turn. The real items render; only overlays are flattened.
 */
import { harness, resetHarness, hideStatusItems } from './chat-status-harness';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { SessionSnapshot } from '@dorkos/shared/session-stream';
import type { ContextUsage } from '@dorkos/shared/types';
import { ChatStatusSection } from '../ui/status/ChatStatusSection';
import { useSessionChatStore, useSessionStreamStore } from '@/layers/entities/session';

const SESSION_ID = 'session-1';

const props = {
  sessionId: SESSION_ID,
  sessionStatus: null,
  isStreaming: false,
  syncConnectionState: 'connected' as const,
};

/** A hydrated snapshot; `status` fields override a quiet idle session. */
function snapshot(
  status: Partial<SessionSnapshot['status']> = {},
  inProgressTurn: SessionSnapshot['inProgressTurn'] = null
): SessionSnapshot {
  return {
    messages: [],
    inProgressTurn,
    status: {
      contextUsage: null,
      cost: null,
      usage: null,
      cacheStats: null,
      model: 'claude-opus-4-6',
      permissionMode: 'default',
      todoCounts: null,
      runningSubagentCount: 0,
      lifecycle: 'idle',
      lastError: null,
      limit: null,
      accountUsage: null,
      ...status,
    },
    pendingInteractions: [],
    queuedMessages: [],
    canvas: [],
    cursor: 3,
  };
}

function applySnapshot(snap: SessionSnapshot): void {
  act(() => {
    useSessionStreamStore.getState().applySnapshot(SESSION_ID, snap);
  });
}

beforeEach(() => {
  resetHarness();
  harness.overlays = 'flat';
  // A healthy cost and a 20%-full window are quiet by design; pin them.
  harness.pins = ['usage', 'context'];
  useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [] });
  useSessionChatStore.setState({ sessions: {} });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ChatStatusSection — snapshot-backed cold mount', () => {
  beforeEach(() => hideStatusItems('SubagentsItem'));

  it('renders cost and context % from the hydrated snapshot when no live event has arrived', () => {
    // `useSessionStatus` reports the COLD state (cost and context null), so these
    // can only come from the snapshot in the stream store.
    applySnapshot(
      snapshot({
        contextUsage: {
          totalTokens: 40_000,
          maxTokens: 200_000,
          outputTokens: 500,
          cacheReadTokens: 1000,
          cacheCreationTokens: 250,
        },
        cost: 0.1,
        usage: { kind: 'pay-as-you-go', costUsd: 0.1 },
        cacheStats: { cacheReadTokens: 1000, cacheCreationTokens: 250 },
      })
    );

    render(<ChatStatusSection {...props} />);

    expect(screen.getByText('$0.10')).toBeInTheDocument();
    expect(screen.getByText('20%')).toBeInTheDocument();
  });

  it('does not render cost/context when the session has not hydrated', () => {
    render(<ChatStatusSection {...props} />);
    expect(screen.queryByText(/^\$/)).not.toBeInTheDocument();
    expect(screen.queryByText('20%')).not.toBeInTheDocument();
  });
});

describe('ChatStatusSection — inline compact action percent (DOR-112)', () => {
  /** An SDK breakdown whose percentage (88.4) rounds differently from the coarse 99. */
  const contextUsage: ContextUsage = {
    totalTokens: 176_800,
    maxTokens: 200_000,
    percentage: 88.4,
    model: 'claude-opus-4-6',
    categories: [],
  };

  beforeEach(() => {
    harness.pins = [];
    // A DELIBERATELY DIVERGENT coarse estimate (99) vs the SDK breakdown's 88.4:
    // both the badge and the inline action must prefer the SDK percentage.
    harness.sessionStatus = { contextPercent: 99 };
    act(() => {
      useSessionChatStore.getState().updateSession(SESSION_ID, { contextUsage });
    });
  });

  it('names the SAME percent in the action as the ContextItem badge beside it', () => {
    render(<ChatStatusSection {...props} />);

    const badgePercent = Number((screen.getByText(/^\d+%$/).textContent ?? '').replace('%', ''));
    const match = /Context (\d+)% full/.exec(
      screen.getByTestId('compaction-chip').getAttribute('aria-label') ?? ''
    );
    expect(match).not.toBeNull();
    const actionPercent = Number(match![1]);

    expect(actionPercent).toBe(badgePercent);
    // Both surfaces silently switching to the coarse estimate together fails here.
    expect(actionPercent).toBe(88);
  });

  it('offers no compact affordance mid-turn, however full the window is', () => {
    // `/compact` mid-turn can only 409, so the affordance hides while streaming.
    render(<ChatStatusSection {...props} isStreaming />);

    expect(screen.getByText('88%')).toBeInTheDocument();
    expect(screen.queryByTestId('compaction-chip')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /compact/i })).not.toBeInTheDocument();
  });
});

// DOR-1100: an agent whose background tasks are still running has stopped
// talking but is not finished. The status line is where that shows.
describe('ChatStatusSection — background tasks outliving their turn', () => {
  const STILL_WORKING = 'Still working. The agent continues when they finish.';

  beforeEach(() => {
    // The "still working" sentence is tooltip content.
    harness.overlays = 'flat-tooltips';
  });

  it('reports the children the server still counts after the turn closed', () => {
    applySnapshot(snapshot({ runningSubagentCount: 2 }));
    render(<ChatStatusSection {...props} />);

    expect(screen.getByLabelText('2 background tasks running')).toBeInTheDocument();
    expect(screen.getByText(STILL_WORKING)).toBeInTheDocument();
  });

  // The failure this replaces: the item was drawn from the turn's own events, so
  // the history reload that follows every `turn_end` emptied it while the
  // children were still working.
  it('keeps reporting them after the turn-end history reload empties the turn', () => {
    act(() => {
      const store = useSessionStreamStore.getState();
      store.applySnapshot(SESSION_ID, snapshot());
      store.applyEvent(SESSION_ID, { type: 'turn_start', seq: 4 });
      store.applyEvent(SESSION_ID, {
        type: 'subagent_update',
        seq: 5,
        taskId: 'bt1',
        status: 'running',
        description: 'Run the test suite',
      });
      store.applyEvent(SESSION_ID, { type: 'turn_end', seq: 6 });
      store.setHistoryMessages(SESSION_ID, []);
    });

    render(<ChatStatusSection {...props} />);

    expect(useSessionStreamStore.getState().sessions[SESSION_ID]?.inProgressTurn).toEqual([]);
    expect(screen.getByLabelText('1 background task running')).toBeInTheDocument();
  });

  it('draws no subagent item at all when nothing is running', () => {
    applySnapshot(snapshot());
    render(<ChatStatusSection {...props} />);

    expect(screen.queryByLabelText(/background task/)).not.toBeInTheDocument();
  });

  // The sentence promises the agent picks up again when the children finish,
  // which is only true of an IDLE session. While streaming the count is ordinary
  // delegation; blocked, error and interrupted are states where it would be a
  // lie, and `isStreaming` collapses those into "not streaming", which is why the
  // gate reads the projected lifecycle instead.
  it.each([
    ['streaming', true],
    ['blocked', false],
    ['error', false],
    ['interrupted', false],
  ] as const)('does not promise a pick-up while the session is %s', (lifecycle, isStreaming) => {
    applySnapshot(snapshot({ runningSubagentCount: 2, lifecycle }));
    render(<ChatStatusSection {...props} isStreaming={isStreaming} />);

    // The count is still honest: those children really are running.
    expect(screen.getByLabelText('2 background tasks running')).toBeInTheDocument();
    expect(screen.queryByText(STILL_WORKING)).not.toBeInTheDocument();
  });
});
