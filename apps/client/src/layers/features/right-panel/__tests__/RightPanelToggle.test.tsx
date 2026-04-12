/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { TooltipProvider } from '@/layers/shared/ui';
import type { RightPanelContribution } from '@/layers/shared/model';

// Mutable state — mutate per-test
let mockRightPanelOpen = false;
let mockPathname = '/session';
let mockContributions: RightPanelContribution[] = [];
const mockToggleRightPanel = vi.fn();

vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      rightPanelOpen: mockRightPanelOpen,
      toggleRightPanel: mockToggleRightPanel,
    }),
  useSlotContributions: () => mockContributions,
}));

vi.mock('@tanstack/react-router', () => ({
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: mockPathname } }),
}));

vi.mock('@/layers/shared/lib', () => ({
  isMac: false,
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

const MockIcon = () => null;

function makeContribution(
  id: string,
  overrides: Partial<RightPanelContribution> = {}
): RightPanelContribution {
  return {
    id,
    title: `Tab ${id}`,
    icon: MockIcon as unknown as RightPanelContribution['icon'],
    component: () => <div>Content {id}</div>,
    ...overrides,
  };
}

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
    mockPathname = '/session';
    mockContributions = [];
    mockToggleRightPanel.mockClear();
  });

  it('returns null when there are no visible contributions', async () => {
    mockContributions = [];
    const { container } = await renderToggle();
    expect(container.innerHTML).toBe('');
  });

  it('renders when there are visible contributions', async () => {
    mockContributions = [makeContribution('a')];
    await renderToggle();
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('renders with "Open right panel" aria-label when closed', async () => {
    mockRightPanelOpen = false;
    mockContributions = [makeContribution('a')];
    await renderToggle();
    expect(screen.getByLabelText('Open right panel')).toBeInTheDocument();
  });

  it('renders with "Close right panel" aria-label when open', async () => {
    mockRightPanelOpen = true;
    mockContributions = [makeContribution('a')];
    await renderToggle();
    expect(screen.getByLabelText('Close right panel')).toBeInTheDocument();
  });

  it('calls toggleRightPanel when clicked', async () => {
    mockContributions = [makeContribution('a')];
    const user = userEvent.setup();
    await renderToggle();

    await user.click(screen.getByRole('button'));
    expect(mockToggleRightPanel).toHaveBeenCalledTimes(1);
  });

  it('hides when all contributions are filtered out by visibleWhen on the current route', async () => {
    mockPathname = '/';
    mockContributions = [
      makeContribution('a', { visibleWhen: ({ pathname }) => pathname === '/session' }),
    ];
    const { container } = await renderToggle();
    expect(container.innerHTML).toBe('');
  });

  it('shows when at least one contribution passes visibleWhen for the current route', async () => {
    mockPathname = '/session';
    mockContributions = [
      makeContribution('a', { visibleWhen: ({ pathname }) => pathname === '/session' }),
    ];
    await renderToggle();
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('shows when contribution has no visibleWhen predicate', async () => {
    mockContributions = [makeContribution('a')];
    await renderToggle();
    expect(screen.getByRole('button')).toBeInTheDocument();
  });
});
