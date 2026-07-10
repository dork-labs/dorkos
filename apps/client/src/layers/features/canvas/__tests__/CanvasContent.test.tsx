/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
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

describe('CanvasContent — browser remount on content/document change (DOR-233 review)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.openDocuments = [];
    mockState.activeDocumentId = null;
  });

  /** The framed page currently rendered, or null. */
  function iframeSrc(): string | null {
    return document.querySelector('iframe')?.getAttribute('src') ?? null;
  }

  it('update_canvas swapping the url in place shows the new page (same document id)', async () => {
    // The browser snapshots content.url into its history on mount — without a
    // content-keyed remount, an in-place update would keep showing the old page.
    setActiveDoc({ type: 'url', url: 'https://one.test/' });
    const { rerender } = render(<CanvasContent />);
    await waitFor(() => expect(iframeSrc()).toBe('https://one.test/'));

    setActiveDoc({ type: 'url', url: 'https://two.test/' });
    rerender(<CanvasContent />);
    await waitFor(() => expect(iframeSrc()).toBe('https://two.test/'));
  });

  it('switching tabs between two web documents shows each document its own page', async () => {
    const docs: MockDoc[] = [
      {
        id: 'd1',
        content: { type: 'url', url: 'https://one.test/' },
        openedAt: 1,
        lastActiveAt: 1,
        sourceLabel: 'One',
        editing: false,
      },
      {
        id: 'd2',
        content: { type: 'url', url: 'https://two.test/' },
        openedAt: 2,
        lastActiveAt: 2,
        sourceLabel: 'Two',
        editing: false,
      },
    ];
    mockState.openDocuments = docs;
    mockState.activeDocumentId = 'd1';

    const { rerender } = render(<CanvasContent />);
    await waitFor(() => expect(iframeSrc()).toBe('https://one.test/'));

    // Same tree position — without a document-keyed remount the browser would
    // keep the first document's history and page.
    mockState.activeDocumentId = 'd2';
    rerender(<CanvasContent />);
    await waitFor(() => expect(iframeSrc()).toBe('https://two.test/'));

    mockState.activeDocumentId = 'd1';
    rerender(<CanvasContent />);
    await waitFor(() => expect(iframeSrc()).toBe('https://one.test/'));
  });
});
