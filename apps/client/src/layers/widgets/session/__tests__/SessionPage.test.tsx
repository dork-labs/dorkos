/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ---------------------------------------------------------------------------
// Mocks — all declared before any imports of the component under test
// ---------------------------------------------------------------------------

vi.mock('@/layers/features/chat', () => ({
  ChatPanel: ({
    sessionId,
    launchRuntime,
  }: {
    sessionId: string | null;
    launchRuntime?: string;
  }) => (
    <div
      data-testid="chat-panel"
      data-session-id={sessionId ?? ''}
      data-launch-runtime={launchRuntime ?? ''}
    >
      ChatPanel
    </div>
  ),
}));

vi.mock('@/layers/features/canvas', () => ({
  useCanvasPersistence: () => {},
}));

const mockUseSessionSearch = vi.fn<() => { runtime?: string }>(() => ({}));
vi.mock('@/layers/entities/session', () => ({
  useSessionId: () => ['session-abc', vi.fn()],
  useSessionSearch: () => mockUseSessionSearch(),
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
});
