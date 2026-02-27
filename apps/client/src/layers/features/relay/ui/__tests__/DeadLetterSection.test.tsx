/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ---------------------------------------------------------------------------
// Mock entity hook
// ---------------------------------------------------------------------------

const mockUseDeadLetters = vi.fn().mockReturnValue({ data: [], isLoading: false });

vi.mock('@/layers/entities/relay', () => ({
  useDeadLetters: (...args: unknown[]) => mockUseDeadLetters(...args),
}));

import { DeadLetterSection } from '../DeadLetterSection';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const deadLetter1 = {
  messageId: 'msg-abc-123',
  endpointHash: 'endpoint-hash-1',
  reason: 'hop_limit',
  envelope: { subject: 'relay.agent.test', payload: { key: 'value' } },
  failedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 min ago
};

const deadLetter2 = {
  messageId: 'msg-def-456',
  endpointHash: 'endpoint-hash-2',
  reason: 'ttl_expired',
  envelope: { subject: 'relay.agent.other', payload: {} },
  failedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
};

const deadLetterBudget = {
  messageId: 'msg-ghi-789',
  endpointHash: 'endpoint-hash-3',
  reason: 'budget_exhausted',
  envelope: { subject: 'relay.agent.budget', payload: {} },
  failedAt: new Date(Date.now() - 10 * 1000).toISOString(), // 10s ago
};

const deadLetterUnknown = {
  messageId: 'msg-jkl-000',
  endpointHash: 'endpoint-hash-4',
  reason: 'some_unknown_reason',
  envelope: {},
  failedAt: new Date(Date.now() - 30 * 1000).toISOString(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockUseDeadLetters.mockReturnValue({ data: [], isLoading: false });
});

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DeadLetterSection', () => {
  describe('empty and loading states', () => {
    it('renders nothing when dead letters list is empty', () => {
      mockUseDeadLetters.mockReturnValue({ data: [], isLoading: false });
      const { container } = render(<DeadLetterSection />);
      expect(container.firstChild).toBeNull();
    });

    it('renders nothing while loading', () => {
      mockUseDeadLetters.mockReturnValue({ data: undefined, isLoading: true });
      const { container } = render(<DeadLetterSection />);
      expect(container.firstChild).toBeNull();
    });

    it('renders nothing when data is undefined and not loading', () => {
      mockUseDeadLetters.mockReturnValue({ data: undefined, isLoading: false });
      const { container } = render(<DeadLetterSection />);
      expect(container.firstChild).toBeNull();
    });
  });

  describe('header rendering', () => {
    beforeEach(() => {
      mockUseDeadLetters.mockReturnValue({ data: [deadLetter1, deadLetter2], isLoading: false });
    });

    it('shows the Dead Letters header when items exist', () => {
      render(<DeadLetterSection />);
      expect(screen.getByText('Dead Letters')).toBeInTheDocument();
    });

    it('shows the count badge with the correct number', () => {
      render(<DeadLetterSection />);
      expect(screen.getByText('2')).toBeInTheDocument();
    });

    it('shows count of 1 when there is a single dead letter', () => {
      mockUseDeadLetters.mockReturnValue({ data: [deadLetter1], isLoading: false });
      render(<DeadLetterSection />);
      expect(screen.getByText('1')).toBeInTheDocument();
    });
  });

  describe('collapsible behavior', () => {
    beforeEach(() => {
      mockUseDeadLetters.mockReturnValue({ data: [deadLetter1, deadLetter2], isLoading: false });
    });

    it('starts collapsed — does not show message IDs', () => {
      render(<DeadLetterSection />);
      expect(screen.queryByText('msg-abc-123')).not.toBeInTheDocument();
      expect(screen.queryByText('msg-def-456')).not.toBeInTheDocument();
    });

    it('expands to show rows when header is clicked', () => {
      render(<DeadLetterSection />);
      fireEvent.click(screen.getByText('Dead Letters'));
      expect(screen.getByText('msg-abc-123')).toBeInTheDocument();
      expect(screen.getByText('msg-def-456')).toBeInTheDocument();
    });

    it('collapses again when header is clicked a second time', () => {
      render(<DeadLetterSection />);
      fireEvent.click(screen.getByText('Dead Letters'));
      expect(screen.getByText('msg-abc-123')).toBeInTheDocument();
      fireEvent.click(screen.getByText('Dead Letters'));
      expect(screen.queryByText('msg-abc-123')).not.toBeInTheDocument();
    });

    it('header button has aria-expanded=false when collapsed', () => {
      render(<DeadLetterSection />);
      const button = screen.getByRole('button', { name: /Dead Letters/ });
      expect(button).toHaveAttribute('aria-expanded', 'false');
    });

    it('header button has aria-expanded=true when expanded', () => {
      render(<DeadLetterSection />);
      const button = screen.getByRole('button', { name: /Dead Letters/ });
      fireEvent.click(button);
      expect(button).toHaveAttribute('aria-expanded', 'true');
    });
  });

  describe('dead letter row content', () => {
    beforeEach(() => {
      mockUseDeadLetters.mockReturnValue({ data: [deadLetter1], isLoading: false });
    });

    it('shows message ID in the row', () => {
      render(<DeadLetterSection />);
      fireEvent.click(screen.getByText('Dead Letters'));
      expect(screen.getByText('msg-abc-123')).toBeInTheDocument();
    });

    it('shows a relative time for failedAt', () => {
      render(<DeadLetterSection />);
      fireEvent.click(screen.getByText('Dead Letters'));
      // 5 minutes ago → "5m ago"
      expect(screen.getByText('5m ago')).toBeInTheDocument();
    });

    it('expands a row to reveal envelope and endpoint hash', () => {
      render(<DeadLetterSection />);
      fireEvent.click(screen.getByText('Dead Letters'));
      // Row button = the message ID row
      fireEvent.click(screen.getByText('msg-abc-123'));
      expect(screen.getByText('Envelope')).toBeInTheDocument();
      expect(screen.getByText('endpoint-hash-1')).toBeInTheDocument();
    });

    it('collapses a row when clicked again', () => {
      render(<DeadLetterSection />);
      fireEvent.click(screen.getByText('Dead Letters'));
      fireEvent.click(screen.getByText('msg-abc-123'));
      expect(screen.getByText('Envelope')).toBeInTheDocument();
      fireEvent.click(screen.getByText('msg-abc-123'));
      expect(screen.queryByText('Envelope')).not.toBeInTheDocument();
    });
  });

  describe('rejection reason badges', () => {
    it('shows "Hop Limit" badge for hop_limit reason', () => {
      mockUseDeadLetters.mockReturnValue({ data: [deadLetter1], isLoading: false });
      render(<DeadLetterSection />);
      fireEvent.click(screen.getByText('Dead Letters'));
      expect(screen.getByText('Hop Limit')).toBeInTheDocument();
    });

    it('shows "TTL Expired" badge for ttl_expired reason', () => {
      mockUseDeadLetters.mockReturnValue({ data: [deadLetter2], isLoading: false });
      render(<DeadLetterSection />);
      fireEvent.click(screen.getByText('Dead Letters'));
      expect(screen.getByText('TTL Expired')).toBeInTheDocument();
    });

    it('shows "Budget Exhausted" badge for budget_exhausted reason', () => {
      mockUseDeadLetters.mockReturnValue({ data: [deadLetterBudget], isLoading: false });
      render(<DeadLetterSection />);
      fireEvent.click(screen.getByText('Dead Letters'));
      expect(screen.getByText('Budget Exhausted')).toBeInTheDocument();
    });

    it('shows "Unknown" badge for unrecognized reason codes', () => {
      mockUseDeadLetters.mockReturnValue({ data: [deadLetterUnknown], isLoading: false });
      render(<DeadLetterSection />);
      fireEvent.click(screen.getByText('Dead Letters'));
      expect(screen.getByText('Unknown')).toBeInTheDocument();
    });
  });

  describe('hook arguments', () => {
    it('passes no filters when no endpointHash is provided', () => {
      mockUseDeadLetters.mockReturnValue({ data: [deadLetter1], isLoading: false });
      render(<DeadLetterSection />);
      expect(mockUseDeadLetters).toHaveBeenCalledWith(undefined, true);
    });

    it('passes endpointHash filter when provided', () => {
      mockUseDeadLetters.mockReturnValue({ data: [deadLetter1], isLoading: false });
      render(<DeadLetterSection endpointHash="endpoint-hash-1" />);
      expect(mockUseDeadLetters).toHaveBeenCalledWith({ endpointHash: 'endpoint-hash-1' }, true);
    });

    it('passes enabled=false to the hook when disabled', () => {
      render(<DeadLetterSection enabled={false} />);
      expect(mockUseDeadLetters).toHaveBeenCalledWith(undefined, false);
    });
  });
});
