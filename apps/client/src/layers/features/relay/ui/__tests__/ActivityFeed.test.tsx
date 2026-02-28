/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ---------------------------------------------------------------------------
// Mock entity hooks
// ---------------------------------------------------------------------------

const mockUseRelayConversations = vi.fn();
const mockUseSendRelayMessage = vi.fn(() => ({ mutate: vi.fn(), isPending: false }));

vi.mock('@/layers/entities/relay', () => ({
  useRelayConversations: (...args: unknown[]) => mockUseRelayConversations(...args),
  useSendRelayMessage: () => mockUseSendRelayMessage(),
}));

// Mock DeadLetterSection — it has its own tests and fetches independently.
vi.mock('../DeadLetterSection', () => ({
  DeadLetterSection: ({ enabled }: { enabled?: boolean }) => (
    <div data-testid="dead-letter-section" data-enabled={String(enabled)} />
  ),
}));

// Mock ConversationRow — it has its own tests; we only care it receives the conversation.
vi.mock('../ConversationRow', () => ({
  ConversationRow: ({ conversation }: { conversation: { id: string; subject: string } }) => (
    <div data-testid="conversation-row" data-subject={conversation.subject} />
  ),
}));

import { ActivityFeed } from '../ActivityFeed';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeConversation = (
  id: string,
  subject = 'relay.system.test',
  overrides: Record<string, unknown> = {},
) => ({
  id,
  subject,
  direction: 'outbound',
  status: 'delivered',
  from: { label: 'System', raw: 'system' },
  to: { label: 'Agent', raw: 'relay.agent.123' },
  preview: '',
  responseCount: 0,
  sentAt: new Date().toISOString(),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockUseRelayConversations.mockReturnValue({ data: null, isLoading: false });
});

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ActivityFeed', () => {
  describe('loading state', () => {
    it('shows skeleton placeholders while loading', () => {
      mockUseRelayConversations.mockReturnValue({ data: null, isLoading: true });
      render(<ActivityFeed enabled={true} />);

      // The loading skeleton renders 3 animated placeholder divs
      const skeletons = document.querySelectorAll('.animate-pulse');
      expect(skeletons.length).toBeGreaterThan(0);
    });

    it('does not render the conversation list while loading', () => {
      mockUseRelayConversations.mockReturnValue({ data: null, isLoading: true });
      render(<ActivityFeed enabled={true} />);
      expect(screen.queryByTestId('conversation-row')).not.toBeInTheDocument();
    });
  });

  describe('empty state', () => {
    it('shows the "no messages yet" state when there are no conversations and no active filters', () => {
      mockUseRelayConversations.mockReturnValue({ data: { conversations: [] }, isLoading: false });
      render(<ActivityFeed enabled={true} />);
      expect(screen.getByText('No messages yet')).toBeInTheDocument();
    });

    it('shows contextual description in the no-messages state', () => {
      mockUseRelayConversations.mockReturnValue({ data: { conversations: [] }, isLoading: false });
      render(<ActivityFeed enabled={true} />);
      expect(
        screen.getByText(
          'Messages will appear here once your adapters are connected and agents start communicating.',
        ),
      ).toBeInTheDocument();
    });

    it('does not show "Set up an adapter" button when onSwitchToAdapters is not provided', () => {
      mockUseRelayConversations.mockReturnValue({ data: { conversations: [] }, isLoading: false });
      render(<ActivityFeed enabled={true} />);
      expect(screen.queryByText('Set up an adapter')).not.toBeInTheDocument();
    });

    it('shows "Set up an adapter" button when onSwitchToAdapters is provided', () => {
      mockUseRelayConversations.mockReturnValue({ data: { conversations: [] }, isLoading: false });
      render(<ActivityFeed enabled={true} onSwitchToAdapters={vi.fn()} />);
      expect(screen.getByText('Set up an adapter')).toBeInTheDocument();
    });

    it('calls onSwitchToAdapters when "Set up an adapter" is clicked', () => {
      mockUseRelayConversations.mockReturnValue({ data: { conversations: [] }, isLoading: false });
      const onSwitchToAdapters = vi.fn();
      render(<ActivityFeed enabled={true} onSwitchToAdapters={onSwitchToAdapters} />);
      fireEvent.click(screen.getByText('Set up an adapter'));
      expect(onSwitchToAdapters).toHaveBeenCalledOnce();
    });

    it('shows the "no messages match filters" state when filters are active and nothing matches', () => {
      mockUseRelayConversations.mockReturnValue({ data: { conversations: [] }, isLoading: false });
      render(<ActivityFeed enabled={true} />);

      const [sourceCombobox] = screen.getAllByRole('combobox');
      fireEvent.click(sourceCombobox);
      fireEvent.click(screen.getByRole('option', { name: 'Chat messages' }));

      expect(screen.getByText('No messages match your filters')).toBeInTheDocument();
      expect(screen.getByText('Try adjusting your filter criteria.')).toBeInTheDocument();
    });

    it('shows "Clear filters" in the empty state when filters are active and nothing matches', () => {
      mockUseRelayConversations.mockReturnValue({ data: { conversations: [] }, isLoading: false });
      render(<ActivityFeed enabled={true} />);

      const [sourceCombobox] = screen.getAllByRole('combobox');
      fireEvent.click(sourceCombobox);
      fireEvent.click(screen.getByRole('option', { name: 'Chat messages' }));

      expect(screen.getAllByText('Clear filters').length).toBeGreaterThanOrEqual(1);
    });

    it('clears filters when "Clear filters" in the empty state is clicked', () => {
      mockUseRelayConversations.mockReturnValue({ data: { conversations: [] }, isLoading: false });
      render(<ActivityFeed enabled={true} />);

      fireEvent.change(screen.getByPlaceholderText('Search...'), {
        target: { value: 'zzznomatch' },
      });

      expect(screen.getByText('No messages match your filters')).toBeInTheDocument();

      // Click the "Clear filters" button that appears inside the empty state
      const clearButtons = screen.getAllByText('Clear filters');
      fireEvent.click(clearButtons[clearButtons.length - 1]);

      expect(screen.getByText('No messages yet')).toBeInTheDocument();
    });
  });

  describe('conversation list rendering', () => {
    it('renders a ConversationRow for each conversation', () => {
      const conversations = [
        makeConversation('conv-1'),
        makeConversation('conv-2'),
        makeConversation('conv-3'),
      ];
      mockUseRelayConversations.mockReturnValue({ data: { conversations }, isLoading: false });

      render(<ActivityFeed enabled={true} />);

      expect(screen.getAllByTestId('conversation-row')).toHaveLength(3);
    });

    it('renders history conversations without crashing', () => {
      const conversations = [makeConversation('conv-a'), makeConversation('conv-b')];
      mockUseRelayConversations.mockReturnValue({ data: { conversations }, isLoading: false });

      expect(() => render(<ActivityFeed enabled={true} />)).not.toThrow();
      expect(screen.getAllByTestId('conversation-row')).toHaveLength(2);
    });

    it('renders new conversations that appear after initial load', async () => {
      const initial = [makeConversation('conv-1')];
      mockUseRelayConversations.mockReturnValue({ data: { conversations: initial }, isLoading: false });

      const { rerender } = render(<ActivityFeed enabled={true} />);
      expect(screen.getAllByTestId('conversation-row')).toHaveLength(1);

      // Simulate an SSE-delivered conversation arriving
      const updated = [makeConversation('conv-1'), makeConversation('conv-2')];
      mockUseRelayConversations.mockReturnValue({ data: { conversations: updated }, isLoading: false });

      await act(async () => {
        rerender(<ActivityFeed enabled={true} />);
      });

      expect(screen.getAllByTestId('conversation-row')).toHaveLength(2);
    });
  });

  describe('source filter', () => {
    it('shows all conversations when filter is "all"', () => {
      const conversations = [
        makeConversation('conv-1', 'relay.agent.session-1'),
        makeConversation('conv-2', 'relay.system.pulse.schedule-1'),
        makeConversation('conv-3', 'relay.system.info'),
      ];
      mockUseRelayConversations.mockReturnValue({ data: { conversations }, isLoading: false });

      render(<ActivityFeed enabled={true} />);
      expect(screen.getAllByTestId('conversation-row')).toHaveLength(3);
    });

    it('filters to only chat messages when "Chat messages" is selected', () => {
      const conversations = [
        makeConversation('conv-1', 'relay.agent.session-1'),
        makeConversation('conv-2', 'relay.system.pulse.schedule-1'),
        makeConversation('conv-3', 'relay.system.info'),
      ];
      mockUseRelayConversations.mockReturnValue({ data: { conversations }, isLoading: false });

      render(<ActivityFeed enabled={true} />);

      const [sourceCombobox] = screen.getAllByRole('combobox');
      fireEvent.click(sourceCombobox);
      fireEvent.click(screen.getByRole('option', { name: 'Chat messages' }));

      expect(screen.getAllByTestId('conversation-row')).toHaveLength(1);
      expect(screen.getByTestId('conversation-row')).toHaveAttribute(
        'data-subject',
        'relay.agent.session-1',
      );
    });

    it('filters to only pulse jobs when "Pulse jobs" is selected', () => {
      const conversations = [
        makeConversation('conv-1', 'relay.agent.session-1'),
        makeConversation('conv-2', 'relay.system.pulse.schedule-1'),
        makeConversation('conv-3', 'relay.system.info'),
      ];
      mockUseRelayConversations.mockReturnValue({ data: { conversations }, isLoading: false });

      render(<ActivityFeed enabled={true} />);

      const [sourceCombobox] = screen.getAllByRole('combobox');
      fireEvent.click(sourceCombobox);
      fireEvent.click(screen.getByRole('option', { name: 'Pulse jobs' }));

      expect(screen.getAllByTestId('conversation-row')).toHaveLength(1);
      expect(screen.getByTestId('conversation-row')).toHaveAttribute(
        'data-subject',
        'relay.system.pulse.schedule-1',
      );
    });

    it('shows filter-mismatch empty state when filter yields no results', () => {
      mockUseRelayConversations.mockReturnValue({ data: { conversations: [] }, isLoading: false });
      render(<ActivityFeed enabled={true} />);

      const [sourceCombobox] = screen.getAllByRole('combobox');
      fireEvent.click(sourceCombobox);
      fireEvent.click(screen.getByRole('option', { name: 'Chat messages' }));

      expect(screen.getByText('No messages match your filters')).toBeInTheDocument();
    });
  });

  describe('status filter', () => {
    it('renders the status filter dropdown', () => {
      mockUseRelayConversations.mockReturnValue({ data: { conversations: [] }, isLoading: false });
      render(<ActivityFeed enabled={true} />);

      // Two comboboxes: source and status
      expect(screen.getAllByRole('combobox')).toHaveLength(2);
    });

    it('filters to delivered conversations when "Delivered" is selected', () => {
      const conversations = [
        makeConversation('conv-1', 'relay.system.a', { status: 'delivered' }),
        makeConversation('conv-2', 'relay.system.b', { status: 'pending' }),
        makeConversation('conv-3', 'relay.system.c', { status: 'failed' }),
      ];
      mockUseRelayConversations.mockReturnValue({ data: { conversations }, isLoading: false });

      render(<ActivityFeed enabled={true} />);

      const [, statusCombobox] = screen.getAllByRole('combobox');
      fireEvent.click(statusCombobox);
      fireEvent.click(screen.getByRole('option', { name: 'Delivered' }));

      expect(screen.getAllByTestId('conversation-row')).toHaveLength(1);
      expect(screen.getByTestId('conversation-row')).toHaveAttribute('data-subject', 'relay.system.a');
    });

    it('filters to failed conversations when "Failed" is selected', () => {
      const conversations = [
        makeConversation('conv-1', 'relay.system.a', { status: 'delivered' }),
        makeConversation('conv-2', 'relay.system.b', { status: 'failed' }),
        makeConversation('conv-3', 'relay.system.c', { status: 'pending' }),
      ];
      mockUseRelayConversations.mockReturnValue({ data: { conversations }, isLoading: false });

      render(<ActivityFeed enabled={true} />);

      const [, statusCombobox] = screen.getAllByRole('combobox');
      fireEvent.click(statusCombobox);
      fireEvent.click(screen.getByRole('option', { name: 'Failed' }));

      expect(screen.getAllByTestId('conversation-row')).toHaveLength(1);
      expect(screen.getByTestId('conversation-row')).toHaveAttribute('data-subject', 'relay.system.b');
    });

    it('filters to pending conversations when "Pending" is selected', () => {
      const conversations = [
        makeConversation('conv-1', 'relay.system.a', { status: 'pending' }),
        makeConversation('conv-2', 'relay.system.b', { status: 'delivered' }),
      ];
      mockUseRelayConversations.mockReturnValue({ data: { conversations }, isLoading: false });

      render(<ActivityFeed enabled={true} />);

      const [, statusCombobox] = screen.getAllByRole('combobox');
      fireEvent.click(statusCombobox);
      fireEvent.click(screen.getByRole('option', { name: 'Pending' }));

      expect(screen.getAllByTestId('conversation-row')).toHaveLength(1);
      expect(screen.getByTestId('conversation-row')).toHaveAttribute('data-subject', 'relay.system.a');
    });
  });

  describe('search filter', () => {
    it('renders the search text input', () => {
      mockUseRelayConversations.mockReturnValue({ data: { conversations: [] }, isLoading: false });
      render(<ActivityFeed enabled={true} />);

      expect(screen.getByPlaceholderText('Search...')).toBeInTheDocument();
    });

    it('filters conversations by from/to labels and subject (case-insensitive)', () => {
      const conversations = [
        makeConversation('conv-1', 'relay.agent.session', {
          from: { label: 'Alice', raw: 'relay.agent.alice' },
          to: { label: 'Bob', raw: 'relay.agent.bob' },
        }),
        makeConversation('conv-2', 'relay.system.health', {
          from: { label: 'System', raw: 'system' },
          to: { label: 'Monitor', raw: 'relay.system.monitor' },
        }),
        makeConversation('conv-3', 'relay.agent.heartbeat', {
          from: { label: 'Charlie', raw: 'relay.agent.charlie' },
          to: { label: 'Alice', raw: 'relay.agent.alice' },
        }),
      ];
      mockUseRelayConversations.mockReturnValue({ data: { conversations }, isLoading: false });

      render(<ActivityFeed enabled={true} />);

      fireEvent.change(screen.getByPlaceholderText('Search...'), {
        target: { value: 'ALICE' },
      });

      expect(screen.getAllByTestId('conversation-row')).toHaveLength(2);
    });

    it('shows filter-mismatch empty state when search filter matches nothing', () => {
      const conversations = [makeConversation('conv-1', 'relay.system.health')];
      mockUseRelayConversations.mockReturnValue({ data: { conversations }, isLoading: false });

      render(<ActivityFeed enabled={true} />);

      fireEvent.change(screen.getByPlaceholderText('Search...'), {
        target: { value: 'zzznomatch' },
      });

      expect(screen.getByText('No messages match your filters')).toBeInTheDocument();
    });
  });

  describe('clear filters', () => {
    it('does not show "Clear filters" button when no filters are active', () => {
      mockUseRelayConversations.mockReturnValue({ data: { conversations: [] }, isLoading: false });
      render(<ActivityFeed enabled={true} />);

      expect(screen.queryByText('Clear filters')).not.toBeInTheDocument();
    });

    it('shows "Clear filters" button in filter bar when source filter is active', () => {
      mockUseRelayConversations.mockReturnValue({ data: { conversations: [] }, isLoading: false });
      render(<ActivityFeed enabled={true} />);

      const [sourceCombobox] = screen.getAllByRole('combobox');
      fireEvent.click(sourceCombobox);
      fireEvent.click(screen.getByRole('option', { name: 'Chat messages' }));

      expect(screen.getAllByText('Clear filters').length).toBeGreaterThanOrEqual(1);
    });

    it('shows "Clear filters" button in filter bar when search filter is active', () => {
      mockUseRelayConversations.mockReturnValue({ data: { conversations: [] }, isLoading: false });
      render(<ActivityFeed enabled={true} />);

      fireEvent.change(screen.getByPlaceholderText('Search...'), {
        target: { value: 'test' },
      });

      expect(screen.getAllByText('Clear filters').length).toBeGreaterThanOrEqual(1);
    });

    it('resets all filters when "Clear filters" is clicked', () => {
      const conversations = [
        makeConversation('conv-1', 'relay.agent.session-1', { status: 'pending' }),
        makeConversation('conv-2', 'relay.system.health', { status: 'delivered' }),
      ];
      mockUseRelayConversations.mockReturnValue({ data: { conversations }, isLoading: false });

      render(<ActivityFeed enabled={true} />);

      // Apply source filter
      const [sourceCombobox] = screen.getAllByRole('combobox');
      fireEvent.click(sourceCombobox);
      fireEvent.click(screen.getByRole('option', { name: 'Chat messages' }));

      expect(screen.getAllByTestId('conversation-row')).toHaveLength(1);

      // Clear all filters
      fireEvent.click(screen.getByText('Clear filters'));

      expect(screen.getAllByTestId('conversation-row')).toHaveLength(2);
      expect(screen.queryByText('Clear filters')).not.toBeInTheDocument();
    });
  });

  describe('combined filters', () => {
    it('applies source and status filters together', () => {
      const conversations = [
        makeConversation('conv-1', 'relay.agent.session-1', { status: 'delivered' }),
        makeConversation('conv-2', 'relay.agent.session-2', { status: 'pending' }),
        makeConversation('conv-3', 'relay.system.health', { status: 'delivered' }),
      ];
      mockUseRelayConversations.mockReturnValue({ data: { conversations }, isLoading: false });

      render(<ActivityFeed enabled={true} />);

      // Source: chat
      const [sourceCombobox, statusCombobox] = screen.getAllByRole('combobox');
      fireEvent.click(sourceCombobox);
      fireEvent.click(screen.getByRole('option', { name: 'Chat messages' }));

      // Status: delivered
      fireEvent.click(statusCombobox);
      fireEvent.click(screen.getByRole('option', { name: 'Delivered' }));

      expect(screen.getAllByTestId('conversation-row')).toHaveLength(1);
      expect(screen.getByTestId('conversation-row')).toHaveAttribute(
        'data-subject',
        'relay.agent.session-1',
      );
    });

    it('applies source and search filters together', () => {
      const conversations = [
        makeConversation('conv-1', 'relay.agent.alpha', {
          from: { label: 'Alpha Agent', raw: 'relay.agent.alpha' },
        }),
        makeConversation('conv-2', 'relay.agent.beta', {
          from: { label: 'Beta Agent', raw: 'relay.agent.beta' },
        }),
        makeConversation('conv-3', 'relay.system.alpha', {
          from: { label: 'System Alpha', raw: 'relay.system.alpha' },
        }),
      ];
      mockUseRelayConversations.mockReturnValue({ data: { conversations }, isLoading: false });

      render(<ActivityFeed enabled={true} />);

      const [sourceCombobox] = screen.getAllByRole('combobox');
      fireEvent.click(sourceCombobox);
      fireEvent.click(screen.getByRole('option', { name: 'Chat messages' }));

      fireEvent.change(screen.getByPlaceholderText('Search...'), {
        target: { value: 'alpha' },
      });

      expect(screen.getAllByTestId('conversation-row')).toHaveLength(1);
      expect(screen.getByTestId('conversation-row')).toHaveAttribute(
        'data-subject',
        'relay.agent.alpha',
      );
    });
  });

  describe('DeadLetterSection integration', () => {
    it('renders DeadLetterSection with the enabled prop', () => {
      mockUseRelayConversations.mockReturnValue({ data: { conversations: [] }, isLoading: false });
      render(<ActivityFeed enabled={true} />);

      const section = screen.getByTestId('dead-letter-section');
      expect(section).toBeInTheDocument();
      expect(section).toHaveAttribute('data-enabled', 'true');
    });

    it('passes enabled=false to DeadLetterSection when relay is disabled', () => {
      mockUseRelayConversations.mockReturnValue({ data: { conversations: [] }, isLoading: false });
      render(<ActivityFeed enabled={false} />);

      const section = screen.getByTestId('dead-letter-section');
      expect(section).toHaveAttribute('data-enabled', 'false');
    });
  });

  describe('deadLetterRef prop', () => {
    it('does not crash when deadLetterRef is not provided', () => {
      mockUseRelayConversations.mockReturnValue({ data: { conversations: [] }, isLoading: false });
      expect(() => render(<ActivityFeed enabled={true} />)).not.toThrow();
    });

    it('attaches deadLetterRef to the dead-letter wrapper div', () => {
      mockUseRelayConversations.mockReturnValue({ data: { conversations: [] }, isLoading: false });

      const ref = { current: null } as React.RefObject<HTMLDivElement | null>;
      render(<ActivityFeed enabled={true} deadLetterRef={ref} />);

      expect(ref.current).not.toBeNull();
    });
  });
});
