/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ---------------------------------------------------------------------------
// Mock entity hook
// ---------------------------------------------------------------------------

const mockUseAdapterEvents = vi.fn().mockReturnValue({ data: undefined, isLoading: false });

vi.mock('@/layers/entities/relay', () => ({
  useAdapterEvents: (...args: unknown[]) => mockUseAdapterEvents(...args),
}));

import { AdapterEventLog } from '../AdapterEventLog';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const connectedEvent = {
  id: 'event-1',
  subject: 'adapter.connected',
  status: 'delivered',
  sentAt: '2026-03-11T10:00:00Z',
  metadata: JSON.stringify({
    adapterId: 'telegram-1',
    eventType: 'adapter.connected',
    message: 'Connected to relay',
  }),
};

const errorEvent = {
  id: 'event-2',
  subject: 'adapter.error',
  status: 'delivered',
  sentAt: '2026-03-11T10:01:00Z',
  metadata: JSON.stringify({
    adapterId: 'telegram-1',
    eventType: 'adapter.error',
    message: 'Connection timeout after 30s',
  }),
};

const receivedEvent = {
  id: 'event-3',
  subject: 'adapter.message_received',
  status: 'delivered',
  sentAt: '2026-03-11T10:02:00Z',
  metadata: JSON.stringify({
    adapterId: 'telegram-1',
    eventType: 'adapter.message_received',
    message: 'Received message from chat 12345',
  }),
};

const sentEvent = {
  id: 'event-4',
  subject: 'adapter.message_sent',
  status: 'delivered',
  sentAt: '2026-03-11T10:03:00Z',
  metadata: JSON.stringify({
    adapterId: 'telegram-1',
    eventType: 'adapter.message_sent',
    message: 'Sent response to chat 12345',
  }),
};

const noMetadataEvent = {
  id: 'event-5',
  subject: 'adapter.status_change',
  status: 'delivered',
  sentAt: '2026-03-11T10:04:00Z',
  metadata: null,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockUseAdapterEvents.mockReturnValue({ data: undefined, isLoading: false });
});

afterEach(cleanup);

describe('AdapterEventLog', () => {
  describe('loading state', () => {
    it('shows skeleton rows while fetching', () => {
      mockUseAdapterEvents.mockReturnValue({ data: undefined, isLoading: true });
      const { container } = render(<AdapterEventLog adapterId="telegram-1" />);
      // Skeleton elements render tasks-animated divs
      const skeletons = container.querySelectorAll('[data-slot="skeleton"]');
      expect(skeletons.length).toBe(4);
    });
  });

  describe('empty state', () => {
    it('renders empty state when no events exist', () => {
      mockUseAdapterEvents.mockReturnValue({ data: { events: [] }, isLoading: false });
      render(<AdapterEventLog adapterId="telegram-1" />);
      expect(screen.getByText('No events recorded')).toBeInTheDocument();
    });

    it('renders empty state when data has no events array', () => {
      mockUseAdapterEvents.mockReturnValue({ data: undefined, isLoading: false });
      render(<AdapterEventLog adapterId="telegram-1" />);
      // With no data, events defaults to [] which shows empty state
      expect(screen.getByText('No events recorded')).toBeInTheDocument();
    });
  });

  describe('event rendering', () => {
    it('renders events with type badge and message from metadata', () => {
      mockUseAdapterEvents.mockReturnValue({
        data: { events: [connectedEvent, errorEvent] },
        isLoading: false,
      });
      render(<AdapterEventLog adapterId="telegram-1" />);

      expect(screen.getByText('Connected to relay')).toBeInTheDocument();
      expect(screen.getByText('Connection timeout after 30s')).toBeInTheDocument();
      expect(screen.getByText('Connected')).toBeInTheDocument();
      expect(screen.getByText('Error')).toBeInTheDocument();
    });

    it('renders human-readable badge labels for all known event types', () => {
      mockUseAdapterEvents.mockReturnValue({
        data: { events: [connectedEvent, errorEvent, receivedEvent, sentEvent] },
        isLoading: false,
      });
      render(<AdapterEventLog adapterId="telegram-1" />);

      expect(screen.getByText('Connected')).toBeInTheDocument();
      expect(screen.getByText('Error')).toBeInTheDocument();
      expect(screen.getByText('Received')).toBeInTheDocument();
      expect(screen.getByText('Sent')).toBeInTheDocument();
    });

    it('falls back to event subject when metadata is null', () => {
      mockUseAdapterEvents.mockReturnValue({
        data: { events: [noMetadataEvent] },
        isLoading: false,
      });
      render(<AdapterEventLog adapterId="telegram-1" />);

      // When metadata is null, message column shows subject
      expect(screen.getByText('Status')).toBeInTheDocument();
    });

    it('shows the Events header when events exist', () => {
      mockUseAdapterEvents.mockReturnValue({
        data: { events: [connectedEvent] },
        isLoading: false,
      });
      render(<AdapterEventLog adapterId="telegram-1" />);

      expect(screen.getByText('Events')).toBeInTheDocument();
    });
  });

  describe('hook arguments', () => {
    it('passes the adapterId to the hook', () => {
      mockUseAdapterEvents.mockReturnValue({ data: { events: [] }, isLoading: false });
      render(<AdapterEventLog adapterId="telegram-1" />);
      expect(mockUseAdapterEvents).toHaveBeenCalledWith('telegram-1');
    });
  });

  describe('filter dropdown', () => {
    it('renders the filter dropdown with "All types" default', () => {
      mockUseAdapterEvents.mockReturnValue({
        data: { events: [connectedEvent, errorEvent] },
        isLoading: false,
      });
      render(<AdapterEventLog adapterId="telegram-1" />);
      expect(screen.getByText('All types')).toBeInTheDocument();
    });

    // DOR-1753: a bare `h-7` with no `responsive` prop merges under
    // SelectTrigger's default `h-11 md:h-9` and leaves `md:h-9` behind,
    // which renders SMALLER on a phone (28px) than on desktop (36px) —
    // backwards from the touch-target system's intent.
    it('keeps the filter trigger at one fixed height everywhere, no leftover md: artifact', () => {
      mockUseAdapterEvents.mockReturnValue({
        data: { events: [connectedEvent, errorEvent] },
        isLoading: false,
      });
      render(<AdapterEventLog adapterId="telegram-1" />);

      const trigger = screen.getByRole('combobox');
      expect(trigger.className).toContain('h-7');
      expect(trigger.className).not.toContain('md:h-9');
    });
  });
});
