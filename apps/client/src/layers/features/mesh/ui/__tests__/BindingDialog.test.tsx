/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import type { CatalogEntry, ObservedChat } from '@dorkos/shared/relay-schemas';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { BindingDialog } from '../BindingDialog';

// ---------------------------------------------------------------------------
// Mock entity hooks — avoids real transport/query wiring in unit tests
// ---------------------------------------------------------------------------

const mockUseAdapterCatalog = vi.fn();
const mockUseObservedChats = vi.fn();
const mockUseRegisteredAgents = vi.fn();

vi.mock('@/layers/entities/relay', () => ({
  useAdapterCatalog: (...args: unknown[]) => mockUseAdapterCatalog(...args),
  useObservedChats: (...args: unknown[]) => mockUseObservedChats(...args),
}));

vi.mock('@/layers/entities/mesh', () => ({
  useRegisteredAgents: (...args: unknown[]) => mockUseRegisteredAgents(...args),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_CATALOG: CatalogEntry[] = [
  {
    manifest: {
      type: 'telegram',
      displayName: 'Telegram',
      description: 'Telegram bot',
      category: 'messaging',
      builtin: true,
      configFields: [],
      multiInstance: true,
    },
    instances: [
      {
        id: 'telegram-1',
        enabled: true,
        label: 'Support Bot',
        status: {
          id: 'telegram-1',
          type: 'telegram' as const,
          displayName: 'Telegram',
          state: 'connected' as const,
          messageCount: { inbound: 0, outbound: 0 },
          errorCount: 0,
        },
      },
    ],
  },
];

const MOCK_AGENTS: AgentManifest[] = [
  {
    id: 'agent-1',
    name: 'Support Agent',
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
    registeredAt: new Date().toISOString(),
    registeredBy: 'test',
    enabledToolGroups: {},
    personaEnabled: true,
  },
];

const MOCK_OBSERVED_CHATS: ObservedChat[] = [
  {
    chatId: '111',
    displayName: 'Alice',
    channelType: 'dm',
    lastMessageAt: new Date().toISOString(),
    messageCount: 3,
  },
];

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function Wrapper({ children }: { children: React.ReactNode }) {
  const transport = createMockTransport();
  return (
    <QueryClientProvider client={makeQueryClient()}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

// Mock matchMedia for Radix/responsive-dialog internals
beforeEach(() => {
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

  // Default hook returns
  mockUseAdapterCatalog.mockReturnValue({ data: MOCK_CATALOG });
  mockUseRegisteredAgents.mockReturnValue({ data: { agents: MOCK_AGENTS } });
  mockUseObservedChats.mockReturnValue({ data: [] });

  vi.clearAllMocks();

  // Re-apply defaults after clearAllMocks
  mockUseAdapterCatalog.mockReturnValue({ data: MOCK_CATALOG });
  mockUseRegisteredAgents.mockReturnValue({ data: { agents: MOCK_AGENTS } });
  mockUseObservedChats.mockReturnValue({ data: [] });
});

afterEach(cleanup);

/** Get the rendered dialog element (Radix renders content in a portal). */
function getDialog() {
  return screen.getByRole('dialog');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BindingDialog', () => {
  const defaultCreateProps = {
    open: true,
    onOpenChange: vi.fn(),
    onConfirm: vi.fn(),
    mode: 'create' as const,
  };

  const defaultEditProps = {
    open: true,
    onOpenChange: vi.fn(),
    onConfirm: vi.fn(),
    mode: 'edit' as const,
    adapterName: 'Telegram Bot',
    agentName: 'Support Agent',
    initialValues: {
      adapterId: 'telegram-1',
      agentId: 'agent-1',
      sessionStrategy: 'per-chat' as const,
      label: 'My binding',
    },
  };

  describe('create mode', () => {
    it('renders "Create Binding" title', () => {
      render(<BindingDialog {...defaultCreateProps} />, { wrapper: Wrapper });
      expect(screen.getByRole('heading', { name: 'Create Binding' })).toBeInTheDocument();
    });

    it('renders adapter picker dropdown', () => {
      render(<BindingDialog {...defaultCreateProps} />, { wrapper: Wrapper });
      expect(screen.getByLabelText('Adapter')).toBeInTheDocument();
    });

    it('renders agent picker dropdown', () => {
      render(<BindingDialog {...defaultCreateProps} />, { wrapper: Wrapper });
      expect(screen.getByLabelText('Agent')).toBeInTheDocument();
    });

    it('renders session strategy selector inside Advanced section', () => {
      render(<BindingDialog {...defaultCreateProps} />, { wrapper: Wrapper });
      // Session strategy lives inside the collapsible Advanced section — open it first.
      fireEvent.click(screen.getByText('Advanced'));
      expect(screen.getByText('Session Strategy')).toBeInTheDocument();
    });

    it('renders label input with placeholder', () => {
      render(<BindingDialog {...defaultCreateProps} />, { wrapper: Wrapper });
      expect(screen.getByPlaceholderText('e.g., Customer support bot')).toBeInTheDocument();
    });

    it('renders "Create Binding" and "Cancel" buttons', () => {
      render(<BindingDialog {...defaultCreateProps} />, { wrapper: Wrapper });
      const dialog = getDialog();
      expect(within(dialog).getByRole('button', { name: /create binding/i })).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    });

    it('shows the per-chat strategy description when Advanced section is open', () => {
      render(<BindingDialog {...defaultCreateProps} />, { wrapper: Wrapper });
      // Description is visible only when the Advanced section is expanded.
      fireEvent.click(screen.getByText('Advanced'));
      expect(screen.getByText(/one session per chat\/conversation/i)).toBeInTheDocument();
    });

    it('calls onConfirm with correct values on submit', () => {
      const onConfirm = vi.fn();
      render(<BindingDialog {...defaultCreateProps} onConfirm={onConfirm} />, { wrapper: Wrapper });
      const labelInput = screen.getByPlaceholderText('e.g., Customer support bot');
      fireEvent.change(labelInput, { target: { value: 'Customer support' } });
      fireEvent.click(screen.getByRole('button', { name: /create binding/i }));
      expect(onConfirm).toHaveBeenCalledWith(
        expect.objectContaining({ sessionStrategy: 'per-chat', label: 'Customer support' })
      );
    });

    it('calls onConfirm with undefined chatId when chat filter is blank', () => {
      const onConfirm = vi.fn();
      render(<BindingDialog {...defaultCreateProps} onConfirm={onConfirm} />, { wrapper: Wrapper });
      fireEvent.click(screen.getByRole('button', { name: /create binding/i }));
      const call = onConfirm.mock.calls[0][0];
      expect(call.chatId).toBeUndefined();
      expect(call.channelType).toBeUndefined();
    });
  });

  describe('edit mode', () => {
    it('renders "Edit Binding" title', () => {
      render(<BindingDialog {...defaultEditProps} />, { wrapper: Wrapper });
      expect(screen.getByRole('heading', { name: 'Edit Binding' })).toBeInTheDocument();
    });

    it('renders "Save Changes" button', () => {
      render(<BindingDialog {...defaultEditProps} />, { wrapper: Wrapper });
      expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    });

    it('renders read-only adapter and agent names', () => {
      render(<BindingDialog {...defaultEditProps} />, { wrapper: Wrapper });
      const dialog = getDialog();
      expect(within(dialog).getByText('Telegram Bot')).toBeInTheDocument();
      expect(within(dialog).getByText('Support Agent')).toBeInTheDocument();
    });

    it('does not render adapter/agent picker dropdowns in edit mode', () => {
      render(<BindingDialog {...defaultEditProps} />, { wrapper: Wrapper });
      expect(screen.queryByLabelText('Adapter')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Agent')).not.toBeInTheDocument();
    });

    it('pre-fills label from initialValues', () => {
      render(<BindingDialog {...defaultEditProps} />, { wrapper: Wrapper });
      const labelInput = screen.getByPlaceholderText('e.g., Customer support bot');
      expect(labelInput).toHaveValue('My binding');
    });

    it('calls onConfirm with updated values on save', () => {
      const onConfirm = vi.fn();
      render(<BindingDialog {...defaultEditProps} onConfirm={onConfirm} />, { wrapper: Wrapper });
      const labelInput = screen.getByPlaceholderText('e.g., Customer support bot');
      fireEvent.change(labelInput, { target: { value: 'Updated label' } });
      fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
      expect(onConfirm).toHaveBeenCalledWith(
        expect.objectContaining({
          label: 'Updated label',
          sessionStrategy: 'per-chat',
        })
      );
    });
  });

  describe('chat filter section', () => {
    it('renders the "Chat Filter" collapsible trigger', () => {
      render(<BindingDialog {...defaultCreateProps} />, { wrapper: Wrapper });
      expect(screen.getByText('Chat Filter')).toBeInTheDocument();
    });

    it('does not show "Active" badge when no filters set', () => {
      render(<BindingDialog {...defaultCreateProps} />, { wrapper: Wrapper });
      expect(screen.queryByText('Active')).not.toBeInTheDocument();
    });

    it('opens chat filter section on trigger click', () => {
      render(<BindingDialog {...defaultCreateProps} />, { wrapper: Wrapper });
      const trigger = screen.getByText('Chat Filter');
      fireEvent.click(trigger);
      expect(screen.getByLabelText('Chat ID')).toBeInTheDocument();
      expect(screen.getByLabelText('Channel Type')).toBeInTheDocument();
    });

    it('shows "Active" badge when initialValues has chatId', () => {
      render(<BindingDialog {...defaultCreateProps} initialValues={{ chatId: '111' }} />, {
        wrapper: Wrapper,
      });
      expect(screen.getByText('Active')).toBeInTheDocument();
    });

    it('calls useObservedChats with the selected adapterId', () => {
      mockUseObservedChats.mockReturnValue({ data: MOCK_OBSERVED_CHATS });
      render(
        <BindingDialog {...defaultCreateProps} initialValues={{ adapterId: 'telegram-1' }} />,
        { wrapper: Wrapper }
      );
      // Hook should have been called with the adapter ID from initialValues
      expect(mockUseObservedChats).toHaveBeenCalledWith('telegram-1');
    });

    it('passes chatId in onConfirm when filter is set via initialValues', () => {
      const onConfirm = vi.fn();
      render(
        <BindingDialog
          {...defaultCreateProps}
          onConfirm={onConfirm}
          initialValues={{ chatId: '999' }}
        />,
        { wrapper: Wrapper }
      );
      fireEvent.click(screen.getByRole('button', { name: /create binding/i }));
      expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ chatId: '999' }));
    });

    it('"Clear filters" button resets chatId and channelType', () => {
      const onConfirm = vi.fn();
      render(
        <BindingDialog
          {...defaultCreateProps}
          onConfirm={onConfirm}
          initialValues={{ chatId: '111', channelType: 'dm' }}
        />,
        { wrapper: Wrapper }
      );
      const clearBtn = screen.getByRole('button', { name: /clear filters/i });
      fireEvent.click(clearBtn);
      fireEvent.click(screen.getByRole('button', { name: /create binding/i }));
      const call = onConfirm.mock.calls[0][0];
      expect(call.chatId).toBeUndefined();
      expect(call.channelType).toBeUndefined();
    });
  });

  describe('cancel action', () => {
    it('calls onOpenChange(false) when Cancel is clicked', () => {
      const onOpenChange = vi.fn();
      render(<BindingDialog {...defaultCreateProps} onOpenChange={onOpenChange} />, {
        wrapper: Wrapper,
      });
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  describe('pre-fill behavior', () => {
    it('pre-fills all fields when initialValues provided', () => {
      const onConfirm = vi.fn();
      render(
        <BindingDialog
          {...defaultCreateProps}
          onConfirm={onConfirm}
          initialValues={{
            adapterId: 'telegram-1',
            agentId: 'agent-1',
            sessionStrategy: 'stateless',
            label: 'Pre-filled',
          }}
        />,
        { wrapper: Wrapper }
      );
      fireEvent.click(screen.getByRole('button', { name: /create binding/i }));
      expect(onConfirm).toHaveBeenCalledWith(
        expect.objectContaining({
          adapterId: 'telegram-1',
          agentId: 'agent-1',
          sessionStrategy: 'stateless',
          label: 'Pre-filled',
        })
      );
    });
  });
});
