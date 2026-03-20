/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';

// ---------------------------------------------------------------------------
// Mock motion/react to avoid animation issues in jsdom
// ---------------------------------------------------------------------------

vi.mock('motion/react', () => ({
  motion: {
    div: ({ children, ...props }: React.ComponentProps<'div'>) => <div {...props}>{children}</div>,
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// ---------------------------------------------------------------------------
// Mock entity hooks
// ---------------------------------------------------------------------------

const mockUseRegisteredAgents = vi.fn();
const mockMutate = vi.fn();
const mockUseCreateBinding = vi.fn();

vi.mock('@/layers/entities/mesh', () => ({
  useRegisteredAgents: (...args: unknown[]) => mockUseRegisteredAgents(...args),
}));

vi.mock('@/layers/entities/binding', () => ({
  useCreateBinding: () => mockUseCreateBinding(),
  useBindings: () => ({ data: [] }),
}));

// Mock BindingDialog to isolate ConversationRow behavior.
vi.mock('@/layers/features/mesh/ui/BindingDialog', () => ({
  BindingDialog: (props: {
    open: boolean;
    mode: string;
    initialValues?: Record<string, unknown>;
    onConfirm: (values: Record<string, unknown>) => void;
    onOpenChange: (open: boolean) => void;
  }) => {
    if (!props.open) return null;
    return (
      <div
        data-testid="binding-dialog"
        data-mode={props.mode}
        data-adapter-id={props.initialValues?.adapterId}
        data-chat-id={props.initialValues?.chatId}
      >
        <button
          onClick={() =>
            props.onConfirm({
              adapterId: 'adapter-1',
              agentId: 'agent-1',
              sessionStrategy: 'per-chat',
              label: '',
            })
          }
        >
          Confirm
        </button>
        <button onClick={() => props.onOpenChange(false)}>Close</button>
      </div>
    );
  },
}));

import { ConversationRow } from '../ConversationRow';
import type { RelayConversation } from '@dorkos/shared/relay-schemas';

// ---------------------------------------------------------------------------
// Browser API mocks
// ---------------------------------------------------------------------------

beforeAll(() => {
  // Radix Select uses scrollIntoView internally — mock it to prevent jsdom errors.
  Element.prototype.scrollIntoView = vi.fn();

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
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockAgents = [
  {
    id: 'agent-1',
    name: 'Alpha Agent',
    description: '',
    runtime: 'claude-code' as const,
    capabilities: [],
    behavior: { responseMode: 'always' as const },
    budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
    registeredAt: '2025-01-01T00:00:00.000Z',
    registeredBy: 'test',
    personaEnabled: true,
    enabledToolGroups: {},
  },
  {
    id: 'agent-2',
    name: 'Beta Agent',
    description: '',
    runtime: 'claude-code' as const,
    capabilities: [],
    behavior: { responseMode: 'always' as const },
    budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
    registeredAt: '2025-01-01T00:00:00.000Z',
    registeredBy: 'test',
    personaEnabled: true,
    enabledToolGroups: {},
  },
];

const makeConversation = (overrides: Partial<RelayConversation> = {}): RelayConversation => ({
  id: 'conv-1',
  direction: 'inbound',
  status: 'delivered',
  from: { label: 'Telegram Bot', raw: 'relay.human.telegram.12345' },
  to: { label: 'Agent Alpha', raw: 'relay.agent.agent-1' },
  preview: 'Hello world',
  responseCount: 1,
  sentAt: new Date().toISOString(),
  subject: 'relay.agent.session-abc',
  ...overrides,
});

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const transport = createMockTransport();
  return {
    transport,
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseRegisteredAgents.mockReturnValue({ data: { agents: mockAgents } });
  mockUseCreateBinding.mockReturnValue({ mutate: mockMutate });
});

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConversationRow', () => {
  describe('basic rendering', () => {
    it('renders from and to labels', () => {
      const { wrapper } = createWrapper();
      render(<ConversationRow conversation={makeConversation()} />, { wrapper });

      expect(screen.getByText('Telegram Bot')).toBeInTheDocument();
      expect(screen.getByText('Agent Alpha')).toBeInTheDocument();
    });

    it('renders preview text', () => {
      const { wrapper } = createWrapper();
      render(<ConversationRow conversation={makeConversation({ preview: 'Hello world' })} />, {
        wrapper,
      });

      expect(screen.getByText(/"Hello world"/)).toBeInTheDocument();
    });
  });

  describe('Route button', () => {
    it('renders the Route button', () => {
      const { wrapper } = createWrapper();
      render(<ConversationRow conversation={makeConversation()} />, { wrapper });

      expect(screen.getByRole('button', { name: /route to agent/i })).toBeInTheDocument();
    });

    it('Route button contains "Route" text', () => {
      const { wrapper } = createWrapper();
      render(<ConversationRow conversation={makeConversation()} />, { wrapper });

      expect(screen.getByRole('button', { name: /route to agent/i })).toHaveTextContent('Route');
    });
  });

  describe('Route popover', () => {
    it('opens popover heading when Route button is clicked', async () => {
      const { wrapper } = createWrapper();
      render(<ConversationRow conversation={makeConversation()} />, { wrapper });

      fireEvent.click(screen.getByRole('button', { name: /route to agent/i }));

      await waitFor(() => {
        expect(screen.getByText('Route to Agent')).toBeInTheDocument();
      });
    });

    it('shows "Create Binding" button in the popover', async () => {
      const { wrapper } = createWrapper();
      render(<ConversationRow conversation={makeConversation()} />, { wrapper });

      fireEvent.click(screen.getByRole('button', { name: /route to agent/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /create binding/i })).toBeInTheDocument();
      });
    });

    it('"Create Binding" button is disabled when no agent is selected', async () => {
      const { wrapper } = createWrapper();
      render(<ConversationRow conversation={makeConversation()} />, { wrapper });

      fireEvent.click(screen.getByRole('button', { name: /route to agent/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /create binding/i })).toBeDisabled();
      });
    });

    it('shows "More options..." link in the popover', async () => {
      const { wrapper } = createWrapper();
      render(<ConversationRow conversation={makeConversation()} />, { wrapper });

      fireEvent.click(screen.getByRole('button', { name: /route to agent/i }));

      await waitFor(() => {
        expect(screen.getByText('More options...')).toBeInTheDocument();
      });
    });

    it('shows a combobox (agent selector) in the popover', async () => {
      const { wrapper } = createWrapper();
      render(<ConversationRow conversation={makeConversation()} />, { wrapper });

      fireEvent.click(screen.getByRole('button', { name: /route to agent/i }));

      await waitFor(() => {
        expect(screen.getByRole('combobox')).toBeInTheDocument();
      });
    });
  });

  describe('quick route (Create Binding)', () => {
    it('calls createBinding with correct sessionStrategy when quick-routing', async () => {
      const { wrapper } = createWrapper();
      const conversation = makeConversation({
        payload: { adapterId: 'telegram-1', chatId: 'chat-123', channelType: 'dm' },
      });
      render(<ConversationRow conversation={conversation} />, { wrapper });

      // Open popover
      fireEvent.click(screen.getByRole('button', { name: /route to agent/i }));

      await waitFor(() => {
        expect(screen.getByRole('combobox')).toBeInTheDocument();
      });

      // Select an agent via the combobox
      fireEvent.click(screen.getByRole('combobox'));

      await waitFor(() => {
        expect(screen.getByRole('option', { name: 'Alpha Agent' })).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole('option', { name: 'Alpha Agent' }));

      // Create Binding should now be enabled
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /create binding/i })).not.toBeDisabled();
      });

      fireEvent.click(screen.getByRole('button', { name: /create binding/i }));

      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent-1',
          sessionStrategy: 'per-chat',
          chatId: 'chat-123',
          channelType: 'dm',
        })
      );
    });

    it('extracts adapterId from payload', async () => {
      const { wrapper } = createWrapper();
      const conversation = makeConversation({
        payload: { adapterId: 'my-telegram-bot' },
      });
      render(<ConversationRow conversation={conversation} />, { wrapper });

      fireEvent.click(screen.getByRole('button', { name: /route to agent/i }));
      await waitFor(() => {
        expect(screen.getByRole('combobox')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('combobox'));
      await waitFor(() => {
        expect(screen.getByRole('option', { name: 'Alpha Agent' })).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole('option', { name: 'Alpha Agent' }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /create binding/i })).not.toBeDisabled();
      });

      fireEvent.click(screen.getByRole('button', { name: /create binding/i }));

      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({ adapterId: 'my-telegram-bot' })
      );
    });

    it('omits chatId and channelType when payload has none', async () => {
      const { wrapper } = createWrapper();
      // No payload — chatId and channelType should be undefined
      const conversation = makeConversation({ payload: undefined });
      render(<ConversationRow conversation={conversation} />, { wrapper });

      fireEvent.click(screen.getByRole('button', { name: /route to agent/i }));
      await waitFor(() => {
        expect(screen.getByRole('combobox')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('combobox'));
      await waitFor(() => {
        expect(screen.getByRole('option', { name: 'Alpha Agent' })).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole('option', { name: 'Alpha Agent' }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /create binding/i })).not.toBeDisabled();
      });

      fireEvent.click(screen.getByRole('button', { name: /create binding/i }));

      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: undefined,
          channelType: undefined,
        })
      );
    });
  });

  describe('"More options" advanced route', () => {
    it('opens BindingDialog in create mode when "More options..." is clicked', async () => {
      const { wrapper } = createWrapper();
      render(<ConversationRow conversation={makeConversation()} />, { wrapper });

      fireEvent.click(screen.getByRole('button', { name: /route to agent/i }));
      await waitFor(() => {
        expect(screen.getByText('More options...')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('More options...'));

      await waitFor(() => {
        expect(screen.getByTestId('binding-dialog')).toBeInTheDocument();
        expect(screen.getByTestId('binding-dialog')).toHaveAttribute('data-mode', 'create');
      });
    });

    it('pre-fills adapterId from payload in the BindingDialog', async () => {
      const { wrapper } = createWrapper();
      const conversation = makeConversation({
        payload: { adapterId: 'telegram-special', chatId: 'chat-456' },
      });
      render(<ConversationRow conversation={conversation} />, { wrapper });

      fireEvent.click(screen.getByRole('button', { name: /route to agent/i }));
      await waitFor(() => {
        expect(screen.getByText('More options...')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText('More options...'));

      await waitFor(() => {
        const dialog = screen.getByTestId('binding-dialog');
        expect(dialog).toHaveAttribute('data-adapter-id', 'telegram-special');
        expect(dialog).toHaveAttribute('data-chat-id', 'chat-456');
      });
    });

    it('closes BindingDialog and calls createBinding when confirmed', async () => {
      const { wrapper } = createWrapper();
      render(<ConversationRow conversation={makeConversation()} />, { wrapper });

      fireEvent.click(screen.getByRole('button', { name: /route to agent/i }));
      await waitFor(() => {
        expect(screen.getByText('More options...')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText('More options...'));

      await waitFor(() => {
        expect(screen.getByTestId('binding-dialog')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /confirm/i }));

      await waitFor(() => {
        expect(screen.queryByTestId('binding-dialog')).not.toBeInTheDocument();
      });

      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({ adapterId: 'adapter-1', agentId: 'agent-1' })
      );
    });

    it('closes BindingDialog when Close button is clicked without confirming', async () => {
      const { wrapper } = createWrapper();
      render(<ConversationRow conversation={makeConversation()} />, { wrapper });

      fireEvent.click(screen.getByRole('button', { name: /route to agent/i }));
      await waitFor(() => {
        expect(screen.getByText('More options...')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText('More options...'));

      await waitFor(() => {
        expect(screen.getByTestId('binding-dialog')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /close/i }));

      await waitFor(() => {
        expect(screen.queryByTestId('binding-dialog')).not.toBeInTheDocument();
      });

      expect(mockMutate).not.toHaveBeenCalled();
    });
  });

  describe('extractAdapterId inference', () => {
    it('returns adapterId from payload metadata when available', async () => {
      const { wrapper } = createWrapper();
      const conversation = makeConversation({
        payload: { adapterId: 'tg-bot-1' },
        from: { raw: 'relay.human.telegram.12345', label: 'Telegram' },
      });
      render(<ConversationRow conversation={conversation} />, { wrapper });

      // Open popover and select an agent to trigger quick route
      fireEvent.click(screen.getByRole('button', { name: /route to agent/i }));
      await waitFor(() => {
        expect(screen.getByRole('combobox')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole('combobox'));
      await waitFor(() => {
        expect(screen.getByRole('option', { name: 'Alpha Agent' })).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole('option', { name: 'Alpha Agent' }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /create binding/i })).not.toBeDisabled();
      });
      fireEvent.click(screen.getByRole('button', { name: /create binding/i }));

      expect(mockMutate).toHaveBeenCalledWith(expect.objectContaining({ adapterId: 'tg-bot-1' }));
    });

    it('infers platform from relay.human.<platform>.<chatId> subject', async () => {
      const { wrapper } = createWrapper();
      const conversation = makeConversation({
        from: { raw: 'relay.human.slack.C12345', label: 'Slack' },
      });
      render(<ConversationRow conversation={conversation} />, { wrapper });

      fireEvent.click(screen.getByRole('button', { name: /route to agent/i }));
      await waitFor(() => {
        expect(screen.getByRole('combobox')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole('combobox'));
      await waitFor(() => {
        expect(screen.getByRole('option', { name: 'Alpha Agent' })).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole('option', { name: 'Alpha Agent' }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /create binding/i })).not.toBeDisabled();
      });
      fireEvent.click(screen.getByRole('button', { name: /create binding/i }));

      expect(mockMutate).toHaveBeenCalledWith(expect.objectContaining({ adapterId: 'slack' }));
    });

    it('returns empty string for unrecognized subject patterns', async () => {
      const { wrapper } = createWrapper();
      const conversation = makeConversation({
        from: { raw: 'some.other.subject', label: 'Unknown' },
      });
      render(<ConversationRow conversation={conversation} />, { wrapper });

      fireEvent.click(screen.getByRole('button', { name: /route to agent/i }));
      await waitFor(() => {
        expect(screen.getByRole('combobox')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole('combobox'));
      await waitFor(() => {
        expect(screen.getByRole('option', { name: 'Alpha Agent' })).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole('option', { name: 'Alpha Agent' }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /create binding/i })).not.toBeDisabled();
      });
      fireEvent.click(screen.getByRole('button', { name: /create binding/i }));

      expect(mockMutate).toHaveBeenCalledWith(expect.objectContaining({ adapterId: '' }));
    });
  });

  describe('stopPropagation', () => {
    it('clicking Route button does not expand the conversation row', async () => {
      const { wrapper } = createWrapper();
      render(<ConversationRow conversation={makeConversation()} />, { wrapper });

      // Technical Details only appears when expanded
      expect(screen.queryByText('Technical Details')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /route to agent/i }));

      // Row should still not be expanded — the Route button stops propagation
      expect(screen.queryByText('Technical Details')).not.toBeInTheDocument();
    });

    it('clicking the main row area still expands the conversation', () => {
      const { wrapper } = createWrapper();
      const conversation = makeConversation();
      render(<ConversationRow conversation={conversation} />, { wrapper });

      expect(screen.queryByText('Technical Details')).not.toBeInTheDocument();

      // Click on the expand button (the inner button wrapping from/to info)
      const fromLabel = screen.getByText('Telegram Bot');
      fireEvent.click(fromLabel);

      expect(screen.getByText('Technical Details')).toBeInTheDocument();
    });
  });
});
