/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

// A weaponized viewer for one content type: while `throws` is set it fails on
// every render, so the canvas boundary (not React's own error recovery) shows
// the fallback. This stands in for any viewer that throws — a stale lazy chunk,
// a WebGL failure, a bad file.
const jsonControl = { throws: true };
vi.mock('../ui/CanvasJsonContent', () => ({
  CanvasJsonContent: () => {
    if (jsonControl.throws) throw new Error('json viewer boom');
    return <div data-testid="json-ok">json ok</div>;
  },
}));

// Mock streamdown + the heavy Blintz wrapper so jsdom never loads the real
// markdown editor (mirrors CanvasContent.test.tsx).
vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => (
    <div data-testid="streamdown">{children}</div>
  ),
}));
vi.mock('streamdown/styles.css', () => ({}));
vi.mock('../ui/BlintzCanvas', () => ({
  BlintzCanvas: ({ value }: { value: string }) => <div data-testid="blintz-canvas">{value}</div>,
}));

function PassThrough({ children, ...rest }: Record<string, unknown>) {
  return (
    <div {...(rest as React.HTMLAttributes<HTMLDivElement>)}>{children as React.ReactNode}</div>
  );
}
vi.mock('motion/react', () => ({
  motion: new Proxy({} as Record<string, typeof PassThrough>, { get: () => PassThrough }),
  useReducedMotion: () => true,
  AnimatePresence: PassThrough,
}));

type MockContent =
  | { type: 'markdown'; content: string; title?: string }
  | { type: 'json'; data: unknown; title?: string };

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

/** Two open documents: a broken JSON viewer (active) and a healthy markdown doc. */
function setBrokenPlusHealthy(): void {
  mockState.openDocuments = [
    {
      id: 'd1',
      content: { type: 'json', data: {} },
      openedAt: 1,
      lastActiveAt: 2,
      sourceLabel: 'Broken JSON',
      editing: false,
    },
    {
      id: 'd2',
      content: { type: 'markdown', content: '# hi', title: 'Good Doc' },
      openedAt: 1,
      lastActiveAt: 1,
      sourceLabel: 'Good Doc',
      editing: false,
    },
  ];
  mockState.activeDocumentId = 'd1';
}

// The boundary logs every caught error — silence it so the suite output is honest.
let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  jsonControl.throws = true;
  mockState.openDocuments = [];
  mockState.activeDocumentId = null;
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
  cleanup();
});

describe('Canvas per-document error containment', () => {
  it('keeps the tab strip and sibling tabs alive when a viewer throws', async () => {
    const user = userEvent.setup();
    setBrokenPlusHealthy();
    render(<CanvasContent />);

    // The tab strip and BOTH tabs survive the broken viewer.
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Broken JSON/ })).toBeInTheDocument();
    const goodTab = screen.getByRole('tab', { name: /Good Doc/ });
    expect(goodTab).toBeInTheDocument();

    // The failure is contained to the body as a friendly card with Retry.
    expect(screen.getByText('This tab hit a problem.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();

    // Switching to the sibling tab still works.
    await user.click(goodTab);
    expect(mockState.activateCanvasDocument).toHaveBeenCalledWith('d2');

    // Closing the broken tab still works.
    await user.click(screen.getByRole('button', { name: /Close Broken JSON/ }));
    expect(mockState.closeCanvasDocument).toHaveBeenCalledWith('d1');
  });

  it('clears the error fallback when the active document switches to a healthy tab', async () => {
    setBrokenPlusHealthy();
    const { rerender } = render(<CanvasContent />);
    expect(screen.getByText('This tab hit a problem.')).toBeInTheDocument();

    // The keyed boundary resets on a tab switch — the healthy document renders.
    mockState.activeDocumentId = 'd2';
    rerender(<CanvasContent />);
    expect(screen.queryByText('This tab hit a problem.')).not.toBeInTheDocument();
    expect(await screen.findByTestId('blintz-canvas')).toBeInTheDocument();
  });
});
