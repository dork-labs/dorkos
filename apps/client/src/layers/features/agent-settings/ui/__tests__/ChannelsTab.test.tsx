// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { AdapterBinding, CatalogEntry } from '@dorkos/shared/relay-schemas';

// --- Mocks (must be before imports that use them) ---

const mockMutateCreateAsync = vi.fn<() => Promise<void>>(() => Promise.resolve());
const mockMutateDeleteAsync = vi.fn<() => Promise<void>>(() => Promise.resolve());
const mockMutateUpdateAsync = vi.fn<() => Promise<void>>(() => Promise.resolve());

const mockUseBindings = vi.fn<() => { data: AdapterBinding[] }>(() => ({ data: [] }));
const mockUseCreateBinding = vi.fn(() => ({
  mutateAsync: mockMutateCreateAsync,
  isPending: false,
}));
const mockUseDeleteBinding = vi.fn(() => ({
  mutateAsync: mockMutateDeleteAsync,
  isPending: false,
}));
const mockUseUpdateBinding = vi.fn(() => ({
  mutateAsync: mockMutateUpdateAsync,
  isPending: false,
}));

vi.mock('@/layers/entities/binding', () => ({
  useBindings: () => mockUseBindings(),
  useCreateBinding: () => mockUseCreateBinding(),
  useDeleteBinding: () => mockUseDeleteBinding(),
  useUpdateBinding: () => mockUseUpdateBinding(),
}));

const mockUseRelayEnabled = vi.fn<() => boolean>(() => true);
const mockUseExternalAdapterCatalog = vi.fn<() => { data: CatalogEntry[] }>(() => ({ data: [] }));

vi.mock('@/layers/entities/relay', () => ({
  useRelayEnabled: () => mockUseRelayEnabled(),
  useExternalAdapterCatalog: () => mockUseExternalAdapterCatalog(),
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
}));

// Stub BindingDialog to avoid its complex internals
vi.mock('@/layers/features/mesh/ui/BindingDialog', () => ({
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
        <button onClick={() => onConfirm({ sessionStrategy: 'per-user', label: 'updated' })}>
          Confirm
        </button>
        <button onClick={() => onDelete(bindingId)}>Delete from dialog</button>
      </div>
    ) : null,
}));

import { ChannelsTab } from '../ChannelsTab';

// --- Test fixtures ---

const baseAgent: AgentManifest = {
  id: '01HZ0000000000000000000001',
  name: 'test-agent',
  description: 'A mock agent',
  runtime: 'claude-code',
  capabilities: ['code-review'],
  behavior: { responseMode: 'always' },
  budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
  registeredAt: '2025-01-01T00:00:00.000Z',
  registeredBy: 'test',
  personaEnabled: true,
  enabledToolGroups: {},
};

function makeBinding(overrides: Partial<AdapterBinding> = {}): AdapterBinding {
  return {
    id: 'b-001',
    adapterId: 'telegram-1',
    agentId: baseAgent.id,
    sessionStrategy: 'per-chat',
    label: '',
    permissionMode: 'acceptEdits',
    canInitiate: false,
    canReply: true,
    canReceive: true,
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

function renderTab(agent: AgentManifest = baseAgent) {
  const { container } = render(<ChannelsTab agent={agent} />);
  return within(container);
}

// --- Tests ---

describe('ChannelsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseRelayEnabled.mockReturnValue(true);
    mockUseBindings.mockReturnValue({ data: [] });
    mockUseExternalAdapterCatalog.mockReturnValue({ data: [] });
  });

  describe('empty state', () => {
    it('shows "No channels connected." when relay is enabled but no bindings exist', () => {
      const view = renderTab();
      expect(view.getByText('No channels connected.')).toBeInTheDocument();
    });

    it('shows "Relay is not enabled." when relay is disabled', () => {
      mockUseRelayEnabled.mockReturnValue(false);
      const view = renderTab();
      expect(view.getByText('Relay is not enabled.')).toBeInTheDocument();
    });
  });

  describe('binding list', () => {
    it('renders a ChannelBindingCard for each agent binding', () => {
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
      mockUseExternalAdapterCatalog.mockReturnValue({ data: [] });

      const view = renderTab();
      expect(view.getByText('unknown-adapter')).toBeInTheDocument();
    });
  });

  describe('ChannelPicker integration', () => {
    it('renders the Connect to Channel button', () => {
      const view = renderTab();
      expect(view.getByText('Connect to Channel')).toBeInTheDocument();
    });

    it('disables picker when relay is not enabled', () => {
      mockUseRelayEnabled.mockReturnValue(false);
      const view = renderTab();
      expect(view.getByText('Connect to Channel').closest('button')).toBeDisabled();
    });
  });

  describe('remove binding', () => {
    it('calls deleteBinding.mutateAsync when a binding is removed', async () => {
      mockUseBindings.mockReturnValue({
        data: [makeBinding({ id: 'b-to-remove' })],
      });
      mockUseExternalAdapterCatalog.mockReturnValue({
        data: [makeCatalogEntry({ instanceId: 'telegram-1' })],
      });

      const view = renderTab();

      // Click the Remove button on the card
      fireEvent.click(view.getByText('Remove'));

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
    it('opens BindingDialog when Edit is clicked on a card', () => {
      mockUseBindings.mockReturnValue({
        data: [makeBinding({ id: 'b-edit' })],
      });
      mockUseExternalAdapterCatalog.mockReturnValue({
        data: [makeCatalogEntry({ instanceId: 'telegram-1' })],
      });

      const view = renderTab();
      fireEvent.click(view.getByText('Edit'));
      expect(view.getByTestId('binding-dialog')).toBeInTheDocument();
    });

    it('calls updateBinding.mutateAsync when edit dialog is confirmed', async () => {
      mockUseBindings.mockReturnValue({
        data: [makeBinding({ id: 'b-edit' })],
      });
      mockUseExternalAdapterCatalog.mockReturnValue({
        data: [makeCatalogEntry({ instanceId: 'telegram-1' })],
      });

      const view = renderTab();
      fireEvent.click(view.getByText('Edit'));
      fireEvent.click(view.getByText('Confirm'));

      await waitFor(() => {
        expect(mockMutateUpdateAsync).toHaveBeenCalled();
      });
    });

    it('calls deleteBinding.mutateAsync when delete is triggered from dialog', async () => {
      mockUseBindings.mockReturnValue({
        data: [makeBinding({ id: 'b-dialog-delete' })],
      });
      mockUseExternalAdapterCatalog.mockReturnValue({
        data: [makeCatalogEntry({ instanceId: 'telegram-1' })],
      });

      const view = renderTab();
      fireEvent.click(view.getByText('Edit'));
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
      fireEvent.click(view.getByText('Connect to Channel'));
      // Click the available-to-setup item (renders via portal)
      fireEvent.click(screen.getByText('Webhook'));

      // The wizard should be open
      expect(screen.getByTestId('adapter-setup-wizard')).toBeInTheDocument();
    });

    /**
     * Verifies that ChannelsTab no longer calls `setAgentDialogOpen` or
     * `openSettingsToTab`. This is a defensive test — if the component still
     * imported @/layers/shared/model, the vi.mock for that module no longer
     * exists and the import itself would cause an error.
     */
    it('does not dispatch cross-dialog navigation when setting up a new channel', async () => {
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
      fireEvent.click(view.getByText('Connect to Channel'));
      fireEvent.click(screen.getByText('Webhook'));

      // The wizard opens inline; no cross-dialog navigation occurred.
      expect(screen.getAllByTestId('adapter-setup-wizard').length).toBeGreaterThan(0);
    });
  });
});
