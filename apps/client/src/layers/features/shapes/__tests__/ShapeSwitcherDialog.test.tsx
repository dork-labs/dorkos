/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  ApplyShapeResult,
  ForkShapeResult,
  InstalledShapeSummary,
} from '@dorkos/shared/marketplace-schemas';
import { TransportProvider, useAgentCreationStore, useAppStore } from '@/layers/shared/model';
import { createQueryClientConfig } from '@/layers/shared/lib';
import { createMockTransport } from '@dorkos/test-utils';
import { ShapeSwitcherDialog } from '../ui/ShapeSwitcherDialog';

const mockNavigate = vi.fn();
// `useRouter` too: the agent switch reads the router's own location to notice
// when something else navigated while its lookup was out (DOR-928). It reads
// `pathname` and `search`, so the shape has to be the router's, not a stand-in.
const mockLocation = { pathname: '/session', search: {} };
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  useRouter: () => ({
    state: {
      get location() {
        return mockLocation;
      },
    },
  }),
}));

// Every toast the switcher can raise has to be observable, or "reported exactly
// once" is unprovable. The real module is spread back in so a call this file did
// not anticipate still works: an unmocked `toast.*` would throw inside a mutation
// callback, and query-core swallows that — the exact silent failure DOR-453 is about.
vi.mock('sonner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sonner')>();
  return {
    ...actual,
    toast: Object.assign(vi.fn(), actual.toast, {
      error: vi.fn(),
      success: vi.fn(),
      warning: vi.fn(),
      info: vi.fn(),
    }),
  };
});

/** The app-wide fallback the fork must never fall back to (DOR-402/DOR-453). */
const GENERIC_MUTATION_TOAST = "That didn't work. Try again.";

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

/**
 * A throwaway client carrying the app's *real* cache policy — borrowed whole
 * rather than re-declared, so "a fork failure never arrives as the generic
 * toast" asserts production behaviour. Only query retries are overridden, so a
 * failing query fails the test instead of backing off.
 */
function testQueryClient(): QueryClient {
  const config = createQueryClientConfig();
  return new QueryClient({
    ...config,
    defaultOptions: {
      ...config.defaultOptions,
      queries: { ...config.defaultOptions?.queries, retry: false },
    },
  });
}

function renderDialog(transport = createMockTransport()) {
  const queryClient = testQueryClient();
  const onOpenChange = vi.fn();
  const tree = (open: boolean) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <ShapeSwitcherDialog open={open} onOpenChange={onOpenChange} />
      </TransportProvider>
    </QueryClientProvider>
  );
  const { rerender } = render(tree(true));
  return {
    transport,
    onOpenChange,
    queryClient,
    /**
     * Flip the `open` prop the way an outside actor does — the command palette or
     * an agent's `control_ui` setting `shapeSwitcherOpen` straight on the store,
     * which never routes through the dialog's own `onOpenChange`.
     */
    setOpen: (open: boolean) => rerender(tree(open)),
  };
}

describe('ShapeSwitcherDialog', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.success).mockClear();
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

  /**
   * A `forkShape` the test keeps in flight until it settles it by hand — the only
   * way to be inside the window where the request is out and the form can leave.
   */
  function deferredFork() {
    let settleResolve: ((result: ForkShapeResult) => void) | undefined;
    let settleReject: ((error: Error) => void) | undefined;
    const forkShape = vi.fn(
      () =>
        new Promise<ForkShapeResult>((resolve, reject) => {
          settleResolve = resolve;
          settleReject = reject;
        })
    );
    return {
      forkShape,
      resolve: (result: ForkShapeResult) => settleResolve!(result),
      reject: (error: Error) => settleReject!(error),
    };
  }

  /** Fill in the fork name and submit, then wait for the request to be out. */
  async function submitFork(forkShape: ReturnType<typeof deferredFork>['forkShape'], as: string) {
    fireEvent.change(await screen.findByLabelText(/name your version/i), { target: { value: as } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
    await waitFor(() => expect(forkShape).toHaveBeenCalled());
  }

  /** Press Escape inside the dialog, the way a person leaning on the key would. */
  function pressEscape() {
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  }

  /** Wait for the inline name field to leave the screen. */
  async function waitForFormGone() {
    await waitFor(() =>
      expect(screen.queryByLabelText(/name your version/i)).not.toBeInTheDocument()
    );
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

  it("surfaces the server's 409 message inline — and only there — keeping the form open", async () => {
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
    // Reported exactly once: the field says which name is taken, and no toast
    // talks over it — least of all the app-wide fallback toast.
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('reports the failure as a toast when the name field left before the answer landed', async () => {
    const { forkShape, reject } = deferredFork();
    await openForkForm(
      createMockTransport({ listShapes: vi.fn().mockResolvedValue(SHAPES), forkShape })
    );
    await submitFork(forkShape, 'my-board');

    // Walk away mid-flight: the field that would have shown the refusal is gone.
    pressEscape();
    await waitForFormGone();
    reject(new Error("A Shape named 'my-board' already exists"));

    // Still exactly one report, and it still names the actual problem.
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't save your version", {
        description: "A Shape named 'my-board' already exists",
      })
    );
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalledWith(GENERIC_MUTATION_TOAST);
  });

  it('still confirms a copy that lands after the form is gone', async () => {
    const { forkShape, resolve } = deferredFork();
    await openForkForm(
      createMockTransport({ listShapes: vi.fn().mockResolvedValue(SHAPES), forkShape })
    );
    await submitFork(forkShape, 'my-board');

    pressEscape();
    await waitForFormGone();
    resolve(forkResult('my-board'));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Saved your version as my-board')
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('backs out one layer at a time: Escape closes the form, then the switcher', async () => {
    const { onOpenChange } = await openForkForm(
      createMockTransport({ listShapes: vi.fn().mockResolvedValue(SHAPES) })
    );

    pressEscape();

    // The form folds away and you keep your place in the list.
    await waitForFormGone();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: /reset flow board to defaults/i })
    ).toBeInTheDocument();

    // A second Escape leaves the switcher itself.
    pressEscape();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('lets Escape out of a pending form without wedging the switcher shut', async () => {
    const { forkShape } = deferredFork();
    const { onOpenChange } = await openForkForm(
      createMockTransport({ listShapes: vi.fn().mockResolvedValue(SHAPES), forkShape })
    );
    await submitFork(forkShape, 'my-board');

    // A copy in flight never traps anyone: Escape still backs out of the form…
    pressEscape();
    await waitForFormGone();
    expect(onOpenChange).not.toHaveBeenCalled();

    // …and the next Escape still leaves the switcher.
    pressEscape();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('holds Cancel back while the copy is in flight, since it cannot cancel it', async () => {
    const { forkShape } = deferredFork();
    await openForkForm(
      createMockTransport({ listShapes: vi.fn().mockResolvedValue(SHAPES), forkShape })
    );
    await submitFork(forkShape, 'my-board');

    // A local write cannot be called back, so a live "Cancel" would promise
    // something it cannot do — and the copy would land after you abandoned it.
    // Escape and the ✕ are the honest exits; they say nothing about the request.
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeDisabled();
  });

  it('reports a failure exactly once when the form is reopened mid-copy', async () => {
    const { forkShape, reject } = deferredFork();
    await openForkForm(
      createMockTransport({ listShapes: vi.fn().mockResolvedValue(SHAPES), forkShape })
    );
    await submitFork(forkShape, 'my-board');
    pressEscape();
    await waitForFormGone();

    // Come back to the form while the first copy is still out. Wiping the
    // mutation here would take the inline surface away while still claiming it
    // exists — the failure would land nowhere at all.
    fireEvent.click(screen.getByRole('button', { name: /make your own version/i }));
    await screen.findByLabelText(/name your version/i);
    // The copy is still yours to wait on, so Create cannot start a second one.
    expect(screen.getByRole('button', { name: /^create$/i })).toBeDisabled();

    reject(new Error("A Shape named 'my-board' already exists"));

    expect(await screen.findByRole('alert')).toHaveTextContent(/already exists/i);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('never attributes a refusal to a Shape it was not about', async () => {
    const forkShape = vi
      .fn()
      .mockRejectedValue(new Error("A Shape named 'my-board' already exists"));
    const listShapes = vi
      .fn()
      .mockResolvedValueOnce(SHAPES)
      .mockResolvedValue([
        { name: 'linear-ops', displayName: 'Linear Ops', active: true },
        { name: 'flow-board', displayName: 'Flow Board', active: false },
      ] satisfies InstalledShapeSummary[]);
    const { input, queryClient } = await openForkForm(
      createMockTransport({ listShapes, forkShape })
    );

    fireEvent.change(input, { target: { value: 'my-board' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already exists/i);

    // An agent's `control_ui apply_layout` moved the active Shape; this client
    // refetches and the form re-seeds for the Shape it now targets.
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    await waitFor(() =>
      expect(screen.getByLabelText(/name your version/i)).toHaveValue('linear-ops-fork')
    );

    // The refusal was about flow-board. It must not follow the form across.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reports a failure as a toast when the switcher is closed from outside mid-copy', async () => {
    const { forkShape, reject } = deferredFork();
    const { setOpen } = await openForkForm(
      createMockTransport({ listShapes: vi.fn().mockResolvedValue(SHAPES), forkShape })
    );
    await submitFork(forkShape, 'my-board');

    // Nothing here routes through the dialog's own dismissal, so the footer still
    // believes the form is open — only `open` itself knows the field is gone.
    setOpen(false);
    await waitForFormGone();
    reject(new Error("A Shape named 'my-board' already exists"));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't save your version", {
        description: "A Shape named 'my-board' already exists",
      })
    );
    expect(toast.error).toHaveBeenCalledTimes(1);
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

  // --- Keyboard place-keeping (DOR-513) ---
  //
  // These lock the wiring: leaving the form arms a restore, and the trigger
  // takes focus the moment it remounts. Seeded without the fix, the Escape and
  // Cancel cases go red here, and on the same wrong answer the browser gives —
  // the `DialogContent` container, `div[role=dialog][tabindex="-1"]`, Radix
  // `FocusScope`'s generic fallback for a removed focus owner. The other two
  // cases guard the arm/disarm logic the fix introduces.
  //
  // That agreement is luck, not a contract, and it is not what makes the fix
  // safe. jsdom's focus model diverges from a real browser's exactly where this
  // bug lives (event ordering around removal, and the MutationObserver the
  // fallback rides), and the consequence that made this worth fixing — where the
  // NEXT Tab goes — has no meaning here at all. The proof is the browser drive:
  // `apps/e2e/tests/shapes/shape-switcher-focus.spec.ts`.

  /** The footer button that opens the name form — the thing focus must return to. */
  function forkTrigger() {
    return screen.getByRole('button', { name: /make your own version/i });
  }

  it('hands focus back to the trigger when Escape folds the form away', async () => {
    await openForkForm(createMockTransport({ listShapes: vi.fn().mockResolvedValue(SHAPES) }));

    pressEscape();
    await waitForFormGone();

    expect(forkTrigger()).toHaveFocus();
  });

  it('hands focus back to the trigger when Cancel folds the form away', async () => {
    await openForkForm(createMockTransport({ listShapes: vi.fn().mockResolvedValue(SHAPES) }));

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    await waitForFormGone();

    expect(forkTrigger()).toHaveFocus();
  });

  it('does not pull focus to the fork trigger when a Shape is picked instead of backing out', async () => {
    // Picking a Shape closes the form too, but that is not backing out of it,
    // so the trigger must not take focus. (In a real browser focus lands on
    // the dialog container here, before and after DOR-513 — this asserts only
    // the non-restore, which handleApply's explicit disarm now guarantees.)
    await openForkForm(
      createMockTransport({
        listShapes: vi.fn().mockResolvedValue(SHAPES),
        applyShape: vi.fn().mockResolvedValue(applyResult()),
      })
    );

    fireEvent.click(screen.getByText('Linear Ops'));
    await waitForFormGone();

    expect(forkTrigger()).not.toHaveFocus();
  });

  it('does not take focus on a later open when a copy landed after the switcher closed', async () => {
    // The trap the render-time disarm exists for: the copy settles while the
    // switcher is gone, so its `onSuccess` leaves the form — and arms a restore
    // — with no trigger on screen to receive it. Reopening the switcher remounts
    // that trigger, and a still-armed restore would snatch focus off whatever
    // the dialog just put it on.
    const { forkShape, resolve } = deferredFork();
    const { setOpen } = await openForkForm(
      createMockTransport({ listShapes: vi.fn().mockResolvedValue(SHAPES), forkShape })
    );
    await submitFork(forkShape, 'my-board');

    // Closed from outside (the palette, or an agent writing the store), which
    // never routes through the dialog's own `onOpenChange`.
    act(() => setOpen(false));
    await act(async () => {
      resolve(forkResult('my-board'));
    });
    act(() => setOpen(true));

    expect(await screen.findByRole('button', { name: /make your own version/i })).not.toHaveFocus();
  });
});
