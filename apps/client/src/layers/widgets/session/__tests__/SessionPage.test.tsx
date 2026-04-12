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
  ChatPanel: ({ sessionId }: { sessionId: string | null }) => (
    <div data-testid="chat-panel" data-session-id={sessionId ?? ''}>
      ChatPanel
    </div>
  ),
}));

vi.mock('@/layers/features/canvas', () => ({
  useCanvasPersistence: () => {},
}));

vi.mock('@/layers/entities/session', () => ({
  useSessionId: () => ['session-abc', vi.fn()],
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
});
