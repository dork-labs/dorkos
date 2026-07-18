/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ApplyShapeResult, InstalledShapeSummary } from '@dorkos/shared/marketplace-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { ShapeSwitcherDialog } from '../ui/ShapeSwitcherDialog';

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
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
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // Radix focus-scope / dialog touch these in jsdom.
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn();
});

const SHAPES: InstalledShapeSummary[] = [
  { name: 'linear-ops', displayName: 'Linear Ops', active: false },
  { name: 'flow-board', displayName: 'Flow Board', active: true },
];

/** An apply result with a satisfied arrival agent + one degradation note. */
function applyResult(): ApplyShapeResult {
  return {
    ok: true,
    applied: {
      layout: {
        sidebarOpen: true,
        sidebarTab: 'overview',
        openPanels: [],
        focusDashboardSections: [],
      },
      activatedExtensions: ['linear-issues'],
      schedulesCreated: ['inbox-tick'],
    },
    warnings: ["Connection 'linear_api_key' for 'linear-issues' needs setup"],
    offeredAgents: [
      {
        ref: 'linear-tender',
        affinity: 'default',
        satisfied: true,
        arrival: true,
        autoFollow: false,
        agentId: 'a1',
        projectPath: '/home/kai/linear',
        displayName: 'Linear Tender',
      },
    ],
  };
}

function renderDialog(transport = createMockTransport()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <ShapeSwitcherDialog open onOpenChange={onOpenChange} />
      </TransportProvider>
    </QueryClientProvider>
  );
  return { transport, onOpenChange };
}

describe('ShapeSwitcherDialog', () => {
  beforeEach(() => mockNavigate.mockClear());
  afterEach(cleanup);

  it('lists installed Shapes and marks the active one', async () => {
    const transport = createMockTransport({ listShapes: vi.fn().mockResolvedValue(SHAPES) });
    renderDialog(transport);

    expect(await screen.findByText('Linear Ops')).toBeInTheDocument();
    const activeRow = screen.getByText('Flow Board').closest('button')!;
    expect(within(activeRow).getByText('Active')).toBeInTheDocument();
  });

  it('applies a Shape on click, then shows its arrival offer and degradation notes', async () => {
    const applyShape = vi.fn().mockResolvedValue(applyResult());
    const transport = createMockTransport({
      listShapes: vi.fn().mockResolvedValue(SHAPES),
      applyShape,
    });
    renderDialog(transport);

    fireEvent.click(await screen.findByText('Linear Ops'));

    await waitFor(() => expect(applyShape).toHaveBeenCalledWith('linear-ops'));
    // The arrival agent is offered (never auto-switched here — autoFollow is off).
    expect(await screen.findByText(/suggests the/i)).toHaveTextContent('Linear Tender');
    // The §7 note reaches the user in the dialog, not just the console.
    expect(screen.getByText(/needs setup/i)).toBeInTheDocument();
  });

  it('follows a satisfied arrival agent when the offer is accepted', async () => {
    const transport = createMockTransport({
      listShapes: vi.fn().mockResolvedValue(SHAPES),
      applyShape: vi.fn().mockResolvedValue(applyResult()),
    });
    renderDialog(transport);

    fireEvent.click(await screen.findByText('Linear Ops'));
    const openBtn = await screen.findByRole('button', { name: /open linear tender/i });
    fireEvent.click(openBtn);

    // switchAgentCwd routes to the /session route for the agent's cwd.
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith(
        expect.objectContaining({
          to: '/session',
          search: expect.objectContaining({ dir: '/home/kai/linear' }),
        })
      )
    );
  });

  it('re-applies the active Shape via "Reset to defaults"', async () => {
    const applyShape = vi.fn().mockResolvedValue(applyResult());
    const transport = createMockTransport({
      listShapes: vi.fn().mockResolvedValue(SHAPES),
      applyShape,
    });
    renderDialog(transport);

    fireEvent.click(await screen.findByRole('button', { name: /reset flow board to defaults/i }));
    await waitFor(() => expect(applyShape).toHaveBeenCalledWith('flow-board'));
  });

  it('shows a marketplace-pointing empty state when nothing is installed', async () => {
    const transport = createMockTransport({ listShapes: vi.fn().mockResolvedValue([]) });
    renderDialog(transport);

    expect(await screen.findByText(/no shapes installed yet/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /browse marketplace/i }));
    expect(mockNavigate).toHaveBeenCalledWith(expect.objectContaining({ to: '/marketplace' }));
  });
});
