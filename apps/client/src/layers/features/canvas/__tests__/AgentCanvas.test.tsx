/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

// Mock react-resizable-panels before importing the component under test
vi.mock('react-resizable-panels', () => ({
  // Strip Panel-specific props that are not valid HTML attributes to avoid
  // React DOM warnings in tests. The real library handles them internally.
  Panel: ({
    children,
    onCollapse: _onCollapse,
    defaultSize: _defaultSize,
    minSize: _minSize,
    collapsible: _collapsible,
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
  PanelGroup: ({ children }: React.PropsWithChildren) => (
    <div data-testid="panel-group">{children}</div>
  ),
}));

// Mock streamdown to avoid CSS import issues in jsdom
vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => (
    <div data-testid="streamdown">{children}</div>
  ),
}));

vi.mock('streamdown/styles.css', () => ({}));

const mockSetCanvasOpen = vi.fn();

const mockState = {
  canvasOpen: false as boolean,
  canvasContent: null as
    | null
    | { type: 'markdown'; content: string; title?: string }
    | { type: 'json'; data: unknown; title?: string }
    | { type: 'url'; url: string; title?: string },
  setCanvasOpen: mockSetCanvasOpen,
};

vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector: (s: typeof mockState) => unknown) => selector(mockState),
}));

import { AgentCanvas } from '../ui/AgentCanvas';

afterEach(cleanup);

describe('AgentCanvas', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.canvasOpen = false;
    mockState.canvasContent = null;
  });

  it('returns null when canvas is closed', () => {
    const { container } = render(<AgentCanvas />);
    expect(container.innerHTML).toBe('');
  });

  it('returns null when canvas is open but has no content', () => {
    mockState.canvasOpen = true;
    mockState.canvasContent = null;
    const { container } = render(<AgentCanvas />);
    expect(container.innerHTML).toBe('');
  });

  it('renders panel and resize handle when open with markdown content', () => {
    mockState.canvasOpen = true;
    mockState.canvasContent = { type: 'markdown', content: '# Hello', title: 'Test Doc' };
    render(<AgentCanvas />);
    expect(screen.getByTestId('panel')).toBeInTheDocument();
    expect(screen.getByTestId('resize-handle')).toBeInTheDocument();
  });

  it('renders the content title from canvas content', () => {
    mockState.canvasOpen = true;
    mockState.canvasContent = { type: 'markdown', content: '# Hello', title: 'Test Doc' };
    render(<AgentCanvas />);
    expect(screen.getByText('Test Doc')).toBeInTheDocument();
  });

  it('renders JSON content type label when no title', () => {
    mockState.canvasOpen = true;
    mockState.canvasContent = { type: 'json', data: {} };
    render(<AgentCanvas />);
    expect(screen.getByText('JSON Data')).toBeInTheDocument();
  });

  it('close button calls setCanvasOpen(false)', async () => {
    mockState.canvasOpen = true;
    mockState.canvasContent = { type: 'json', data: {}, title: 'My JSON' };
    render(<AgentCanvas />);

    const closeButton = screen.getByLabelText('Close canvas');
    await userEvent.click(closeButton);
    expect(mockSetCanvasOpen).toHaveBeenCalledWith(false);
  });

  it('renders URL content type label when no title', () => {
    mockState.canvasOpen = true;
    mockState.canvasContent = { type: 'url', url: 'https://example.com' };
    render(<AgentCanvas />);
    expect(screen.getByText('Web Page')).toBeInTheDocument();
  });
});
