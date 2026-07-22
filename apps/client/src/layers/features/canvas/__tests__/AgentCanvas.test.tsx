/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
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

// Mock the heavy Blintz wrapper (markdown canvas) so jsdom never loads the real editor.
vi.mock('../ui/BlintzCanvas', () => ({
  BlintzCanvas: ({ value }: { value: string }) => <div data-testid="blintz-canvas">{value}</div>,
}));

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

let mockIsMobile = false;

type MockContent =
  | { type: 'markdown'; content: string; title?: string }
  | { type: 'json'; data: unknown; title?: string }
  | { type: 'url'; url: string; title?: string }
  | { type: 'audio'; src: string; title?: string }
  | { type: 'video'; src: string; title?: string };

interface MockDoc {
  id: string;
  content: MockContent;
  openedAt: number;
  lastActiveAt: number;
  sourceLabel: string;
  editing: boolean;
}

const mockState = {
  canvasOpen: false as boolean,
  openDocuments: [] as MockDoc[],
  activeDocumentId: null as string | null,
  selectedCwd: null as string | null,
  canvasSessionId: null as string | null,
  browserHistories: {} as Record<string, { contentUrl: string; stack: string[]; cursor: number }>,
  setCanvasOpen: vi.fn(),
  openCanvasDocument: vi.fn(),
  activateCanvasDocument: vi.fn(),
  closeCanvasDocument: vi.fn(),
  setActiveDocumentContent: vi.fn(),
  setDocumentEditing: vi.fn(),
  writeBrowserHistory: vi.fn(),
};

/** Tab-label fallbacks mirroring the store's derivation for label-based assertions. */
const FALLBACK_LABELS: Record<string, string> = {
  markdown: 'Document',
  json: 'JSON Data',
  url: 'Web Page',
  audio: 'Audio',
  video: 'Video',
};

/** Open a single active document, deriving its tab label like the real store. */
function setActiveDoc(content: MockContent): void {
  mockState.openDocuments = [
    {
      id: 'd1',
      content,
      openedAt: 1,
      lastActiveAt: 1,
      sourceLabel: content.title ?? FALLBACK_LABELS[content.type],
      editing: false,
    },
  ];
  mockState.activeDocumentId = 'd1';
}

vi.mock('@/layers/shared/model', () => {
  const useAppStore = (selector: (s: typeof mockState) => unknown) => selector(mockState);
  (useAppStore as unknown as { getState: () => typeof mockState }).getState = () => mockState;
  return {
    useAppStore,
    useIsMobile: () => mockIsMobile,
    useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
    useTransport: () => ({ writeFile: async () => ({ ok: true, hash: 'x' }) }),
  };
});

import { AgentCanvas } from '../ui/AgentCanvas';

afterEach(cleanup);

describe('AgentCanvas', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.canvasOpen = false;
    mockState.openDocuments = [];
    mockState.activeDocumentId = null;
    mockIsMobile = false;
  });

  it('returns null when canvas is closed', () => {
    const { container } = render(<AgentCanvas />);
    expect(container.innerHTML).toBe('');
  });

  it('renders splash screen when canvas is open with no documents', () => {
    mockState.canvasOpen = true;
    render(<AgentCanvas />);
    expect(screen.getByText('A blank canvas')).toBeInTheDocument();
    expect(screen.getByText('Markdown')).toBeInTheDocument();
    expect(screen.getByText('JSON')).toBeInTheDocument();
    expect(screen.getByText('Web Page')).toBeInTheDocument();
  });

  it('renders panel and resize handle when open with a markdown document', () => {
    mockState.canvasOpen = true;
    setActiveDoc({ type: 'markdown', content: '# Hello', title: 'Test Doc' });
    render(<AgentCanvas />);
    expect(screen.getByTestId('panel')).toBeInTheDocument();
    expect(screen.getByTestId('resize-handle')).toBeInTheDocument();
  });

  it("renders the document's tab label from its title", () => {
    mockState.canvasOpen = true;
    setActiveDoc({ type: 'markdown', content: '# Hello', title: 'Test Doc' });
    render(<AgentCanvas />);
    expect(screen.getByText('Test Doc')).toBeInTheDocument();
  });

  it('renders the JSON fallback tab label when no title', () => {
    mockState.canvasOpen = true;
    setActiveDoc({ type: 'json', data: {} });
    render(<AgentCanvas />);
    expect(screen.getByText('JSON Data')).toBeInTheDocument();
  });

  it('renders the URL fallback tab label when no title', () => {
    mockState.canvasOpen = true;
    setActiveDoc({ type: 'url', url: 'https://example.com' });
    render(<AgentCanvas />);
    expect(screen.getByText('Web Page')).toBeInTheDocument();
  });

  it('renders as Sheet on mobile instead of Panel', () => {
    mockIsMobile = true;
    mockState.canvasOpen = true;
    setActiveDoc({ type: 'markdown', content: '# Hello', title: 'Mobile Doc' });
    render(<AgentCanvas />);
    expect(screen.getByTestId('sheet')).toBeInTheDocument();
    expect(screen.queryByTestId('panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('resize-handle')).not.toBeInTheDocument();
    expect(screen.getByText('Mobile Doc')).toBeInTheDocument();
  });

  it('dispatches an audio document to the native audio viewer', () => {
    mockState.canvasOpen = true;
    setActiveDoc({ type: 'audio', src: 'https://x/theme.mp3', title: 'Theme' });
    render(<AgentCanvas />);
    const audio = document.querySelector('audio');
    expect(audio).toHaveAttribute('src', 'https://x/theme.mp3');
    expect(audio).toHaveAttribute('controls');
  });

  it('dispatches a video document to the native video viewer', () => {
    mockState.canvasOpen = true;
    setActiveDoc({ type: 'video', src: 'https://x/demo.mp4', title: 'Demo' });
    render(<AgentCanvas />);
    const video = document.querySelector('video');
    expect(video).toHaveAttribute('src', 'https://x/demo.mp4');
    expect(video).toHaveAttribute('controls');
  });
});
