/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TooltipProvider } from '@/layers/shared/ui';
import type { RightPanelContribution } from '@/layers/shared/model';

// Mutable mock state — mutate per-test
const mockSetRightPanelOpen = vi.fn();
const mockSetActiveRightPanelTab = vi.fn();

let mockActiveRightPanelTab: string | null = null;
let mockPathname = '/session';
let mockContributions: RightPanelContribution[] = [];
// The active transport gates capability-scoped tabs (e.g. the web-only
// terminal); mutate per-test to exercise the transport-gated visibility path.
let mockTransport: { supportsTerminal: boolean } = { supportsTerminal: true };

vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      setRightPanelOpen: mockSetRightPanelOpen,
      activeRightPanelTab: mockActiveRightPanelTab,
      setActiveRightPanelTab: mockSetActiveRightPanelTab,
    }),
  useSlotContributions: () => mockContributions,
  useTransport: () => mockTransport,
}));

vi.mock('@tanstack/react-router', () => ({
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: mockPathname } }),
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

// Import after mocks are set up
import { RightPanelHeader } from '../ui/RightPanelHeader';

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

function renderHeader() {
  return render(
    <TooltipProvider>
      <RightPanelHeader />
    </TooltipProvider>
  );
}

describe('RightPanelHeader', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  beforeEach(() => {
    mockActiveRightPanelTab = 'agent';
    mockPathname = '/session';
    mockContributions = [];
    mockTransport = { supportsTerminal: true };
  });

  it('renders one tab per visible contribution', () => {
    mockContributions = [
      makeContribution('agent', { title: 'Agent Profile' }),
      makeContribution('canvas', { title: 'Canvas' }),
    ];
    renderHeader();

    expect(screen.getByRole('tab', { name: 'Agent Profile' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Canvas' })).toBeInTheDocument();
  });

  // Regression (DOR-218): the tab strip must forward `transport` to visibleWhen
  // so capability-gated tabs (the web-only terminal) surface. Before the fix the
  // predicate saw `transport === undefined` and the Terminal tab never rendered.
  it('renders a transport-gated tab when the active transport has the capability', () => {
    mockTransport = { supportsTerminal: true };
    mockContributions = [
      makeContribution('agent', { title: 'Agent Profile' }),
      makeContribution('terminal', {
        title: 'Terminal',
        visibleWhen: ({ pathname, transport }) =>
          pathname === '/session' && transport?.supportsTerminal === true,
      }),
    ];
    renderHeader();

    expect(screen.getByRole('tab', { name: 'Terminal' })).toBeInTheDocument();
  });

  it('hides a transport-gated tab when the active transport lacks the capability', () => {
    mockTransport = { supportsTerminal: false };
    mockContributions = [
      makeContribution('agent', { title: 'Agent Profile' }),
      makeContribution('canvas', { title: 'Canvas' }),
      makeContribution('terminal', {
        title: 'Terminal',
        visibleWhen: ({ pathname, transport }) =>
          pathname === '/session' && transport?.supportsTerminal === true,
      }),
    ];
    renderHeader();

    // Always-visible tabs remain; the gated Terminal tab is absent.
    expect(screen.getByRole('tab', { name: 'Agent Profile' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Canvas' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Terminal' })).not.toBeInTheDocument();
  });

  it('always renders the close button', () => {
    mockContributions = [makeContribution('agent', { title: 'Agent Profile' })];
    renderHeader();

    expect(screen.getByRole('button', { name: 'Close panel' })).toBeInTheDocument();
  });
});
