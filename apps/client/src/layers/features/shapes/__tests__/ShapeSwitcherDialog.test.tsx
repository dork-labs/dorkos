/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  ApplyShapeResult,
  ForkShapeResult,
  InstalledShapeSummary,
} from '@dorkos/shared/marketplace-schemas';
import { TransportProvider, useAgentCreationStore, useAppStore } from '@/layers/shared/model';
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

/** An apply result whose arrival agent is unsatisfied — carries a scaffold template. */
function unsatisfiedResult(): ApplyShapeResult {
  return {
    ok: true,
    applied: {
      layout: { sidebarOpen: true, openPanels: [], focusDashboardSections: [] },
      activatedExtensions: [],
      schedulesCreated: [],
      schedulesRebound: [],
    },
    warnings: [],
    offeredAgents: [
      {
        ref: 'linear-keeper',
        affinity: 'default',
        satisfied: false,
        arrival: true,
        autoFollow: false,
        displayName: 'Linear Keeper',
        template: {
          displayName: 'Linear Keeper',
          runtime: 'claude-code',
          persona: 'I keep your Linear board tidy.',
          capabilities: ['linear'],
          skills: ['linear-adapter'],
        },
        scheduleSummary: 'Every weekday at 9:00 AM',
      },
    ],
  };
}

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
      schedulesRebound: [],
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

/** An apply result whose satisfied arrival agent opted into auto-follow. */
function autoFollowResult(): ApplyShapeResult {
  const base = applyResult();
  return {
    ...base,
    // Auto-follow off in applyResult(); flip it on for this satisfied arrival.
    offeredAgents: base.offeredAgents.map((a) => (a.arrival ? { ...a, autoFollow: true } : a)),
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
  beforeEach(() => {
    mockNavigate.mockClear();
    useAgentCreationStore.setState({ isOpen: false, initialMode: 'new', seed: null });
    // Reset the chrome the fork capture reads, so one test's arrangement never
    // leaks into the next one's expectations.
    useAppStore.setState({
      shapeSwitcherFocus: null,
      sidebarOpen: false,
      settingsOpen: false,
      tasksOpen: false,
      relayOpen: false,
      pickerOpen: false,
    });
  });
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

  it('auto-follows a satisfied arrival agent, then dismisses itself with no redundant Open', async () => {
    const { onOpenChange } = renderDialog(
      createMockTransport({
        listShapes: vi.fn().mockResolvedValue(SHAPES),
        applyShape: vi.fn().mockResolvedValue(autoFollowResult()),
      })
    );

    fireEvent.click(await screen.findByText('Linear Ops'));

    // Auto-follow (opt-in) routed us to the agent's cwd inside applyShapeAction.
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith(
        expect.objectContaining({
          to: '/session',
          search: expect.objectContaining({ dir: '/home/kai/linear' }),
        })
      )
    );
    // §3c: the switcher's job is done — it dismisses itself rather than sitting
    // as dead chrome over the place it just took you.
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    // §3a: the redundant "Open" button never appears (we're already there).
    expect(screen.queryByRole('button', { name: /open linear tender/i })).not.toBeInTheDocument();
  });

  it('seeds M1 agent creation when an unsatisfied arrival offer is set up', async () => {
    const { onOpenChange } = renderDialog(
      createMockTransport({
        listShapes: vi.fn().mockResolvedValue(SHAPES),
        applyShape: vi.fn().mockResolvedValue(unsatisfiedResult()),
      })
    );

    fireEvent.click(await screen.findByText('Linear Ops'));

    // Unsatisfied → "Set up", not "Open" (there is no agent to open yet).
    const setUpBtn = await screen.findByRole('button', { name: /set up linear keeper/i });
    fireEvent.click(setUpBtn);

    // The offer's full template rides into the creation store as an M1 seed.
    const state = useAgentCreationStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.seed).toEqual(
      expect.objectContaining({
        origin: 'shape-offer',
        sourceLabel: 'Linear Ops',
        template: expect.objectContaining({
          displayName: 'Linear Keeper',
          runtime: 'claude-code',
          persona: 'I keep your Linear board tidy.',
          capabilities: ['linear'],
          skills: ['linear-adapter'],
          // The server-derived cadence line rides into the seed so the M1
          // ledger can show a schedule that is actually real.
          schedule: 'Every weekday at 9:00 AM',
        }),
      })
    );
    // The switcher steps aside so the creation dialog can take over.
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows the offered agent's schedule in plain words when the Shape declares one", async () => {
    const transport = createMockTransport({
      listShapes: vi.fn().mockResolvedValue(SHAPES),
      applyShape: vi.fn().mockResolvedValue(unsatisfiedResult()),
    });
    renderDialog(transport);

    fireEvent.click(await screen.findByText('Linear Ops'));

    // The server-derived cadence line renders in the offer card (no raw cron).
    expect(await screen.findByText('Every weekday at 9:00 AM')).toBeInTheDocument();
  });

  it('omits the schedule line when the offer carries no cadence', async () => {
    // applyResult()'s arrival agent has no scheduleSummary — the line is absent.
    const transport = createMockTransport({
      listShapes: vi.fn().mockResolvedValue(SHAPES),
      applyShape: vi.fn().mockResolvedValue(applyResult()),
    });
    renderDialog(transport);

    fireEvent.click(await screen.findByText('Linear Ops'));

    // The offer card is shown, but no schedule line.
    expect(await screen.findByText(/suggests the/i)).toBeInTheDocument();
    expect(screen.queryByText(/every weekday/i)).not.toBeInTheDocument();
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

  it('highlights and scrolls to the Shape an Apply affordance asked it to focus', async () => {
    // The install toast / installed-list "Apply…" set shapeSwitcherFocus so the
    // user lands on the exact Shape — highlighted and scrolled into view, never
    // auto-applied.
    useAppStore.setState({ shapeSwitcherFocus: 'linear-ops' });
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView');
    const applyShape = vi.fn();
    const transport = createMockTransport({
      listShapes: vi.fn().mockResolvedValue(SHAPES),
      applyShape,
    });
    renderDialog(transport);

    const focused = (await screen.findByText('Linear Ops')).closest('button')!;
    expect(focused).toHaveAttribute('data-highlighted', 'true');
    // A different Shape is not highlighted.
    const other = screen.getByText('Flow Board').closest('button')!;
    expect(other).not.toHaveAttribute('data-highlighted');
    // The focused card was scrolled into view on mount (never auto-applied).
    expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' });
    expect(applyShape).not.toHaveBeenCalled();
  });

  it('shows a marketplace-pointing empty state when nothing is installed', async () => {
    const transport = createMockTransport({ listShapes: vi.fn().mockResolvedValue([]) });
    renderDialog(transport);

    expect(await screen.findByText(/no shapes installed yet/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /browse marketplace/i }));
    expect(mockNavigate).toHaveBeenCalledWith(expect.objectContaining({ to: '/marketplace' }));
  });

  // --- Make your own version (DOR-402) ---

  /** A fork response for `flow-board` (the active Shape in SHAPES). */
  function forkResult(name = 'flow-board-fork'): ForkShapeResult {
    return {
      ok: true,
      name,
      forkedFrom: 'flow-board@dorkos-community',
      installPath: `/home/kai/.dork/shapes/${name}`,
      manifest: {},
    };
  }

  /** Open the footer's inline "make your own version" form and return its input. */
  async function openForkForm(transport = createMockTransport()) {
    const rendered = renderDialog(transport);
    fireEvent.click(await screen.findByRole('button', { name: /make your own version/i }));
    return { ...rendered, input: await screen.findByLabelText(/name your version/i) };
  }

  it('opens an inline form pre-filled with the default name, scoped to the active Shape', async () => {
    // Only the ACTIVE Shape gets the affordance — capture only means anything
    // there — and the default matches the API's own `<active>-fork`.
    const { input } = await openForkForm(
      createMockTransport({ listShapes: vi.fn().mockResolvedValue(SHAPES) })
    );

    expect(input).toHaveValue('flow-board-fork');
    // The hint says truthfully what rides along.
    expect(screen.getByText(/extensions you have turned on/i)).toBeInTheDocument();
  });

  it('rejects a name the server would refuse, before any request', async () => {
    const forkShape = vi.fn();
    const { input } = await openForkForm(
      createMockTransport({ listShapes: vi.fn().mockResolvedValue(SHAPES), forkShape })
    );

    fireEvent.change(input, { target: { value: 'Not A Slug!' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/lowercase letters/i);
    expect(forkShape).not.toHaveBeenCalled();
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('captures the live chrome and creates the copy without applying it', async () => {
    // The chrome the person is living in, straight from the app store.
    useAppStore.setState({
      sidebarOpen: true,
      settingsOpen: false,
      tasksOpen: true,
      relayOpen: false,
      pickerOpen: false,
    });
    const forkShape = vi.fn().mockResolvedValue(forkResult('my-board'));
    const applyShape = vi.fn();
    const listShapes = vi.fn().mockResolvedValue(SHAPES);
    const { input } = await openForkForm(
      createMockTransport({ listShapes, forkShape, applyShape })
    );

    fireEvent.change(input, { target: { value: 'my-board' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() =>
      expect(forkShape).toHaveBeenCalledWith('flow-board', {
        as: 'my-board',
        captureCurrent: true,
        // Only the observed fields — sidebarTab and focusDashboardSections are
        // omitted so the source Shape's values survive.
        liveLayout: { sidebarOpen: true, openPanels: ['tasks'] },
      })
    );
    // The list is refreshed so the copy appears with its "forked from …" caption…
    await waitFor(() => expect(listShapes.mock.calls.length).toBeGreaterThan(1));
    // …and the footer returns to rest.
    await waitFor(() =>
      expect(screen.queryByLabelText(/name your version/i)).not.toBeInTheDocument()
    );
    // The arrangement already IS the new Shape — applying it would be a no-op.
    expect(applyShape).not.toHaveBeenCalled();
  });

  it("surfaces the server's 409 message inline and keeps the form open", async () => {
    const forkShape = vi
      .fn()
      .mockRejectedValue(new Error("A Shape named 'my-board' already exists"));
    const { input } = await openForkForm(
      createMockTransport({ listShapes: vi.fn().mockResolvedValue(SHAPES), forkShape })
    );

    fireEvent.change(input, { target: { value: 'my-board' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/already exists/i);
    expect(screen.getByLabelText(/name your version/i)).toBeInTheDocument();
  });

  it('closes the form when another Shape is applied, rather than re-aiming at it', async () => {
    // The form only ever targets the ACTIVE Shape. Applying a different one moves
    // that target, so a half-typed name must not silently follow it across.
    const forkShape = vi.fn();
    const { input } = await openForkForm(
      createMockTransport({
        listShapes: vi.fn().mockResolvedValue(SHAPES),
        applyShape: vi.fn().mockResolvedValue(applyResult()),
        forkShape,
      })
    );

    fireEvent.change(input, { target: { value: 'my-board' } });
    fireEvent.click(screen.getByText('Linear Ops'));

    await waitFor(() =>
      expect(screen.queryByLabelText(/name your version/i)).not.toBeInTheDocument()
    );
    expect(forkShape).not.toHaveBeenCalled();
  });

  it('cancels back to the footer buttons without creating anything', async () => {
    const forkShape = vi.fn();
    await openForkForm(
      createMockTransport({ listShapes: vi.fn().mockResolvedValue(SHAPES), forkShape })
    );

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    await waitFor(() =>
      expect(screen.queryByLabelText(/name your version/i)).not.toBeInTheDocument()
    );
    expect(
      screen.getByRole('button', { name: /reset flow board to defaults/i })
    ).toBeInTheDocument();
    expect(forkShape).not.toHaveBeenCalled();
  });
});
