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

vi.mock('motion/react', () => ({
  motion: new Proxy({} as Record<string, typeof PassThrough>, {
    get: () => PassThrough,
  }),
  useReducedMotion: () => true,
  AnimatePresence: PassThrough,
}));

const mockSetCanvasOpen = vi.fn();
const mockSetCanvasContent = vi.fn();

const mockState = {
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
  useIsMobile: () => false,
}));

import { CanvasContent } from '../ui/AgentCanvas';

afterEach(cleanup);

describe('CanvasContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.canvasContent = null;
  });

  it('renders canvas body without Panel or Sheet wrappers', () => {
    mockState.canvasContent = { type: 'markdown', content: '# Hello', title: 'Test Doc' };
    const { container } = render(<CanvasContent />);

    // The splash screen or content renders — no Panel/Sheet DOM wrappers
    expect(container.querySelector('[data-testid="panel"]')).toBeNull();
    expect(container.querySelector('[data-testid="sheet"]')).toBeNull();
    expect(container.querySelector('[data-testid="sheet-content"]')).toBeNull();
    expect(container.querySelector('[data-testid="resize-handle"]')).toBeNull();
    expect(screen.getByText('Test Doc')).toBeInTheDocument();
  });

  it('renders the shared right-panel header', () => {
    mockState.canvasContent = { type: 'json', data: {}, title: 'My JSON' };
    render(<CanvasContent />);

    expect(screen.getByTestId('right-panel-header')).toBeInTheDocument();
  });
});
