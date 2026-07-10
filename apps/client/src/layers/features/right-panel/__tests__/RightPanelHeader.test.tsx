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

// The header reads only the active tab and the open/close setters from the
// store now — the container owns contribution filtering and passes the visible
// list in as a prop.
vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      setRightPanelOpen: mockSetRightPanelOpen,
      activeRightPanelTab: mockActiveRightPanelTab,
      setActiveRightPanelTab: mockSetActiveRightPanelTab,
    }),
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

function renderHeader(contributions: RightPanelContribution[], actions?: React.ReactNode) {
  return render(
    <TooltipProvider>
      <RightPanelHeader contributions={contributions} actions={actions} />
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
  });

  it('renders one tab per contribution when there are 2+', () => {
    renderHeader([
      makeContribution('agent', { title: 'Agent Profile' }),
      makeContribution('canvas', { title: 'Canvas' }),
    ]);

    expect(screen.getByRole('tablist', { name: 'Right panel tabs' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Agent Profile' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Canvas' })).toBeInTheDocument();
  });

  it('renders no tab strip with a single contribution', () => {
    renderHeader([makeContribution('agent', { title: 'Agent Profile' })]);

    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('renders the active tab actions beside the close button', () => {
    renderHeader(
      [makeContribution('agent'), makeContribution('files')],
      <button type="button">New File</button>
    );

    expect(screen.getByRole('button', { name: 'New File' })).toBeInTheDocument();
  });

  it('always renders the close button', () => {
    renderHeader([makeContribution('agent', { title: 'Agent Profile' })]);

    expect(screen.getByRole('button', { name: 'Close panel' })).toBeInTheDocument();
  });
});
