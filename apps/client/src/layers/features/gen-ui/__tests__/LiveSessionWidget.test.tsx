/**
 * @vitest-environment jsdom
 *
 * LiveSessionWidget component tests. Drives the real session stores (reset each
 * test) with a mock Transport, so PIP interactivity is verified through the same
 * WidgetFence → WidgetActionProvider pipeline the inline transcript uses.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import type { HistoryMessage } from '@dorkos/shared/types';
import { streamManager } from '@/layers/shared/lib';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { useSessionListStore, useSessionStreamStore } from '@/layers/entities/session';
import { createMockTransport } from '@dorkos/test-utils';
import { LiveSessionWidget } from '../ui/LiveSessionWidget';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

const SID = 's1';

/** Wrap a widget document JSON body in a closed `dorkos-ui` fence. */
function boardFence(documentJson: string): string {
  return `\`\`\`dorkos-ui\n${documentJson}\n\`\`\``;
}

/** A board with a single filled cell showing `glyph` — a stable, labelable render. */
function filledBoard(glyph: string): string {
  return JSON.stringify({
    version: 1,
    title: 'Tic-Tac-Toe',
    root: { type: 'board', rows: [[{ glyph }]] },
  });
}

/** A board with a single playable `agent`-action cell. */
function playableBoard(actionId: string): string {
  return JSON.stringify({
    version: 1,
    title: 'Tic-Tac-Toe',
    root: {
      type: 'board',
      rows: [[{ action: { kind: 'agent', id: actionId, payload: { glyph: 'X' } } }]],
    },
  });
}

/** A button widget that fires a local `ui` command (open the sidebar). */
function uiButton(): string {
  return JSON.stringify({
    version: 1,
    title: 'Controls',
    root: {
      type: 'button',
      label: 'Open sidebar',
      action: { kind: 'ui', command: { action: 'open_sidebar' } },
    },
  });
}

/** Build a `HistoryMessage`, defaulting to an assistant turn. */
function message(
  id: string,
  content: string,
  role: HistoryMessage['role'] = 'assistant'
): HistoryMessage {
  return { id, role, content };
}

/** Seed a session's history in the real stream store. */
function seedHistory(messages: HistoryMessage[]): void {
  act(() => {
    useSessionStreamStore.getState().setHistoryMessages(SID, messages);
  });
}

const mockTransport = createMockTransport();
function Wrapper({ children }: { children: ReactNode }) {
  return <TransportProvider transport={mockTransport}>{children}</TransportProvider>;
}

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

beforeEach(() => {
  useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [], pinnedSessionId: null });
  useSessionListStore.setState({ sessions: {}, statusCwds: {} });
  // No-op the real pin plumbing so tests never open live SSE connections; the
  // lifecycle test asserts against these same spies.
  vi.spyOn(streamManager, 'pinSession').mockImplementation(() => {});
  vi.spyOn(streamManager, 'unpinSession').mockImplementation(() => {});
  mockTransport.sendUiAction = vi.fn().mockResolvedValue({ sessionId: SID });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('LiveSessionWidget', () => {
  it('renders the latest board from the session projection', () => {
    seedHistory([message('m1', `here you go\n${boardFence(filledBoard('A'))}`)]);
    render(<LiveSessionWidget sessionId={SID} />, { wrapper: Wrapper });
    expect(screen.getByLabelText('Row 1, column 1: A')).toBeInTheDocument();
  });

  it('follows the live game: a newer widget message swaps the rendered document', () => {
    seedHistory([message('m1', boardFence(filledBoard('A')))]);
    render(<LiveSessionWidget sessionId={SID} />, { wrapper: Wrapper });
    expect(screen.getByLabelText('Row 1, column 1: A')).toBeInTheDocument();

    // The agent re-emits a fresh board as the newest message.
    seedHistory([
      message('m1', boardFence(filledBoard('A'))),
      message('m2', boardFence(filledBoard('B'))),
    ]);

    expect(screen.getByLabelText('Row 1, column 1: B')).toBeInTheDocument();
    expect(screen.queryByLabelText('Row 1, column 1: A')).not.toBeInTheDocument();
  });

  it('a newer TEXT-only message does NOT supersede the board (fence-based supersede, DOR-302)', () => {
    // The live repro: the agent emits the board, then replies in a later turn
    // ("opened it!"). Only a newer FENCE-BEARING message may stale a board —
    // trailing plain text must leave it playable, or every PIP board whose
    // fence has any follow-up exchange arrives dead.
    seedHistory([message('m1', boardFence(playableBoard('m-0-0')))]);
    render(<LiveSessionWidget sessionId={SID} />, { wrapper: Wrapper });
    // Live: the empty agent cell invites a move.
    expect(screen.getByLabelText('Row 1, column 1: empty — play here')).toBeInTheDocument();

    // A plain-text follow-up becomes the newest message — the board stays live.
    seedHistory([
      message('m1', boardFence(playableBoard('m-0-0'))),
      message('m2', 'nice game, well played'),
    ]);

    expect(screen.getByLabelText('Row 1, column 1: empty — play here')).not.toHaveAttribute(
      'aria-disabled'
    );
  });

  it('un-latches when the agent re-emits the board in a NEW message (fresh fence instance, DOR-302)', async () => {
    // The PIP-latches-forever repro: the fence rendered UNKEYED, so one
    // WidgetActionProvider instance survived fence re-emits and the agent's
    // next board arrived pre-latched. Keying by sourceMessageKey mounts a
    // fresh instance per fence-bearing message, mirroring inline where each
    // message renders its own fence instance.
    const user = userEvent.setup();
    seedHistory([message('m1', boardFence(playableBoard('move')))]);
    render(<LiveSessionWidget sessionId={SID} />, { wrapper: Wrapper });

    await user.click(screen.getByLabelText('Row 1, column 1: empty — play here'));
    await waitFor(() => expect(mockTransport.sendUiAction).toHaveBeenCalledTimes(1));
    // Latched: the tapped cell shows the optimistic mark.
    expect(screen.getByLabelText('Row 1, column 1: X')).toBeInTheDocument();

    // The agent replies with a fresh board in a NEW message — playable again.
    seedHistory([
      message('m1', boardFence(playableBoard('move'))),
      message('m2', boardFence(playableBoard('move'))),
    ]);

    expect(screen.getByLabelText('Row 1, column 1: empty — play here')).toBeInTheDocument();
  });

  it('keeps the latch across a content update of the SAME message (same fence instance)', async () => {
    const user = userEvent.setup();
    seedHistory([message('m1', boardFence(playableBoard('move')))]);
    render(<LiveSessionWidget sessionId={SID} />, { wrapper: Wrapper });

    await user.click(screen.getByLabelText('Row 1, column 1: empty — play here'));
    await waitFor(() => expect(mockTransport.sendUiAction).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText('Row 1, column 1: X')).toBeInTheDocument();

    // The same message's content updates in place (the streamdown re-parse
    // class): same sourceMessageKey → same instance → latch and mark persist.
    seedHistory([message('m1', `${boardFence(playableBoard('move'))}\ngood luck!`)]);

    expect(screen.getByLabelText('Row 1, column 1: X')).toBeInTheDocument();
    expect(screen.queryByLabelText('Row 1, column 1: empty — play here')).not.toBeInTheDocument();
  });

  it('runs a ui-kind action locally, off-route, without the transport', async () => {
    const user = userEvent.setup();
    act(() => useAppStore.getState().setSidebarOpen(false));
    seedHistory([message('m1', boardFence(uiButton()))]);
    render(<LiveSessionWidget sessionId={SID} />, { wrapper: Wrapper });

    await user.click(screen.getByRole('button', { name: 'Open sidebar' }));

    expect(useAppStore.getState().sidebarOpen).toBe(true);
    expect(mockTransport.sendUiAction).not.toHaveBeenCalled();
  });

  it('dispatches an agent action via the transport with the right sessionId and posts the optimistic message', async () => {
    const user = userEvent.setup();
    seedHistory([message('m1', boardFence(playableBoard('m-0-0')))]);
    render(<LiveSessionWidget sessionId={SID} />, { wrapper: Wrapper });

    await user.click(screen.getByLabelText('Row 1, column 1: empty — play here'));

    await waitFor(() =>
      expect(mockTransport.sendUiAction).toHaveBeenCalledWith(SID, {
        actionId: 'm-0-0',
        payload: { glyph: 'X' },
        widgetTitle: 'Tic-Tac-Toe',
      })
    );
    const optimistic = useSessionStreamStore.getState().getSession(SID).optimisticUserMessage;
    expect(optimistic).not.toBeNull();
    expect(optimistic?.content).toContain('ui_action');
  });

  it('pins on mount and unpins on unmount, in step with the store pin', () => {
    seedHistory([message('m1', boardFence(filledBoard('A')))]);
    const { unmount } = render(<LiveSessionWidget sessionId={SID} />, { wrapper: Wrapper });

    expect(streamManager.pinSession).toHaveBeenCalledTimes(1);
    expect(streamManager.pinSession).toHaveBeenCalledWith(SID, null);
    expect(useSessionStreamStore.getState().pinnedSessionId).toBe(SID);

    unmount();

    expect(streamManager.unpinSession).toHaveBeenCalledTimes(1);
    expect(useSessionStreamStore.getState().pinnedSessionId).toBeNull();
  });

  it('resolves cwd from session metadata first, then statusCwds', () => {
    useSessionListStore.setState({
      sessions: { [SID]: { id: SID, cwd: '/repo/meta' } as never },
      statusCwds: { [SID]: '/repo/status' },
    });
    const { unmount } = render(<LiveSessionWidget sessionId={SID} />, { wrapper: Wrapper });
    expect(streamManager.pinSession).toHaveBeenLastCalledWith(SID, '/repo/meta');
    unmount();

    // Metadata absent → fall back to the status-derived cwd.
    vi.mocked(streamManager.pinSession).mockClear();
    useSessionListStore.setState({ sessions: {}, statusCwds: { [SID]: '/repo/status' } });
    render(<LiveSessionWidget sessionId={SID} />, { wrapper: Wrapper });
    expect(streamManager.pinSession).toHaveBeenLastCalledWith(SID, '/repo/status');
  });

  it('renders a quiet empty state for a session with no widget fence', () => {
    render(<LiveSessionWidget sessionId="unknown-session" />, { wrapper: Wrapper });
    expect(screen.getByText('No live widget in this session')).toBeInTheDocument();
  });
});
