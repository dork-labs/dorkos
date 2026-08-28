/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ---------------------------------------------------------------------------
// Mocks — all declared before any imports of the component under test
// ---------------------------------------------------------------------------

let lastConsume: (() => void) | undefined;

vi.mock('../ui/ChatPanel', () => ({
  ChatPanel: ({
    sessionId,
    launchRuntime,
    launchPrompt,
    launchSend,
    onLaunchConsumed,
    landOnRow,
  }: {
    sessionId: string | null;
    launchRuntime?: string;
    launchPrompt?: string;
    launchSend?: boolean;
    onLaunchConsumed?: () => void;
    landOnRow?: () => string | undefined;
  }) => {
    lastConsume = onLaunchConsumed;
    return (
      <div
        data-testid="chat-panel"
        data-session-id={sessionId ?? ''}
        data-launch-runtime={launchRuntime ?? ''}
        data-launch-prompt={launchPrompt ?? ''}
        data-launch-send={String(launchSend ?? false)}
        // The getter itself is `useMessageLanding`'s to test; what this file
        // answers is whether the page HANDED one over at all, and which row it
        // asks for.
        data-land-on-row={landOnRow?.() ?? ''}
      >
        ChatPanel
      </div>
    );
  },
}));

vi.mock('@/layers/features/canvas', () => ({
  useCanvasPersistence: () => {},
}));

vi.mock('@/layers/features/right-panel', () => ({
  useRightPanelLayoutPersistence: () => {},
}));

const mockUseSessionSearch = vi.fn<
  () => { runtime?: string; prompt?: string; send?: '1'; message?: string }
>(() => ({}));
vi.mock('@/layers/entities/session', () => ({
  useSessionId: () => ['session-abc', vi.fn()],
  useSessionSearch: () => mockUseSessionSearch(),
}));

const mockInPlaceNavigate = vi.fn();
vi.mock('@/layers/shared/model', () => ({
  useInPlaceNavigate: () => mockInPlaceNavigate,
}));

// ---------------------------------------------------------------------------
// Import component after mocks
// ---------------------------------------------------------------------------

import { SessionPage } from '../ui/SessionPage';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
});

describe('SessionPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders ChatPanel', () => {
    render(<SessionPage />);
    expect(screen.getByTestId('chat-panel')).toBeInTheDocument();
  });

  it('passes the session id from useSessionId to ChatPanel', () => {
    render(<SessionPage />);
    expect(screen.getByTestId('chat-panel')).toHaveAttribute('data-session-id', 'session-abc');
  });

  it('does not render a PanelGroup wrapper', () => {
    const { container } = render(<SessionPage />);
    // SessionPage now renders only ChatPanel — no wrapping panel group divs
    expect(container.firstChild).toHaveAttribute('data-testid', 'chat-panel');
  });

  it('forwards the ?runtime= launch param to ChatPanel', () => {
    mockUseSessionSearch.mockReturnValue({ runtime: 'opencode' });
    render(<SessionPage />);
    expect(screen.getByTestId('chat-panel')).toHaveAttribute('data-launch-runtime', 'opencode');
  });

  it('passes no launch runtime when the param is absent', () => {
    mockUseSessionSearch.mockReturnValue({});
    render(<SessionPage />);
    expect(screen.getByTestId('chat-panel')).toHaveAttribute('data-launch-runtime', '');
  });

  it('forwards the ?prompt= seed and treats send=1 as the opt-in', () => {
    mockUseSessionSearch.mockReturnValue({ prompt: 'do the thing', send: '1' });
    render(<SessionPage />);
    const panel = screen.getByTestId('chat-panel');
    expect(panel).toHaveAttribute('data-launch-prompt', 'do the thing');
    expect(panel).toHaveAttribute('data-launch-send', 'true');
  });

  it('does not opt into sending when only the prompt is present', () => {
    mockUseSessionSearch.mockReturnValue({ prompt: 'do the thing' });
    render(<SessionPage />);
    expect(screen.getByTestId('chat-panel')).toHaveAttribute('data-launch-send', 'false');
  });

  it('hands the transcript the row a search hit named', () => {
    // `?message=` is the conversation's half of DOR-687 (DOR-1579). The page
    // owns it because a route param belongs to the route — the transcript is
    // also what the router-less Obsidian embed renders. The row id, not the
    // bare message id: the timeline matches `ConversationRow.id`.
    mockUseSessionSearch.mockReturnValue({ message: 'uuid-9' });
    render(<SessionPage />);
    expect(screen.getByTestId('chat-panel')).toHaveAttribute('data-land-on-row', 'msg-uuid-9');
  });

  it('hands over nothing when no message was named', () => {
    // The paired control: every way into a conversation except a search hit
    // must leave its ordinary landing entirely alone.
    mockUseSessionSearch.mockReturnValue({});
    render(<SessionPage />);
    expect(screen.getByTestId('chat-panel')).toHaveAttribute('data-land-on-row', '');
  });

  it('does not drop ?message= from the URL, because it is an address', () => {
    // Unlike the launch params, which are instructions and must stop describing
    // one the moment they are carried out. This one is where you are: a refresh
    // or a shared link has to land in the same place, and `useMessageLanding` is
    // what stops it re-answering.
    mockUseSessionSearch.mockReturnValue({ prompt: 'do the thing', send: '1', message: 'uuid-9' });
    render(<SessionPage />);

    lastConsume?.();

    const call = mockInPlaceNavigate.mock.calls[0][0] as {
      search: (prev: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(call.search({ session: 's1', message: 'uuid-9', prompt: 'p', send: '1' })).toEqual({
      session: 's1',
      message: 'uuid-9',
      prompt: undefined,
      send: undefined,
      seed: undefined,
    });
  });

  it('drops both launch params in place, replacing the history entry', () => {
    // The URL must stop describing an instruction the moment it is carried out —
    // otherwise a refresh, a shared link, or a Back re-issues it. In place and
    // replaced: the cockpit is not going anywhere, and the address that held a
    // live `send=1` must not remain somewhere Back can reach.
    mockUseSessionSearch.mockReturnValue({ prompt: 'do the thing', send: '1' });
    render(<SessionPage />);

    lastConsume?.();

    expect(mockInPlaceNavigate).toHaveBeenCalledTimes(1);
    const call = mockInPlaceNavigate.mock.calls[0][0] as {
      search: (prev: Record<string, unknown>) => Record<string, unknown>;
      replace?: boolean;
    };
    expect(call.replace).toBe(true);
    expect(call.search({ session: 's1', dir: '/p', prompt: 'do the thing', send: '1' })).toEqual({
      session: 's1',
      dir: '/p',
      prompt: undefined,
      send: undefined,
    });
  });
});
