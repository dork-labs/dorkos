/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ---------------------------------------------------------------------------
// Mocks — all declared before any imports of the component under test
// ---------------------------------------------------------------------------

// Strip Panel-specific props that are not valid HTML attributes to avoid
// React DOM warnings in tests. The real library handles them internally.
vi.mock('react-resizable-panels', () => ({
  Panel: ({
    children,
    defaultSize: _defaultSize,
    minSize: _minSize,
    order: _order,
    id,
  }: React.PropsWithChildren<Record<string, unknown>>) => (
    <div data-testid="panel" id={id as string}>
      {children}
    </div>
  ),
  PanelResizeHandle: ({ className }: { className?: string }) => (
    <div data-testid="resize-handle" className={className} />
  ),
  PanelGroup: ({
    children,
    direction: _direction,
    autoSaveId: _autoSaveId,
  }: React.PropsWithChildren<Record<string, unknown>>) => (
    <div data-testid="panel-group">{children}</div>
  ),
}));

vi.mock('@/layers/features/chat', () => ({
  ChatPanel: ({ sessionId }: { sessionId: string | null }) => (
    <div data-testid="chat-panel" data-session-id={sessionId ?? ''}>
      ChatPanel
    </div>
  ),
}));

// AgentCanvas returns null by default (canvas closed); tests that need it open
// can override mockCanvasOpen.
let mockCanvasOpen = false;

vi.mock('@/layers/features/canvas', () => ({
  AgentCanvas: () =>
    mockCanvasOpen ? (
      <>
        <div data-testid="resize-handle" />
        <div data-testid="panel" id="agent-canvas">
          AgentCanvas
        </div>
      </>
    ) : null,
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
  mockCanvasOpen = false;
});

describe('SessionPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a PanelGroup', () => {
    render(<SessionPage />);
    expect(screen.getByTestId('panel-group')).toBeInTheDocument();
  });

  it('renders the chat Panel with id="chat"', () => {
    render(<SessionPage />);
    const panel = screen.getByTestId('panel');
    expect(panel).toHaveAttribute('id', 'chat');
  });

  it('passes the session id from useSessionId to ChatPanel', () => {
    render(<SessionPage />);
    expect(screen.getByTestId('chat-panel')).toHaveAttribute('data-session-id', 'session-abc');
  });

  it('does not render the canvas panel when canvas is closed', () => {
    render(<SessionPage />);
    // Only one panel — the chat panel
    expect(screen.getAllByTestId('panel')).toHaveLength(1);
    expect(screen.queryByTestId('resize-handle')).not.toBeInTheDocument();
  });

  it('renders the canvas panel and resize handle when canvas is open', () => {
    mockCanvasOpen = true;
    render(<SessionPage />);
    // Two panels: chat + canvas
    expect(screen.getAllByTestId('panel')).toHaveLength(2);
    expect(screen.getByTestId('resize-handle')).toBeInTheDocument();
    const panels = screen.getAllByTestId('panel');
    expect(panels.find((p) => p.id === 'chat')).toBeInTheDocument();
    expect(panels.find((p) => p.id === 'agent-canvas')).toBeInTheDocument();
  });
});
