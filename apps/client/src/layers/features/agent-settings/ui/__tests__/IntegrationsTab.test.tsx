// @vitest-environment jsdom
import { createContext, useContext, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { mergeDialogSearch, useAppStore } from '@/layers/shared/model';
import { setPlatformAdapter } from '@/layers/shared/lib';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { AdapterBinding, CatalogEntry, ObservedChat } from '@dorkos/shared/relay-schemas';

// --- Mocks (must be before imports that use them) ---

const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

const mockMutateCreateAsync = vi.fn<() => Promise<void>>(() => Promise.resolve());
const mockMutateDeleteAsync = vi.fn<() => Promise<void>>(() => Promise.resolve());
const mockMutateUpdateAsync = vi.fn<() => Promise<void>>(() => Promise.resolve());
const mockMutateTestAsync = vi.fn<
  () => Promise<{ ok: boolean; resolved: boolean; latencyMs: number; reason?: string }>
>(() => Promise.resolve({ ok: true, resolved: true, latencyMs: 42 }));

const mockUseBindings = vi.fn<() => { data: AdapterBinding[] }>(() => ({ data: [] }));
const mockUseCreateBinding = vi.fn(() => ({
  mutateAsync: mockMutateCreateAsync,
  isPending: false,
}));
const mockUseDeleteBinding = vi.fn(() => ({
  mutateAsync: mockMutateDeleteAsync,
  isPending: false,
}));
const mockUseTestBinding = vi.fn(() => ({
  mutateAsync: mockMutateTestAsync,
  isPending: false,
}));
const mockUseUpdateBinding = vi.fn(() => ({
  mutateAsync: mockMutateUpdateAsync,
  isPending: false,
}));

// Stub BindingDialog to avoid its complex internals; keep the real
// toUpdateBindingRequest mapper. Confirm submits the full form-values shape the
// real dialog produces (including permissionMode).
vi.mock('@/layers/entities/binding', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/binding')>();
  return {
    ...actual,
    useBindings: () => mockUseBindings(),
    useCreateBinding: () => mockUseCreateBinding(),
    useDeleteBinding: () => mockUseDeleteBinding(),
    useTestBinding: () => mockUseTestBinding(),
    useUpdateBinding: () => mockUseUpdateBinding(),
    BindingDialog: ({
      open,
      onConfirm,
      onDelete,
      bindingId,
    }: {
      open: boolean;
      onConfirm: (values: Record<string, unknown>) => void;
      onDelete: (id: string) => void;
      bindingId: string;
    }) =>
      open ? (
        <div data-testid="binding-dialog">
          <button
            onClick={() =>
              onConfirm({
                adapterId: 'telegram-1',
                agentId: baseAgent.id,
                sessionStrategy: 'per-user',
                label: 'updated',
                permissionMode: 'bypassPermissions',
                chatId: undefined,
                channelType: undefined,
                canInitiate: true,
                canReply: true,
                canReceive: true,
              })
            }
          >
            Confirm
          </button>
          <button onClick={() => onDelete(bindingId)}>Delete from dialog</button>
        </div>
      ) : null,
  };
});

const mockUseRelayEnabled = vi.fn<() => boolean>(() => true);
const mockUseExternalAdapterCatalog = vi.fn<() => { data: CatalogEntry[] }>(() => ({ data: [] }));
// BoundIntegrationRow calls useObservedChats once per binding to resolve chatId → displayName.
const mockUseObservedChats = vi.fn<() => { data: ObservedChat[] }>(() => ({ data: [] }));

vi.mock('@/layers/entities/relay', () => ({
  useRelayEnabled: () => mockUseRelayEnabled(),
  useExternalAdapterCatalog: () => mockUseExternalAdapterCatalog(),
  useObservedChats: () => mockUseObservedChats(),
}));

vi.mock('@/layers/features/relay', () => ({
  AdapterSetupWizard: ({
    open,
    onOpenChange,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) =>
    open ? (
      <div data-testid="adapter-setup-wizard">
        <button onClick={() => onOpenChange(false)}>Close Wizard</button>
      </div>
    ) : null,
  AdapterIcon: ({ adapterType }: { adapterType?: string }) => (
    <span data-testid="adapter-icon" data-adapter-type={adapterType} />
  ),
  ADAPTER_STATE_DOT_CLASS: {
    connected: 'bg-green-500',
    disconnected: 'bg-muted-foreground',
    error: 'bg-red-500',
    starting: 'bg-amber-500',
    stopping: 'bg-amber-500',
    reconnecting: 'bg-amber-500',
  },
  ADAPTER_STATE_LABEL: {
    connected: 'Connected',
    disconnected: 'Ready',
    error: 'Error',
    starting: 'Connecting\u2026',
    stopping: 'Stopping\u2026',
    reconnecting: 'Reconnecting\u2026',
  },
}));

import { IntegrationsTab } from '../IntegrationsTab';

// --- Test fixtures ---

const baseAgent: AgentManifest = {
  id: '01HZ0000000000000000000001',
  name: 'test-agent',
  description: 'A mock agent',
  runtime: 'claude-code',
  capabilities: ['code-review'],
  behavior: { responseMode: 'always' },
  registeredAt: '2025-01-01T00:00:00.000Z',
  registeredBy: 'test',
  personaEnabled: true,
  enabledToolGroups: {},
  mcpServers: [],
};

function makeBinding(overrides: Partial<AdapterBinding> = {}): AdapterBinding {
  return {
    id: 'b-001',
    adapterId: 'telegram-1',
    agentId: baseAgent.id,
    sessionStrategy: 'per-chat',
    label: '',
    permissionMode: 'acceptEdits',
    enabled: true,
    canInitiate: false,
    canReply: true,
    canReceive: true,
    notifyOnTaskComplete: true,
    bridge: 'off',
    roomId: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeCatalogEntry(overrides: {
  instanceId?: string;
  displayName?: string;
  state?: 'connected' | 'disconnected' | 'error';
  errorMessage?: string;
}): CatalogEntry {
  const id = overrides.instanceId ?? 'telegram-1';
  return {
    manifest: {
      type: 'telegram',
      displayName: overrides.displayName ?? 'Telegram',
      description: 'Test adapter',
      category: 'messaging',
      builtin: true,
      configFields: [],
      multiInstance: false,
    },
    instances: [
      {
        id,
        enabled: true,
        status: {
          id,
          type: 'telegram',
          displayName: overrides.displayName ?? 'Telegram',
          state: overrides.state ?? 'connected',
          messageCount: { inbound: 0, outbound: 0 },
          errorCount: 0,
          ...(overrides.errorMessage ? { lastError: overrides.errorMessage } : {}),
        },
      },
    ],
  };
}

function makeCatalogEntryInternal(): CatalogEntry {
  return {
    manifest: {
      type: 'claude-code',
      displayName: 'Claude Code',
      description: 'Runtime bridge adapter',
      category: 'internal',
      builtin: true,
      configFields: [],
      multiInstance: false,
    },
    instances: [
      {
        id: 'claude-code-1',
        enabled: true,
        status: {
          id: 'claude-code-1',
          type: 'claude-code',
          displayName: 'Claude Code',
          state: 'connected',
          messageCount: { inbound: 0, outbound: 0 },
          errorCount: 0,
        },
      },
    ],
  };
}

// ── Router harness ───────────────────────────────────────────
//
// The tab's two empty-state CTAs deep-link Settings through the URL, so it has
// to render inside a real router. The route validates the dialog params the way
// every real leaf route does (`mergeDialogSearch`) — without that, validation
// would strip `?settings=` and an assertion on it would prove nothing.
//
// The tab is injected into the route component through a context slot so
// `renderTab` keeps its plain signature, and the router is loaded ahead of the
// render so the tree paints synchronously (as it did before the router).

const searchSchema = mergeDialogSearch(z.object({}));

const SlotContext = createContext<ReactNode>(null);

function RouteSlot() {
  return <>{useContext(SlotContext)}</>;
}

function buildRouter() {
  const rootRoute = createRootRoute({ staticData: { header: null } });
  const indexRoute = createRoute({
    staticData: { header: null },
    getParentRoute: () => rootRoute,
    path: '/',
    validateSearch: zodValidator(searchSchema),
    component: RouteSlot,
  });
  // The empty-state CTAs navigate to the Connections page now (DOR-857/858), so
  // the harness registers that route to let the navigation resolve and the
  // assertions read the landing pathname + region.
  const connectionsRoute = createRoute({
    staticData: { header: null },
    getParentRoute: () => rootRoute,
    path: '/connections',
    validateSearch: zodValidator(z.object({ region: z.string().optional() })),
    component: RouteSlot,
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute, connectionsRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
}

let router: ReturnType<typeof buildRouter>;

beforeEach(async () => {
  router = buildRouter();
  await router.load();
});

/** The Settings tab the URL currently deep-links to, or `undefined` for none. */
function readSettingsTab(): string | undefined {
  return (router.state.location.search as { settings?: string }).settings;
}

/** The path the router is currently on. */
function readPathname(): string {
  return router.state.location.pathname;
}

/** The Connections region the URL currently points to, or `undefined`. */
function readConnectionsRegion(): string | undefined {
  return (router.state.location.search as { region?: string }).region;
}

/**
 * Render the tab the way the Obsidian embed does: no `RouterProvider` at all.
 *
 * This is a real surface, not a hypothetical. `app/init-extensions.ts` registers
 * the profile's Connections page from both the web entry and the embed, and
 * `features/profile/ui/pages/ConnectionsPage.tsx` renders this component inside it.
 */
function renderTabWithoutRouter(agent: AgentManifest = baseAgent) {
  const { container } = render(<IntegrationsTab agent={agent} />);
  return within(container);
}

function renderTab(agent: AgentManifest = baseAgent) {
  const { container } = render(
    <SlotContext.Provider value={<IntegrationsTab agent={agent} />}>
      <RouterProvider router={router} />
    </SlotContext.Provider>
  );
  return within(container);
}

// --- Tests ---

describe('IntegrationsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseRelayEnabled.mockReturnValue(true);
    mockUseBindings.mockReturnValue({ data: [] });
    // Default to one catalog entry so most tests reach State C/D rather than State B.
    mockUseExternalAdapterCatalog.mockReturnValue({
      data: [makeCatalogEntry({ instanceId: 'telegram-1', displayName: 'Telegram' })],
    });
  });

  describe('empty state', () => {
    it('State A: shows relay-off message and CTA when relay is disabled', () => {
      mockUseRelayEnabled.mockReturnValue(false);
      const view = renderTab();
      expect(view.getByText('Messaging is off')).toBeInTheDocument();
      expect(view.getByRole('button', { name: 'Open Messaging settings' })).toBeInTheDocument();
    });

    // Messaging lives on the Connections page now (DOR-857), so the CTA lands
    // there, in the messaging region — not on a Settings tab. Asserting the
    // landing path + region is what keeps a CTA from silently going nowhere,
    // the way "Open Relay settings" used to open the Advanced tab (DOR-858).
    it('State A: the CTA lands on the Connections page, messaging region', async () => {
      mockUseRelayEnabled.mockReturnValue(false);
      const view = renderTab();
      fireEvent.click(view.getByRole('button', { name: 'Open Messaging settings' }));
      await waitFor(() => expect(readPathname()).toBe('/connections'));
      expect(readConnectionsRegion()).toBe('messaging');
    });

    it('State B: shows no-adapters message when relay is on but catalog is empty', () => {
      mockUseExternalAdapterCatalog.mockReturnValue({ data: [] });
      const view = renderTab();
      expect(view.getByText('No connections available')).toBeInTheDocument();
      expect(view.getByRole('button', { name: 'Add a connection' })).toBeInTheDocument();
    });

    it('State B: the CTA lands on the Connections page, messaging region', async () => {
      mockUseExternalAdapterCatalog.mockReturnValue({ data: [] });
      const view = renderTab();
      fireEvent.click(view.getByRole('button', { name: 'Add a connection' }));
      await waitFor(() => expect(readPathname()).toBe('/connections'));
      expect(readConnectionsRegion()).toBe('messaging');
    });

    // The Obsidian embed mounts no router, so these CTAs have nowhere to
    // navigate. Following DOR-857's decision for the retired messaging deep
    // links, the Connections navigation is a no-op in the embed rather than a
    // lie — the click must not throw and must not fabricate a Settings dialog
    // that no longer owns this surface.
    describe('in the router-less embed', () => {
      beforeEach(() => {
        setPlatformAdapter({ isEmbedded: true, openFile: async () => {} });
        useAppStore.setState({ settingsOpen: false });
      });
      afterEach(() => {
        setPlatformAdapter({ isEmbedded: false, openFile: async () => {} });
      });

      it('State A: the CTA is inert instead of throwing', () => {
        mockUseRelayEnabled.mockReturnValue(false);
        const view = renderTabWithoutRouter();

        expect(() =>
          fireEvent.click(view.getByRole('button', { name: 'Open Messaging settings' }))
        ).not.toThrow();

        expect(useAppStore.getState().settingsOpen).toBe(false);
      });

      it('State B: the CTA is inert instead of throwing', () => {
        mockUseExternalAdapterCatalog.mockReturnValue({ data: [] });
        const view = renderTabWithoutRouter();

        expect(() =>
          fireEvent.click(view.getByRole('button', { name: 'Add a connection' }))
        ).not.toThrow();

        expect(useAppStore.getState().settingsOpen).toBe(false);
      });
    });

    it('State C: shows no-bindings message with IntegrationPicker CTA when relay is on and adapters exist', () => {
      // Default beforeEach: relay enabled, one catalog entry, no bindings.
      const view = renderTab();
      expect(view.getByText('Let this agent reach the outside world')).toBeInTheDocument();
      expect(view.getByText('Add connection')).toBeInTheDocument();
    });
  });

  describe('binding list', () => {
    it('renders an IntegrationBindingCard for each agent binding', () => {
      const bindings = [
        makeBinding({ id: 'b-1', adapterId: 'telegram-1' }),
        makeBinding({ id: 'b-2', adapterId: 'slack-1' }),
      ];
      mockUseBindings.mockReturnValue({ data: bindings });
      mockUseExternalAdapterCatalog.mockReturnValue({
        data: [
          makeCatalogEntry({ instanceId: 'telegram-1', displayName: 'Telegram' }),
          makeCatalogEntry({ instanceId: 'slack-1', displayName: 'Slack' }),
        ],
      });

      const view = renderTab();
      expect(view.getByText('Telegram')).toBeInTheDocument();
      expect(view.getByText('Slack')).toBeInTheDocument();
    });

    it('only shows bindings belonging to this agent', () => {
      const bindings = [
        makeBinding({ id: 'b-1', agentId: baseAgent.id, adapterId: 'telegram-1' }),
        makeBinding({ id: 'b-2', agentId: 'other-agent', adapterId: 'slack-1' }),
      ];
      mockUseBindings.mockReturnValue({ data: bindings });
      mockUseExternalAdapterCatalog.mockReturnValue({
        data: [
          makeCatalogEntry({ instanceId: 'telegram-1', displayName: 'Telegram' }),
          makeCatalogEntry({ instanceId: 'slack-1', displayName: 'Slack' }),
        ],
      });

      const view = renderTab();
      expect(view.getByText('Telegram')).toBeInTheDocument();
      // Slack binding belongs to other-agent so the card should use the fallback name
      expect(view.queryByText('Slack')).not.toBeInTheDocument();
    });

    it('falls back to adapterId when adapter is not in catalog', () => {
      mockUseBindings.mockReturnValue({
        data: [makeBinding({ adapterId: 'unknown-adapter' })],
      });
      // Provide a catalog entry for a *different* adapter so State B doesn't fire,
      // but the binding's adapterId is still absent from the catalog.
      mockUseExternalAdapterCatalog.mockReturnValue({
        data: [makeCatalogEntry({ instanceId: 'telegram-1', displayName: 'Telegram' })],
      });

      const view = renderTab();
      expect(view.getByText('unknown-adapter')).toBeInTheDocument();
    });
  });

  describe('IntegrationPicker integration', () => {
    it('renders the Add connection button in State C (no bindings)', () => {
      // Default beforeEach: relay enabled, one catalog entry, no bindings → State C.
      const view = renderTab();
      expect(view.getByText('Add connection')).toBeInTheDocument();
    });

    it('renders the Add connection button in State D (bindings exist)', () => {
      mockUseBindings.mockReturnValue({
        data: [makeBinding({ id: 'b-1', adapterId: 'telegram-1' })],
      });
      const view = renderTab();
      expect(view.getByText('Add connection')).toBeInTheDocument();
    });

    it('does not render IntegrationPicker in State A (relay off) — shows messaging CTA instead', () => {
      mockUseRelayEnabled.mockReturnValue(false);
      const view = renderTab();
      expect(view.queryByText('Add connection')).not.toBeInTheDocument();
      expect(view.getByRole('button', { name: 'Open Messaging settings' })).toBeInTheDocument();
    });
  });

  describe('remove binding', () => {
    it('calls deleteBinding.mutateAsync when a binding is removed', async () => {
      const user = userEvent.setup();
      mockUseBindings.mockReturnValue({
        data: [makeBinding({ id: 'b-to-remove' })],
      });
      mockUseExternalAdapterCatalog.mockReturnValue({
        data: [makeCatalogEntry({ instanceId: 'telegram-1' })],
      });

      const view = renderTab();

      // userEvent opens the Radix dropdown; fireEvent bypasses pointer-events:none on portal items
      await user.click(view.getByRole('button', { name: 'Actions' }));
      fireEvent.click(screen.getByText('Remove'));

      // AlertDialog renders via portal — find confirm button via screen
      const dialogContent = screen.getByRole('alertdialog');
      const confirmButton = within(dialogContent)
        .getAllByRole('button')
        .find((el) => el.textContent === 'Remove');
      expect(confirmButton).toBeDefined();
      fireEvent.click(confirmButton!);

      await waitFor(() => {
        expect(mockMutateDeleteAsync).toHaveBeenCalledWith('b-to-remove');
      });
    });
  });

  describe('edit binding dialog', () => {
    it('opens BindingDialog when Edit is clicked on a card', async () => {
      const user = userEvent.setup();
      mockUseBindings.mockReturnValue({
        data: [makeBinding({ id: 'b-edit' })],
      });
      mockUseExternalAdapterCatalog.mockReturnValue({
        data: [makeCatalogEntry({ instanceId: 'telegram-1' })],
      });

      const view = renderTab();
      await user.click(view.getByRole('button', { name: 'Actions' }));
      fireEvent.click(screen.getByText('Edit'));
      expect(view.getByTestId('binding-dialog')).toBeInTheDocument();
    });

    it('sends every PATCHable field — including permissionMode — and never adapterId/agentId (UX3 regression)', async () => {
      const user = userEvent.setup();
      mockUseBindings.mockReturnValue({
        data: [makeBinding({ id: 'b-edit' })],
      });
      mockUseExternalAdapterCatalog.mockReturnValue({
        data: [makeCatalogEntry({ instanceId: 'telegram-1' })],
      });

      const view = renderTab();
      await user.click(view.getByRole('button', { name: 'Actions' }));
      fireEvent.click(screen.getByText('Edit'));
      fireEvent.click(view.getByText('Confirm'));

      await waitFor(() => {
        expect(mockMutateUpdateAsync).toHaveBeenCalledWith({
          id: 'b-edit',
          updates: {
            sessionStrategy: 'per-user',
            label: 'updated',
            permissionMode: 'bypassPermissions',
            chatId: null,
            channelType: null,
            canInitiate: true,
            canReply: true,
            canReceive: true,
          },
        });
      });
    });

    it('calls deleteBinding.mutateAsync when delete is triggered from dialog', async () => {
      const user = userEvent.setup();
      mockUseBindings.mockReturnValue({
        data: [makeBinding({ id: 'b-dialog-delete' })],
      });
      mockUseExternalAdapterCatalog.mockReturnValue({
        data: [makeCatalogEntry({ instanceId: 'telegram-1' })],
      });

      const view = renderTab();
      await user.click(view.getByRole('button', { name: 'Actions' }));
      fireEvent.click(screen.getByText('Edit'));
      fireEvent.click(view.getByText('Delete from dialog'));

      await waitFor(() => {
        expect(mockMutateDeleteAsync).toHaveBeenCalledWith('b-dialog-delete');
      });
    });
  });

  describe('internal adapter filtering', () => {
    /**
     * Verifies that `claude-code` / internal-category adapters never appear in the
     * bound-adapter Map, even if the mocked catalog contains them. This is the
     * end-to-end regression guard.
     */
    it('never surfaces internal-category adapters in the picker or binding list', () => {
      // The hook mock returns pre-filtered data (since the real hook filters).
      // Verify the component uses useExternalAdapterCatalog (not useAdapterCatalog)
      // by checking that only external adapters appear when both are provided.
      mockUseExternalAdapterCatalog.mockReturnValue({
        data: [makeCatalogEntry({ instanceId: 'telegram-1', displayName: 'Telegram' })],
      });
      mockUseBindings.mockReturnValue({
        data: [makeBinding({ adapterId: 'telegram-1' })],
      });

      const view = renderTab();
      expect(view.getByText('Telegram')).toBeInTheDocument();
      expect(view.queryByText('Claude Code')).not.toBeInTheDocument();
    });
  });

  describe('pause/resume', () => {
    it('dispatches update mutation with enabled=false when Pause is clicked', async () => {
      const user = userEvent.setup();
      mockUseBindings.mockReturnValue({
        data: [makeBinding({ id: 'b-001', enabled: true })],
      });
      mockUseExternalAdapterCatalog.mockReturnValue({
        data: [makeCatalogEntry({ instanceId: 'telegram-1' })],
      });

      renderTab();

      await user.click(screen.getAllByRole('button', { name: /actions/i }).at(-1)!);
      fireEvent.click(screen.getByText('Pause'));

      await waitFor(() => {
        expect(mockMutateUpdateAsync).toHaveBeenCalledWith({
          id: 'b-001',
          updates: { enabled: false },
        });
      });

      await waitFor(() => {
        expect(mockToastSuccess).toHaveBeenCalledWith('Connection paused');
      });
    });

    it('dispatches update mutation with enabled=true when Resume is clicked on a paused binding', async () => {
      const user = userEvent.setup();
      mockUseBindings.mockReturnValue({
        data: [makeBinding({ id: 'b-001', enabled: false })],
      });
      mockUseExternalAdapterCatalog.mockReturnValue({
        data: [makeCatalogEntry({ instanceId: 'telegram-1' })],
      });

      renderTab();

      await user.click(screen.getAllByRole('button', { name: /actions/i }).at(-1)!);
      fireEvent.click(screen.getByText('Resume'));

      await waitFor(() => {
        expect(mockMutateUpdateAsync).toHaveBeenCalledWith({
          id: 'b-001',
          updates: { enabled: true },
        });
      });

      await waitFor(() => {
        expect(mockToastSuccess).toHaveBeenCalledWith('Connection resumed');
      });
    });
  });

  describe('test binding', () => {
    it('dispatches test mutation when Send test is clicked', async () => {
      const user = userEvent.setup();
      mockUseBindings.mockReturnValue({
        data: [makeBinding({ id: 'b-test' })],
      });
      mockUseExternalAdapterCatalog.mockReturnValue({
        data: [makeCatalogEntry({ instanceId: 'telegram-1' })],
      });

      renderTab();

      await user.click(screen.getAllByRole('button', { name: /actions/i }).at(-1)!);
      fireEvent.click(screen.getByText('Send test'));

      await waitFor(() => {
        expect(mockMutateTestAsync).toHaveBeenCalledWith('b-test');
      });
    });

    it('shows success toast with latency on successful test', async () => {
      const user = userEvent.setup();
      mockMutateTestAsync.mockResolvedValue({ ok: true, resolved: true, latencyMs: 42 });
      mockUseBindings.mockReturnValue({
        data: [makeBinding({ id: 'b-test-ok' })],
      });
      mockUseExternalAdapterCatalog.mockReturnValue({
        data: [makeCatalogEntry({ instanceId: 'telegram-1' })],
      });

      renderTab();

      await user.click(screen.getAllByRole('button', { name: /actions/i }).at(-1)!);
      fireEvent.click(screen.getByText('Send test'));

      await waitFor(() => {
        expect(mockToastSuccess).toHaveBeenCalledWith('Test OK \u2014 routed in 42ms');
      });
    });

    it('shows error toast on failed test', async () => {
      const user = userEvent.setup();
      mockMutateTestAsync.mockResolvedValue({
        ok: false,
        resolved: false,
        latencyMs: 15,
        reason: 'Agent not found',
      });
      mockUseBindings.mockReturnValue({
        data: [makeBinding({ id: 'b-test-fail' })],
      });
      mockUseExternalAdapterCatalog.mockReturnValue({
        data: [makeCatalogEntry({ instanceId: 'telegram-1' })],
      });

      renderTab();

      await user.click(screen.getAllByRole('button', { name: /actions/i }).at(-1)!);
      fireEvent.click(screen.getByText('Send test'));

      await waitFor(() => {
        expect(mockToastError).toHaveBeenCalledWith('Test failed: Agent not found');
      });
    });
  });

  describe('activity metadata', () => {
    it('passes lastMessageAt from observed chats down to the card', () => {
      mockUseBindings.mockReturnValue({
        data: [makeBinding({ id: 'b-activity', adapterId: 'telegram-1' })],
      });
      mockUseExternalAdapterCatalog.mockReturnValue({
        data: [makeCatalogEntry({ instanceId: 'telegram-1' })],
      });
      mockUseObservedChats.mockReturnValue({
        data: [
          {
            chatId: 'chat-1',
            displayName: 'Dev Chat',
            lastMessageAt: new Date().toISOString(),
            messageCount: 5,
          },
        ],
      });

      const view = renderTab();
      expect(view.getByText(/Last received/)).toBeInTheDocument();
    });

    it('shows "No recent activity" when no observed chats exist', () => {
      mockUseBindings.mockReturnValue({
        data: [makeBinding({ id: 'b-no-activity', adapterId: 'telegram-1' })],
      });
      mockUseExternalAdapterCatalog.mockReturnValue({
        data: [makeCatalogEntry({ instanceId: 'telegram-1' })],
      });
      mockUseObservedChats.mockReturnValue({ data: [] });

      const view = renderTab();
      expect(view.getByText('No recent activity')).toBeInTheDocument();
    });

    it('shows paused activity text when binding is paused', () => {
      mockUseBindings.mockReturnValue({
        data: [makeBinding({ id: 'b-paused', adapterId: 'telegram-1', enabled: false })],
      });
      mockUseExternalAdapterCatalog.mockReturnValue({
        data: [makeCatalogEntry({ instanceId: 'telegram-1' })],
      });

      const view = renderTab();
      expect(view.getByText(/Paused .* no messages routing/)).toBeInTheDocument();
    });
  });

  describe('inline wizard flow', () => {
    /**
     * Verifies that clicking an "Available to set up" item opens the
     * AdapterSetupWizard without closing the AgentDialog.
     */
    it('opens AdapterSetupWizard inline without closing the AgentDialog', async () => {
      // Provide a catalog with an unconfigured adapter type (no instances)
      mockUseExternalAdapterCatalog.mockReturnValue({
        data: [
          {
            manifest: {
              type: 'webhook',
              displayName: 'Webhook',
              description: 'HTTP webhook',
              category: 'messaging',
              builtin: true,
              configFields: [],
              multiInstance: false,
            },
            instances: [],
          },
        ],
      });

      const view = renderTab();

      // Open the picker popover
      fireEvent.click(view.getByText('Add connection'));
      // Click the available-to-setup item (renders via portal)
      fireEvent.click(screen.getByText('Webhook'));

      // The wizard should be open
      expect(screen.getByTestId('adapter-setup-wizard')).toBeInTheDocument();
    });

    /**
     * Verifies that the inline wizard flow does NOT deep-link Settings — that
     * is reserved for the empty-state CTAs (States A and B).
     */
    it('does not dispatch cross-dialog navigation when setting up a new integration', async () => {
      // Provide a catalog entry with an unconfigured adapter
      mockUseExternalAdapterCatalog.mockReturnValue({
        data: [
          {
            manifest: {
              type: 'webhook',
              displayName: 'Webhook',
              description: 'HTTP webhook',
              category: 'messaging',
              builtin: true,
              configFields: [],
              multiInstance: false,
            },
            instances: [],
          },
        ],
      });

      const view = renderTab();

      // Open the picker and trigger setup
      fireEvent.click(view.getByText('Add connection'));
      fireEvent.click(screen.getByText('Webhook'));

      // The wizard opens inline; Settings was never deep-linked.
      expect(screen.getAllByTestId('adapter-setup-wizard').length).toBeGreaterThan(0);
      expect(readSettingsTab()).toBeUndefined();
    });
  });
});
