/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { AggregatedDeadLetter } from '@dorkos/shared/transport';

// ---------------------------------------------------------------------------
// Mock entity hooks
// ---------------------------------------------------------------------------

const mockUseAggregatedDeadLetters = vi.fn().mockReturnValue({ data: [], isLoading: false });
const mockDismissMutate = vi.fn();
const mockUseDismissDeadLetterGroup = vi.fn().mockReturnValue({
  mutate: mockDismissMutate,
  isPending: false,
});

vi.mock('@/layers/entities/relay', () => ({
  useAggregatedDeadLetters: (...args: unknown[]) => mockUseAggregatedDeadLetters(...args),
  useDismissDeadLetterGroup: () => mockUseDismissDeadLetterGroup(),
}));

import { DeadLetterSection } from '../DeadLetterSection';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const hopLimitGroup: AggregatedDeadLetter = {
  source: 'slack-adapter',
  reason: 'hop_limit',
  count: 15044,
  firstSeen: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  lastSeen: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  sample: { subject: 'relay.agent.test', payload: { content: 'hello' } },
};

const ttlGroup: AggregatedDeadLetter = {
  source: 'telegram-adapter',
  reason: 'ttl_expired',
  count: 3,
  firstSeen: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  lastSeen: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
};

const budgetGroup: AggregatedDeadLetter = {
  source: 'discord-adapter',
  reason: 'budget_exhausted',
  count: 7,
  firstSeen: new Date(Date.now() - 30 * 1000).toISOString(),
  lastSeen: new Date(Date.now() - 10 * 1000).toISOString(),
  sample: { subject: 'relay.agent.budget', payload: {} },
};

const unknownReasonGroup: AggregatedDeadLetter = {
  source: 'custom-adapter',
  reason: 'some_unknown_reason',
  count: 1,
  firstSeen: new Date(Date.now() - 30 * 1000).toISOString(),
  lastSeen: new Date(Date.now() - 30 * 1000).toISOString(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockUseAggregatedDeadLetters.mockReturnValue({ data: [], isLoading: false });
  mockUseDismissDeadLetterGroup.mockReturnValue({
    mutate: mockDismissMutate,
    isPending: false,
  });
});

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DeadLetterSection', () => {
  describe('empty and loading states', () => {
    it('renders nothing when dead letters list is empty', () => {
      mockUseAggregatedDeadLetters.mockReturnValue({ data: [], isLoading: false });
      const { container } = render(<DeadLetterSection />);
      expect(container.firstChild).toBeNull();
    });

    it('renders nothing while loading', () => {
      mockUseAggregatedDeadLetters.mockReturnValue({ data: undefined, isLoading: true });
      const { container } = render(<DeadLetterSection />);
      expect(container.firstChild).toBeNull();
    });

    it('renders nothing when data is undefined and not loading', () => {
      mockUseAggregatedDeadLetters.mockReturnValue({ data: undefined, isLoading: false });
      const { container } = render(<DeadLetterSection />);
      expect(container.firstChild).toBeNull();
    });
  });

  describe('aggregated card rendering', () => {
    it('shows source name on the card', () => {
      mockUseAggregatedDeadLetters.mockReturnValue({ data: [hopLimitGroup], isLoading: false });
      render(<DeadLetterSection />);
      expect(screen.getByText('slack-adapter')).toBeInTheDocument();
    });

    it('shows the aggregated count', () => {
      mockUseAggregatedDeadLetters.mockReturnValue({ data: [hopLimitGroup], isLoading: false });
      render(<DeadLetterSection />);
      // 15044 → "15,044" with toLocaleString
      expect(screen.getByText('15,044')).toBeInTheDocument();
    });

    it('renders multiple cards for multiple groups', () => {
      mockUseAggregatedDeadLetters.mockReturnValue({
        data: [hopLimitGroup, ttlGroup],
        isLoading: false,
      });
      render(<DeadLetterSection />);
      expect(screen.getByText('slack-adapter')).toBeInTheDocument();
      expect(screen.getByText('telegram-adapter')).toBeInTheDocument();
    });
  });

  describe('rejection reason badges', () => {
    it('shows "Hop Limit" badge for hop_limit reason', () => {
      mockUseAggregatedDeadLetters.mockReturnValue({ data: [hopLimitGroup], isLoading: false });
      render(<DeadLetterSection />);
      expect(screen.getByText('Hop Limit')).toBeInTheDocument();
    });

    it('shows "TTL Expired" badge for ttl_expired reason', () => {
      mockUseAggregatedDeadLetters.mockReturnValue({ data: [ttlGroup], isLoading: false });
      render(<DeadLetterSection />);
      expect(screen.getByText('TTL Expired')).toBeInTheDocument();
    });

    it('shows "Budget Exhausted" badge for budget_exhausted reason', () => {
      mockUseAggregatedDeadLetters.mockReturnValue({ data: [budgetGroup], isLoading: false });
      render(<DeadLetterSection />);
      expect(screen.getByText('Budget Exhausted')).toBeInTheDocument();
    });

    it('shows "Unknown" badge for unrecognized reason codes', () => {
      mockUseAggregatedDeadLetters.mockReturnValue({ data: [unknownReasonGroup], isLoading: false });
      render(<DeadLetterSection />);
      expect(screen.getByText('Unknown')).toBeInTheDocument();
    });
  });

  describe('view sample action', () => {
    it('shows "View Sample" button when sample is present', () => {
      mockUseAggregatedDeadLetters.mockReturnValue({ data: [hopLimitGroup], isLoading: false });
      render(<DeadLetterSection />);
      expect(screen.getByText('View Sample')).toBeInTheDocument();
    });

    it('does not show "View Sample" button when sample is absent', () => {
      mockUseAggregatedDeadLetters.mockReturnValue({ data: [ttlGroup], isLoading: false });
      render(<DeadLetterSection />);
      expect(screen.queryByText('View Sample')).not.toBeInTheDocument();
    });

    it('opens sample dialog when "View Sample" is clicked', () => {
      mockUseAggregatedDeadLetters.mockReturnValue({ data: [hopLimitGroup], isLoading: false });
      render(<DeadLetterSection />);
      fireEvent.click(screen.getByText('View Sample'));
      expect(screen.getByText('Sample Envelope')).toBeInTheDocument();
    });
  });

  describe('dismiss action', () => {
    it('shows "Dismiss All" button on each card', () => {
      mockUseAggregatedDeadLetters.mockReturnValue({ data: [hopLimitGroup], isLoading: false });
      render(<DeadLetterSection />);
      expect(screen.getByText('Dismiss All')).toBeInTheDocument();
    });

    it('calls dismiss mutation with source and reason on click', () => {
      mockUseAggregatedDeadLetters.mockReturnValue({ data: [hopLimitGroup], isLoading: false });
      render(<DeadLetterSection />);
      fireEvent.click(screen.getByText('Dismiss All'));
      expect(mockDismissMutate).toHaveBeenCalledWith({
        source: 'slack-adapter',
        reason: 'hop_limit',
      });
    });

    it('disables dismiss button while mutation is pending', () => {
      mockUseDismissDeadLetterGroup.mockReturnValue({
        mutate: mockDismissMutate,
        isPending: true,
      });
      mockUseAggregatedDeadLetters.mockReturnValue({ data: [hopLimitGroup], isLoading: false });
      render(<DeadLetterSection />);
      expect(screen.getByText('Dismiss All').closest('button')).toBeDisabled();
    });
  });

  describe('hook arguments', () => {
    it('passes enabled=true by default', () => {
      mockUseAggregatedDeadLetters.mockReturnValue({ data: [hopLimitGroup], isLoading: false });
      render(<DeadLetterSection />);
      expect(mockUseAggregatedDeadLetters).toHaveBeenCalledWith(true);
    });

    it('passes enabled=false to the hook when disabled', () => {
      render(<DeadLetterSection enabled={false} />);
      expect(mockUseAggregatedDeadLetters).toHaveBeenCalledWith(false);
    });
  });
});
