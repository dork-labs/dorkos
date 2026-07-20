/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { TooltipProvider } from '@/layers/shared/ui';

// Mutable state — mutate per-test
let mockRightPanelOpen = false;
const mockToggleRightPanel = vi.fn();
let mockAttentionItems: { id: string }[] = [];

// The toggle is now always mounted (the shell is never route-hidden), so it
// reads only the open flag + toggle action — no contribution/route/transport
// filtering.
vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      rightPanelOpen: mockRightPanelOpen,
      toggleRightPanel: mockToggleRightPanel,
    }),
}));

vi.mock('@/layers/shared/lib', () => ({
  isMac: false,
}));

// The ambient badge rides useAttentionItems — stub it so tests drive the count.
vi.mock('@/layers/features/dashboard-attention', () => ({
  useAttentionItems: () => ({ items: mockAttentionItems, isLoading: false }),
}));

vi.mock('motion/react', () => ({
  motion: {
    button: ({
      children,
      whileHover: _wh,
      whileTap: _wt,
      transition: _t,
      ...rest
    }: React.PropsWithChildren<Record<string, unknown>>) => (
      <button {...(rest as React.ButtonHTMLAttributes<HTMLButtonElement>)}>{children}</button>
    ),
    span: ({
      children,
      initial: _i,
      animate: _a,
      transition: _t,
      ...rest
    }: React.PropsWithChildren<Record<string, unknown>>) => (
      <span {...(rest as React.HTMLAttributes<HTMLSpanElement>)}>{children}</span>
    ),
  },
}));

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });

  // Radix UI Tooltip uses ResizeObserver internally — stub it for jsdom
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

async function renderToggle() {
  const { RightPanelToggle } = await import('../ui/RightPanelToggle');
  return render(
    <TooltipProvider>
      <RightPanelToggle />
    </TooltipProvider>
  );
}

describe('RightPanelToggle', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  beforeEach(() => {
    mockRightPanelOpen = false;
    mockAttentionItems = [];
    mockToggleRightPanel.mockClear();
  });

  const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `a-${i}` }));
  const BADGE = 'right-panel-attention-badge';

  // The shell is load-bearing infrastructure that is never route-hidden — the
  // toggle is always present so the panel can always be reopened, even where no
  // contribution is currently visible (fix 3).
  it('always renders the toggle button', async () => {
    await renderToggle();
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('renders with "Open right panel" aria-label when closed', async () => {
    mockRightPanelOpen = false;
    await renderToggle();
    expect(screen.getByLabelText('Open right panel')).toBeInTheDocument();
  });

  it('renders with "Close right panel" aria-label when open', async () => {
    mockRightPanelOpen = true;
    await renderToggle();
    expect(screen.getByLabelText('Close right panel')).toBeInTheDocument();
  });

  it('calls toggleRightPanel when clicked', async () => {
    const user = userEvent.setup();
    await renderToggle();

    await user.click(screen.getByRole('button'));
    expect(mockToggleRightPanel).toHaveBeenCalledTimes(1);
  });

  // --- Ambient attention badge -------------------------------------------------

  it('shows no badge when nothing needs attention', async () => {
    mockAttentionItems = [];
    await renderToggle();
    expect(screen.queryByTestId(BADGE)).not.toBeInTheDocument();
  });

  it('shows the attention count on the badge while the panel is closed', async () => {
    mockRightPanelOpen = false;
    mockAttentionItems = items(3);
    await renderToggle();
    expect(screen.getByTestId(BADGE)).toHaveTextContent('3');
  });

  it('caps the badge display at "9+"', async () => {
    mockAttentionItems = items(12);
    await renderToggle();
    expect(screen.getByTestId(BADGE)).toHaveTextContent('9+');
  });

  it('hides the badge while the panel is open (the count is visible inside)', async () => {
    mockRightPanelOpen = true;
    mockAttentionItems = items(3);
    await renderToggle();
    expect(screen.queryByTestId(BADGE)).not.toBeInTheDocument();
  });

  it('folds the count into the toggle aria-label when closed with items', async () => {
    mockRightPanelOpen = false;
    mockAttentionItems = items(3);
    await renderToggle();
    expect(screen.getByLabelText('Open right panel — 3 items need attention')).toBeInTheDocument();
  });

  it('uses the singular "item needs" for a single pending item', async () => {
    mockRightPanelOpen = false;
    mockAttentionItems = items(1);
    await renderToggle();
    expect(screen.getByLabelText('Open right panel — 1 item needs attention')).toBeInTheDocument();
  });

  it('keeps a plain aria-label when nothing needs attention', async () => {
    mockRightPanelOpen = false;
    mockAttentionItems = [];
    await renderToggle();
    expect(screen.getByLabelText('Open right panel')).toBeInTheDocument();
  });

  it('keeps a plain "Close right panel" aria-label when open, regardless of count', async () => {
    mockRightPanelOpen = true;
    mockAttentionItems = items(5);
    await renderToggle();
    expect(screen.getByLabelText('Close right panel')).toBeInTheDocument();
  });
});
