/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

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

vi.mock('motion/react', () => ({
  motion: new Proxy({} as Record<string, typeof PassThrough>, {
    get: () => PassThrough,
  }),
  useReducedMotion: () => true,
  AnimatePresence: PassThrough,
}));

type MockContent =
  | { type: 'markdown'; content: string; title?: string }
  | { type: 'json'; data: unknown; title?: string }
  | { type: 'url'; url: string; title?: string };

interface MockDoc {
  id: string;
  content: MockContent;
  openedAt: number;
  lastActiveAt: number;
  sourceLabel: string;
  editing: boolean;
}

const mockState = {
  openDocuments: [] as MockDoc[],
  activeDocumentId: null as string | null,
  selectedCwd: null as string | null,
  canvasSessionId: null as string | null,
  setCanvasOpen: vi.fn(),
  openCanvasDocument: vi.fn(),
  activateCanvasDocument: vi.fn(),
  closeCanvasDocument: vi.fn(),
  setActiveDocumentContent: vi.fn(),
  setDocumentEditing: vi.fn(),
};

/** Set a single active document from its content, deriving a tab label from the title. */
function setActiveDoc(content: MockContent): void {
  mockState.openDocuments = [
    {
      id: 'd1',
      content,
      openedAt: 1,
      lastActiveAt: 1,
      sourceLabel: content.title ?? content.type,
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
    useIsMobile: () => false,
    useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
    useTransport: () => ({ writeFile: async () => ({ ok: true, hash: 'x' }) }),
  };
});

import { CanvasContent } from '../ui/AgentCanvas';

afterEach(cleanup);

describe('CanvasContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.openDocuments = [];
    mockState.activeDocumentId = null;
  });

  it('renders canvas body without Panel or Sheet wrappers', () => {
    setActiveDoc({ type: 'markdown', content: '# Hello', title: 'Test Doc' });
    const { container } = render(<CanvasContent />);

    // The splash screen or content renders — no Panel/Sheet DOM wrappers
    expect(container.querySelector('[data-testid="panel"]')).toBeNull();
    expect(container.querySelector('[data-testid="sheet"]')).toBeNull();
    expect(container.querySelector('[data-testid="sheet-content"]')).toBeNull();
    expect(container.querySelector('[data-testid="resize-handle"]')).toBeNull();
    expect(screen.getByText('Test Doc')).toBeInTheDocument();
  });
});
