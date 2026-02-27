/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ---------------------------------------------------------------------------
// Mock entity hooks
// ---------------------------------------------------------------------------

const mockUseRelayMessages = vi.fn();
const mockUseSendRelayMessage = vi.fn(() => ({ mutate: vi.fn(), isPending: false }));

vi.mock('@/layers/entities/relay', () => ({
  useRelayMessages: (...args: unknown[]) => mockUseRelayMessages(...args),
  useSendRelayMessage: () => mockUseSendRelayMessage(),
}));

// Mock DeadLetterSection — it has its own tests and fetches independently.
vi.mock('../DeadLetterSection', () => ({
  DeadLetterSection: ({ enabled }: { enabled?: boolean }) => (
    <div data-testid="dead-letter-section" data-enabled={String(enabled)} />
  ),
}));

// Mock MessageRow — it has its own tests; we only care it receives the message.
vi.mock('../MessageRow', () => ({
  MessageRow: ({ message }: { message: Record<string, unknown> }) => (
    <div data-testid="message-row" data-subject={message.subject as string} />
  ),
}));

import { ActivityFeed } from '../ActivityFeed';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeMessage = (
  id: string,
  subject = 'relay.system.test',
  overrides: Record<string, unknown> = {},
) => ({
  id,
  subject,
  from: 'system',
  status: 'cur',
  createdAt: new Date().toISOString(),
  payload: {},
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockUseRelayMessages.mockReturnValue({ data: null, isLoading: false });
});

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ActivityFeed', () => {
  describe('loading state', () => {
    it('shows skeleton placeholders while loading', () => {
      mockUseRelayMessages.mockReturnValue({ data: null, isLoading: true });
      render(<ActivityFeed enabled={true} />);

      // The loading skeleton renders 3 animated placeholder divs
      const skeletons = document.querySelectorAll('.animate-pulse');
      expect(skeletons.length).toBeGreaterThan(0);
    });

    it('does not render the message list while loading', () => {
      mockUseRelayMessages.mockReturnValue({ data: null, isLoading: true });
      render(<ActivityFeed enabled={true} />);
      expect(screen.queryByTestId('message-row')).not.toBeInTheDocument();
    });
  });

  describe('empty state', () => {
    it('shows the "no messages yet" state when there are no messages and no active filters', () => {
      mockUseRelayMessages.mockReturnValue({ data: { messages: [] }, isLoading: false });
      render(<ActivityFeed enabled={true} />);
      expect(screen.getByText('No messages yet')).toBeInTheDocument();
    });

    it('shows contextual description in the no-messages state', () => {
      mockUseRelayMessages.mockReturnValue({ data: { messages: [] }, isLoading: false });
      render(<ActivityFeed enabled={true} />);
      expect(
        screen.getByText(
          'Messages will appear here once your adapters are connected and agents start communicating.',
        ),
      ).toBeInTheDocument();
    });

    it('does not show "Set up an adapter" button when onSwitchToAdapters is not provided', () => {
      mockUseRelayMessages.mockReturnValue({ data: { messages: [] }, isLoading: false });
      render(<ActivityFeed enabled={true} />);
      expect(screen.queryByText('Set up an adapter')).not.toBeInTheDocument();
    });

    it('shows "Set up an adapter" button when onSwitchToAdapters is provided', () => {
      mockUseRelayMessages.mockReturnValue({ data: { messages: [] }, isLoading: false });
      render(<ActivityFeed enabled={true} onSwitchToAdapters={vi.fn()} />);
      expect(screen.getByText('Set up an adapter')).toBeInTheDocument();
    });

    it('calls onSwitchToAdapters when "Set up an adapter" is clicked', () => {
      mockUseRelayMessages.mockReturnValue({ data: { messages: [] }, isLoading: false });
      const onSwitchToAdapters = vi.fn();
      render(<ActivityFeed enabled={true} onSwitchToAdapters={onSwitchToAdapters} />);
      fireEvent.click(screen.getByText('Set up an adapter'));
      expect(onSwitchToAdapters).toHaveBeenCalledOnce();
    });

    it('shows the "no messages match filters" state when filters are active and nothing matches', () => {
      mockUseRelayMessages.mockReturnValue({ data: { messages: [] }, isLoading: false });
      render(<ActivityFeed enabled={true} />);

      const [sourceCombobox] = screen.getAllByRole('combobox');
      fireEvent.click(sourceCombobox);
      fireEvent.click(screen.getByRole('option', { name: 'Telegram' }));

      expect(screen.getByText('No messages match your filters')).toBeInTheDocument();
      expect(screen.getByText('Try adjusting your filter criteria.')).toBeInTheDocument();
    });

    it('shows "Clear filters" in the empty state when filters are active and nothing matches', () => {
      mockUseRelayMessages.mockReturnValue({ data: { messages: [] }, isLoading: false });
      render(<ActivityFeed enabled={true} />);

      const [sourceCombobox] = screen.getAllByRole('combobox');
      fireEvent.click(sourceCombobox);
      fireEvent.click(screen.getByRole('option', { name: 'Telegram' }));

      expect(screen.getAllByText('Clear filters').length).toBeGreaterThanOrEqual(1);
    });

    it('clears filters when "Clear filters" in the empty state is clicked', () => {
      mockUseRelayMessages.mockReturnValue({ data: { messages: [] }, isLoading: false });
      render(<ActivityFeed enabled={true} />);

      fireEvent.change(screen.getByPlaceholderText('Filter by subject...'), {
        target: { value: 'zzznomatch' },
      });

      expect(screen.getByText('No messages match your filters')).toBeInTheDocument();

      // Click the "Clear filters" button that appears inside the empty state
      const clearButtons = screen.getAllByText('Clear filters');
      fireEvent.click(clearButtons[clearButtons.length - 1]);

      expect(screen.getByText('No messages yet')).toBeInTheDocument();
    });
  });

  describe('message list rendering', () => {
    it('renders a MessageRow for each message', () => {
      const messages = [makeMessage('msg-1'), makeMessage('msg-2'), makeMessage('msg-3')];
      mockUseRelayMessages.mockReturnValue({ data: { messages }, isLoading: false });

      render(<ActivityFeed enabled={true} />);

      expect(screen.getAllByTestId('message-row')).toHaveLength(3);
    });

    it('renders history messages without crashing', () => {
      const messages = [makeMessage('msg-a'), makeMessage('msg-b')];
      mockUseRelayMessages.mockReturnValue({ data: { messages }, isLoading: false });

      expect(() => render(<ActivityFeed enabled={true} />)).not.toThrow();
      expect(screen.getAllByTestId('message-row')).toHaveLength(2);
    });

    it('renders new messages that appear after initial load', async () => {
      const initial = [makeMessage('msg-1')];
      mockUseRelayMessages.mockReturnValue({ data: { messages: initial }, isLoading: false });

      const { rerender } = render(<ActivityFeed enabled={true} />);
      expect(screen.getAllByTestId('message-row')).toHaveLength(1);

      // Simulate an SSE-delivered message arriving
      const updated = [makeMessage('msg-1'), makeMessage('msg-2')];
      mockUseRelayMessages.mockReturnValue({ data: { messages: updated }, isLoading: false });

      await act(async () => {
        rerender(<ActivityFeed enabled={true} />);
      });

      expect(screen.getAllByTestId('message-row')).toHaveLength(2);
    });
  });

  describe('source filter', () => {
    it('shows all messages when filter is "all"', () => {
      const messages = [
        makeMessage('msg-1', 'relay.human.telegram.inbound'),
        makeMessage('msg-2', 'relay.webhook.hook'),
        makeMessage('msg-3', 'relay.system.info'),
      ];
      mockUseRelayMessages.mockReturnValue({ data: { messages }, isLoading: false });

      render(<ActivityFeed enabled={true} />);
      expect(screen.getAllByTestId('message-row')).toHaveLength(3);
    });

    it('filters to only telegram messages when "telegram" is selected', () => {
      const messages = [
        makeMessage('msg-1', 'relay.human.telegram.inbound'),
        makeMessage('msg-2', 'relay.webhook.hook'),
        makeMessage('msg-3', 'relay.system.info'),
      ];
      mockUseRelayMessages.mockReturnValue({ data: { messages }, isLoading: false });

      render(<ActivityFeed enabled={true} />);

      // There are now multiple comboboxes — target the first one (source filter)
      const [sourceCombobox] = screen.getAllByRole('combobox');
      fireEvent.click(sourceCombobox);
      fireEvent.click(screen.getByRole('option', { name: 'Telegram' }));

      expect(screen.getAllByTestId('message-row')).toHaveLength(1);
      expect(screen.getByTestId('message-row')).toHaveAttribute(
        'data-subject',
        'relay.human.telegram.inbound',
      );
    });

    it('shows filter-mismatch empty state when filter yields no results', () => {
      mockUseRelayMessages.mockReturnValue({ data: { messages: [] }, isLoading: false });
      render(<ActivityFeed enabled={true} />);

      const [sourceCombobox] = screen.getAllByRole('combobox');
      fireEvent.click(sourceCombobox);
      fireEvent.click(screen.getByRole('option', { name: 'Telegram' }));

      expect(screen.getByText('No messages match your filters')).toBeInTheDocument();
    });
  });

  describe('status filter', () => {
    it('renders the status filter dropdown', () => {
      mockUseRelayMessages.mockReturnValue({ data: { messages: [] }, isLoading: false });
      render(<ActivityFeed enabled={true} />);

      // Two comboboxes: source and status
      expect(screen.getAllByRole('combobox')).toHaveLength(2);
    });

    it('filters to delivered messages (status=cur) when "Delivered" is selected', () => {
      const messages = [
        makeMessage('msg-1', 'relay.system.a', { status: 'cur' }),
        makeMessage('msg-2', 'relay.system.b', { status: 'new' }),
        makeMessage('msg-3', 'relay.system.c', { status: 'failed' }),
      ];
      mockUseRelayMessages.mockReturnValue({ data: { messages }, isLoading: false });

      render(<ActivityFeed enabled={true} />);

      const [, statusCombobox] = screen.getAllByRole('combobox');
      fireEvent.click(statusCombobox);
      fireEvent.click(screen.getByRole('option', { name: 'Delivered' }));

      expect(screen.getAllByTestId('message-row')).toHaveLength(1);
      expect(screen.getByTestId('message-row')).toHaveAttribute('data-subject', 'relay.system.a');
    });

    it('filters to failed messages (status=failed and dead_letter) when "Failed" is selected', () => {
      const messages = [
        makeMessage('msg-1', 'relay.system.a', { status: 'cur' }),
        makeMessage('msg-2', 'relay.system.b', { status: 'failed' }),
        makeMessage('msg-3', 'relay.system.c', { status: 'dead_letter' }),
      ];
      mockUseRelayMessages.mockReturnValue({ data: { messages }, isLoading: false });

      render(<ActivityFeed enabled={true} />);

      const [, statusCombobox] = screen.getAllByRole('combobox');
      fireEvent.click(statusCombobox);
      fireEvent.click(screen.getByRole('option', { name: 'Failed' }));

      expect(screen.getAllByTestId('message-row')).toHaveLength(2);
    });

    it('filters to pending messages (status=new) when "Pending" is selected', () => {
      const messages = [
        makeMessage('msg-1', 'relay.system.a', { status: 'new' }),
        makeMessage('msg-2', 'relay.system.b', { status: 'cur' }),
      ];
      mockUseRelayMessages.mockReturnValue({ data: { messages }, isLoading: false });

      render(<ActivityFeed enabled={true} />);

      const [, statusCombobox] = screen.getAllByRole('combobox');
      fireEvent.click(statusCombobox);
      fireEvent.click(screen.getByRole('option', { name: 'Pending' }));

      expect(screen.getAllByTestId('message-row')).toHaveLength(1);
      expect(screen.getByTestId('message-row')).toHaveAttribute('data-subject', 'relay.system.a');
    });
  });

  describe('subject filter', () => {
    it('renders the subject text input', () => {
      mockUseRelayMessages.mockReturnValue({ data: { messages: [] }, isLoading: false });
      render(<ActivityFeed enabled={true} />);

      expect(screen.getByPlaceholderText('Filter by subject...')).toBeInTheDocument();
    });

    it('filters messages by subject substring (case-insensitive)', () => {
      const messages = [
        makeMessage('msg-1', 'relay.agent.session'),
        makeMessage('msg-2', 'relay.system.health'),
        makeMessage('msg-3', 'relay.agent.heartbeat'),
      ];
      mockUseRelayMessages.mockReturnValue({ data: { messages }, isLoading: false });

      render(<ActivityFeed enabled={true} />);

      fireEvent.change(screen.getByPlaceholderText('Filter by subject...'), {
        target: { value: 'AGENT' },
      });

      expect(screen.getAllByTestId('message-row')).toHaveLength(2);
    });

    it('shows filter-mismatch empty state when subject filter matches nothing', () => {
      const messages = [makeMessage('msg-1', 'relay.system.health')];
      mockUseRelayMessages.mockReturnValue({ data: { messages }, isLoading: false });

      render(<ActivityFeed enabled={true} />);

      fireEvent.change(screen.getByPlaceholderText('Filter by subject...'), {
        target: { value: 'zzznomatch' },
      });

      expect(screen.getByText('No messages match your filters')).toBeInTheDocument();
    });
  });

  describe('clear filters', () => {
    it('does not show "Clear filters" button when no filters are active', () => {
      mockUseRelayMessages.mockReturnValue({ data: { messages: [] }, isLoading: false });
      render(<ActivityFeed enabled={true} />);

      expect(screen.queryByText('Clear filters')).not.toBeInTheDocument();
    });

    it('shows "Clear filters" button in filter bar when source filter is active', () => {
      mockUseRelayMessages.mockReturnValue({ data: { messages: [] }, isLoading: false });
      render(<ActivityFeed enabled={true} />);

      const [sourceCombobox] = screen.getAllByRole('combobox');
      fireEvent.click(sourceCombobox);
      fireEvent.click(screen.getByRole('option', { name: 'Telegram' }));

      expect(screen.getAllByText('Clear filters').length).toBeGreaterThanOrEqual(1);
    });

    it('shows "Clear filters" button in filter bar when subject filter is active', () => {
      mockUseRelayMessages.mockReturnValue({ data: { messages: [] }, isLoading: false });
      render(<ActivityFeed enabled={true} />);

      fireEvent.change(screen.getByPlaceholderText('Filter by subject...'), {
        target: { value: 'test' },
      });

      expect(screen.getAllByText('Clear filters').length).toBeGreaterThanOrEqual(1);
    });

    it('resets all filters when "Clear filters" is clicked', () => {
      const messages = [
        makeMessage('msg-1', 'relay.human.telegram.inbound', { status: 'new' }),
        makeMessage('msg-2', 'relay.system.health', { status: 'cur' }),
      ];
      mockUseRelayMessages.mockReturnValue({ data: { messages }, isLoading: false });

      render(<ActivityFeed enabled={true} />);

      // Apply source filter
      const [sourceCombobox] = screen.getAllByRole('combobox');
      fireEvent.click(sourceCombobox);
      fireEvent.click(screen.getByRole('option', { name: 'Telegram' }));

      expect(screen.getAllByTestId('message-row')).toHaveLength(1);

      // Clear all filters
      fireEvent.click(screen.getByText('Clear filters'));

      expect(screen.getAllByTestId('message-row')).toHaveLength(2);
      expect(screen.queryByText('Clear filters')).not.toBeInTheDocument();
    });
  });

  describe('combined filters', () => {
    it('applies source and status filters together', () => {
      const messages = [
        makeMessage('msg-1', 'relay.human.telegram.inbound', { status: 'cur' }),
        makeMessage('msg-2', 'relay.human.telegram.inbound', { status: 'new' }),
        makeMessage('msg-3', 'relay.system.health', { status: 'cur' }),
      ];
      mockUseRelayMessages.mockReturnValue({ data: { messages }, isLoading: false });

      render(<ActivityFeed enabled={true} />);

      // Source: telegram
      const [sourceCombobox, statusCombobox] = screen.getAllByRole('combobox');
      fireEvent.click(sourceCombobox);
      fireEvent.click(screen.getByRole('option', { name: 'Telegram' }));

      // Status: delivered
      fireEvent.click(statusCombobox);
      fireEvent.click(screen.getByRole('option', { name: 'Delivered' }));

      expect(screen.getAllByTestId('message-row')).toHaveLength(1);
      expect(screen.getByTestId('message-row')).toHaveAttribute(
        'data-subject',
        'relay.human.telegram.inbound',
      );
    });

    it('applies source and subject filters together', () => {
      const messages = [
        makeMessage('msg-1', 'relay.human.telegram.alpha'),
        makeMessage('msg-2', 'relay.human.telegram.beta'),
        makeMessage('msg-3', 'relay.system.alpha'),
      ];
      mockUseRelayMessages.mockReturnValue({ data: { messages }, isLoading: false });

      render(<ActivityFeed enabled={true} />);

      const [sourceCombobox] = screen.getAllByRole('combobox');
      fireEvent.click(sourceCombobox);
      fireEvent.click(screen.getByRole('option', { name: 'Telegram' }));

      fireEvent.change(screen.getByPlaceholderText('Filter by subject...'), {
        target: { value: 'alpha' },
      });

      expect(screen.getAllByTestId('message-row')).toHaveLength(1);
      expect(screen.getByTestId('message-row')).toHaveAttribute(
        'data-subject',
        'relay.human.telegram.alpha',
      );
    });
  });

  describe('DeadLetterSection integration', () => {
    it('renders DeadLetterSection with the enabled prop', () => {
      mockUseRelayMessages.mockReturnValue({ data: { messages: [] }, isLoading: false });
      render(<ActivityFeed enabled={true} />);

      const section = screen.getByTestId('dead-letter-section');
      expect(section).toBeInTheDocument();
      expect(section).toHaveAttribute('data-enabled', 'true');
    });

    it('passes enabled=false to DeadLetterSection when relay is disabled', () => {
      mockUseRelayMessages.mockReturnValue({ data: { messages: [] }, isLoading: false });
      render(<ActivityFeed enabled={false} />);

      const section = screen.getByTestId('dead-letter-section');
      expect(section).toHaveAttribute('data-enabled', 'false');
    });
  });

  describe('deadLetterRef prop', () => {
    it('does not crash when deadLetterRef is not provided', () => {
      mockUseRelayMessages.mockReturnValue({ data: { messages: [] }, isLoading: false });
      expect(() => render(<ActivityFeed enabled={true} />)).not.toThrow();
    });

    it('attaches deadLetterRef to the dead-letter wrapper div', () => {
      mockUseRelayMessages.mockReturnValue({ data: { messages: [] }, isLoading: false });

      const ref = { current: null } as React.RefObject<HTMLDivElement | null>;
      render(<ActivityFeed enabled={true} deadLetterRef={ref} />);

      expect(ref.current).not.toBeNull();
    });
  });
});
