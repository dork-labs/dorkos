/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

// Mock the shared right-panel header to avoid router dependency in canvas tests
vi.mock('@/layers/features/right-panel', () => ({
  RightPanelHeader: () => <div data-testid="right-panel-header">PanelHeader</div>,
}));

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
  PanelResizeHandle: ({ className, children }: React.PropsWithChildren<{ className?: string }>) => (
    <div data-testid="resize-handle" className={className}>
      {children}
    </div>
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

// Mock motion/react — render children without animation
function PassThrough({ children, ...rest }: Record<string, unknown>) {
  return (
    <div {...(rest as React.HTMLAttributes<HTMLDivElement>)}>{children as React.ReactNode}</div>
  );
}

// Mock Sheet components for mobile canvas
vi.mock('@/layers/shared/ui', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const Passthrough = ({ children }: React.PropsWithChildren) => <>{children}</>;
  return {
    ...actual,
    Sheet: ({ children, open }: React.PropsWithChildren<{ open?: boolean }>) =>
      open ? <div data-testid="sheet">{children}</div> : null,
    SheetContent: ({ children, className }: React.PropsWithChildren<{ className?: string }>) => (
      <div data-testid="sheet-content" className={className}>
        {children}
      </div>
    ),
    SheetHeader: Passthrough,
    SheetTitle: Passthrough,
    SheetDescription: Passthrough,
  };
});

vi.mock('motion/react', () => ({
  motion: new Proxy({} as Record<string, typeof PassThrough>, {
    get: () => PassThrough,
  }),
  useReducedMotion: () => true,
  AnimatePresence: PassThrough,
}));

const mockSetCanvasOpen = vi.fn();
const mockSetCanvasContent = vi.fn();
let mockIsMobile = false;

const mockState = {
  canvasOpen: false as boolean,
  canvasContent: null as
    | null
    | { type: 'markdown'; content: string; title?: string }
    | { type: 'json'; data: unknown; title?: string }
    | { type: 'url'; url: string; title?: string },
  setCanvasOpen: mockSetCanvasOpen,
  setCanvasContent: mockSetCanvasContent,
};

vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector: (s: typeof mockState) => unknown) => selector(mockState),
  useIsMobile: () => mockIsMobile,
}));

import { AgentCanvas } from '../ui/AgentCanvas';

afterEach(cleanup);

describe('AgentCanvas', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.canvasOpen = false;
    mockState.canvasContent = null;
    mockIsMobile = false;
  });

  it('returns null when canvas is closed', () => {
    const { container } = render(<AgentCanvas />);
    expect(container.innerHTML).toBe('');
  });

  it('renders splash screen when canvas is open with no content', () => {
    mockState.canvasOpen = true;
    mockState.canvasContent = null;
    render(<AgentCanvas />);
    expect(screen.getByText('A blank canvas')).toBeInTheDocument();
    expect(screen.getByText('Markdown')).toBeInTheDocument();
    expect(screen.getByText('JSON')).toBeInTheDocument();
    expect(screen.getByText('Web Page')).toBeInTheDocument();
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

  it('renders the shared right-panel header', () => {
    mockState.canvasOpen = true;
    mockState.canvasContent = { type: 'json', data: {}, title: 'My JSON' };
    render(<AgentCanvas />);

    expect(screen.getByTestId('right-panel-header')).toBeInTheDocument();
  });

  it('renders URL content type label when no title', () => {
    mockState.canvasOpen = true;
    mockState.canvasContent = { type: 'url', url: 'https://example.com' };
    render(<AgentCanvas />);
    expect(screen.getByText('Web Page')).toBeInTheDocument();
  });

  it('renders as Sheet on mobile instead of Panel', () => {
    mockIsMobile = true;
    mockState.canvasOpen = true;
    mockState.canvasContent = { type: 'markdown', content: '# Hello', title: 'Mobile Doc' };
    render(<AgentCanvas />);
    expect(screen.getByTestId('sheet')).toBeInTheDocument();
    expect(screen.queryByTestId('panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('resize-handle')).not.toBeInTheDocument();
    expect(screen.getByText('Mobile Doc')).toBeInTheDocument();
  });
});
