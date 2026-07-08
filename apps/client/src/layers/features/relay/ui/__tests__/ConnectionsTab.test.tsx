// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { AdapterBinding, CatalogEntry } from '@dorkos/shared/relay-schemas';

// --- Mocks (must be before imports that use them) ---

const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
    error: (...args: unknown[]) => mockToastError(...args),
  },
}));

const mockCreateAsync = vi.fn<() => Promise<void>>(() => Promise.resolve());
const mockUpdateAsync = vi.fn<() => Promise<void>>(() => Promise.resolve());
const mockDeleteAsync = vi.fn<() => Promise<void>>(() => Promise.resolve());

// Mock the dialog component but keep the real payload mappings — the
// regressions assert exactly what reaches the mutations.
let capturedBindingDialogProps: Record<string, unknown> = {};
vi.mock('@/layers/entities/binding', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/binding')>();
  return {
    ...actual,
    useCreateBinding: () => ({ mutateAsync: mockCreateAsync, isPending: false }),
    useUpdateBinding: () => ({ mutateAsync: mockUpdateAsync, isPending: false }),
    useDeleteBinding: () => ({ mutateAsync: mockDeleteAsync, isPending: false }),
    BindingDialog: (props: {
      open: boolean;
      mode?: string;
      agentName?: string;
      onConfirm: (values: Record<string, unknown>) => void;
    }) => {
      capturedBindingDialogProps = props;
      return props.open ? (
        <div data-testid="binding-dialog" data-mode={props.mode}>
          <button
            data-testid="dialog-confirm"
            onClick={() =>
              props.onConfirm({
                adapterId: 'telegram-1',
                agentId: 'agent-1',
                sessionStrategy: 'per-user',
                label: 'Support line',
                permissionMode: 'bypassPermissions',
                chatId: 'chat-9',
                channelType: 'group',
                canInitiate: true,
                canReply: true,
                canReceive: true,
              })
            }
          >
            Confirm
          </button>
        </div>
      ) : null;
    },
  };
});

const mockUseAdapterCatalog = vi.fn<() => { data: CatalogEntry[]; isLoading: boolean }>(() => ({
  data: [],
  isLoading: false,
}));

vi.mock('@/layers/entities/relay', () => ({
  useAdapterCatalog: () => mockUseAdapterCatalog(),
  useToggleAdapter: () => ({ mutate: vi.fn() }),
  useRemoveAdapter: () => ({ mutate: vi.fn() }),
}));

vi.mock('@/layers/entities/mesh', () => ({
  useRegisteredAgents: () => ({
    data: {
      agents: [{ id: 'agent-1', name: 'builder', displayName: 'Builder' }],
    },
  }),
}));

const fixtureBinding: AdapterBinding = {
  id: 'b-1',
  adapterId: 'telegram-1',
  agentId: 'agent-1',
  sessionStrategy: 'per-chat',
  label: '',
  permissionMode: 'acceptEdits',
  enabled: true,
  canInitiate: false,
  canReply: true,
  canReceive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

// AdapterCard stub exposing the two binding entry points under test.
vi.mock('../adapter/AdapterCard', () => ({
  AdapterCard: ({
    instance,
    onAddBinding,
    onEditBinding,
  }: {
    instance: { id: string };
    onAddBinding: (instanceId: string) => void;
    onEditBinding: (binding: AdapterBinding) => void;
  }) => (
    <div data-testid={`adapter-card-${instance.id}`}>
      <button onClick={() => onAddBinding(instance.id)}>Add Binding</button>
      <button onClick={() => onEditBinding(fixtureBinding)}>Edit Binding</button>
    </div>
  ),
}));

vi.mock('../AdapterEventLog', () => ({ AdapterEventLog: () => null }));
vi.mock('../CatalogCard', () => ({ CatalogCard: () => null }));
vi.mock('../AdapterSetupWizard', () => ({ AdapterSetupWizard: () => null }));

import { ConnectionsTab } from '../ConnectionsTab';

// --- Fixtures ---

function makeCatalog(): CatalogEntry[] {
  return [
    {
      manifest: {
        type: 'telegram',
        displayName: 'Telegram',
        description: 'Test adapter',
        category: 'messaging',
        builtin: true,
        configFields: [],
        multiInstance: false,
      },
      instances: [
        {
          id: 'telegram-1',
          enabled: true,
          status: {
            id: 'telegram-1',
            type: 'telegram',
            displayName: 'Telegram',
            state: 'connected',
            messageCount: { inbound: 0, outbound: 0 },
            errorCount: 0,
          },
        },
      ],
    },
  ];
}

function renderTab() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return render(<ConnectionsTab enabled />, { wrapper: Wrapper });
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedBindingDialogProps = {};
  mockUseAdapterCatalog.mockReturnValue({ data: makeCatalog(), isLoading: false });
});

afterEach(cleanup);

// --- Tests ---

describe('ConnectionsTab binding dialog', () => {
  describe('create flow (UX1 regression)', () => {
    it('opens the dialog in create mode pre-filled with the source adapter', () => {
      renderTab();
      fireEvent.click(screen.getByText('Add Binding'));

      expect(screen.getByTestId('binding-dialog')).toBeInTheDocument();
      expect(capturedBindingDialogProps.mode).toBe('create');
      expect(capturedBindingDialogProps.initialValues).toEqual({ adapterId: 'telegram-1' });
    });

    it('creates a binding with the full form values on confirm', async () => {
      renderTab();
      fireEvent.click(screen.getByText('Add Binding'));
      fireEvent.click(screen.getByTestId('dialog-confirm'));

      await waitFor(() => {
        expect(mockCreateAsync).toHaveBeenCalledWith({
          adapterId: 'telegram-1',
          agentId: 'agent-1',
          sessionStrategy: 'per-user',
          label: 'Support line',
          permissionMode: 'bypassPermissions',
          chatId: 'chat-9',
          channelType: 'group',
          canInitiate: true,
          canReply: true,
          canReceive: true,
        });
      });
      expect(mockToastSuccess).toHaveBeenCalledWith('Channel connected');
      expect(mockToastError).not.toHaveBeenCalled();
      // Dialog closes after a successful create.
      await waitFor(() => {
        expect(screen.queryByTestId('binding-dialog')).not.toBeInTheDocument();
      });
    });
  });

  describe('edit flow', () => {
    it('passes the agent display name so the title is not dangling', () => {
      renderTab();
      fireEvent.click(screen.getByText('Edit Binding'));

      expect(capturedBindingDialogProps.mode).toBe('edit');
      expect(capturedBindingDialogProps.agentName).toBe('Builder');
    });

    it('sends only PATCHable fields — including permissionMode — on confirm (UX3 regression)', async () => {
      renderTab();
      fireEvent.click(screen.getByText('Edit Binding'));
      fireEvent.click(screen.getByTestId('dialog-confirm'));

      await waitFor(() => {
        expect(mockUpdateAsync).toHaveBeenCalledWith({
          id: 'b-1',
          updates: {
            sessionStrategy: 'per-user',
            label: 'Support line',
            permissionMode: 'bypassPermissions',
            chatId: 'chat-9',
            channelType: 'group',
            canInitiate: true,
            canReply: true,
            canReceive: true,
          },
        });
      });
      expect(mockToastSuccess).toHaveBeenCalledWith('Channel updated');
    });
  });
});
