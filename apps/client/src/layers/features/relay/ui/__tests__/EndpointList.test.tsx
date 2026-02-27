/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ---------------------------------------------------------------------------
// Mock entity hooks
// ---------------------------------------------------------------------------

const mockUseRelayEndpoints = vi.fn();

vi.mock('@/layers/entities/relay', () => ({
  useRelayEndpoints: (...args: unknown[]) => mockUseRelayEndpoints(...args),
}));

import { EndpointList } from '../EndpointList';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeEndpoint = (overrides: Record<string, unknown> = {}) => ({
  subject: 'relay.system.test',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockUseRelayEndpoints.mockReturnValue({ data: [], isLoading: false });
});

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EndpointList', () => {
  describe('loading state', () => {
    it('shows skeleton placeholders while loading', () => {
      mockUseRelayEndpoints.mockReturnValue({ data: [], isLoading: true });
      const { container } = render(<EndpointList enabled={true} />);
      expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    });

    it('does not render endpoint subjects while loading', () => {
      mockUseRelayEndpoints.mockReturnValue({ data: [], isLoading: true });
      render(<EndpointList enabled={true} />);
      expect(screen.queryByText('relay.system.test')).not.toBeInTheDocument();
    });
  });

  describe('empty state', () => {
    it('shows empty state when no endpoints are registered', () => {
      mockUseRelayEndpoints.mockReturnValue({ data: [], isLoading: false });
      render(<EndpointList enabled={true} />);
      expect(screen.getByText('No endpoints registered')).toBeInTheDocument();
    });

    it('shows helper text in empty state', () => {
      mockUseRelayEndpoints.mockReturnValue({ data: [], isLoading: false });
      render(<EndpointList enabled={true} />);
      expect(
        screen.getByText(
          'Endpoints are created automatically when adapters subscribe to message subjects.',
        ),
      ).toBeInTheDocument();
    });
  });

  describe('endpoint card rendering', () => {
    it('renders endpoint subjects in monospace', () => {
      mockUseRelayEndpoints.mockReturnValue({
        data: [makeEndpoint({ subject: 'relay.agent.session-1' })],
        isLoading: false,
      });
      render(<EndpointList enabled={true} />);
      const subject = screen.getByText('relay.agent.session-1');
      expect(subject).toBeInTheDocument();
      expect(subject.className).toMatch(/font-mono/);
    });

    it('renders the Inbox icon for each endpoint', () => {
      mockUseRelayEndpoints.mockReturnValue({
        data: [makeEndpoint()],
        isLoading: false,
      });
      const { container } = render(<EndpointList enabled={true} />);
      // Lucide icons render as SVG elements
      expect(container.querySelector('svg')).toBeInTheDocument();
    });

    it('renders multiple endpoint cards', () => {
      mockUseRelayEndpoints.mockReturnValue({
        data: [
          makeEndpoint({ subject: 'relay.agent.one' }),
          makeEndpoint({ subject: 'relay.agent.two' }),
        ],
        isLoading: false,
      });
      render(<EndpointList enabled={true} />);
      expect(screen.getByText('relay.agent.one')).toBeInTheDocument();
      expect(screen.getByText('relay.agent.two')).toBeInTheDocument();
    });
  });

  describe('health dot', () => {
    it('shows a green health dot for healthy status', () => {
      mockUseRelayEndpoints.mockReturnValue({
        data: [makeEndpoint({ status: 'healthy' })],
        isLoading: false,
      });
      const { container } = render(<EndpointList enabled={true} />);
      expect(container.querySelector('.bg-green-500')).toBeInTheDocument();
    });

    it('shows a green health dot when no status is provided (defaults to healthy)', () => {
      mockUseRelayEndpoints.mockReturnValue({
        data: [makeEndpoint()],
        isLoading: false,
      });
      const { container } = render(<EndpointList enabled={true} />);
      expect(container.querySelector('.bg-green-500')).toBeInTheDocument();
    });

    it('shows a red health dot for error status', () => {
      mockUseRelayEndpoints.mockReturnValue({
        data: [makeEndpoint({ status: 'error' })],
        isLoading: false,
      });
      const { container } = render(<EndpointList enabled={true} />);
      expect(container.querySelector('.bg-red-500')).toBeInTheDocument();
    });

    it('shows an amber health dot for degraded status', () => {
      mockUseRelayEndpoints.mockReturnValue({
        data: [makeEndpoint({ status: 'degraded' })],
        isLoading: false,
      });
      const { container } = render(<EndpointList enabled={true} />);
      expect(container.querySelector('.bg-amber-500')).toBeInTheDocument();
    });
  });

  describe('message count', () => {
    it('displays message count when available', () => {
      mockUseRelayEndpoints.mockReturnValue({
        data: [makeEndpoint({ messageCount: 42 })],
        isLoading: false,
      });
      render(<EndpointList enabled={true} />);
      expect(screen.getByText('42 messages')).toBeInTheDocument();
    });

    it('hides message count when not available', () => {
      mockUseRelayEndpoints.mockReturnValue({
        data: [makeEndpoint()],
        isLoading: false,
      });
      render(<EndpointList enabled={true} />);
      expect(screen.queryByText(/messages/)).not.toBeInTheDocument();
    });

    it('shows zero message count when explicitly set to 0', () => {
      mockUseRelayEndpoints.mockReturnValue({
        data: [makeEndpoint({ messageCount: 0 })],
        isLoading: false,
      });
      render(<EndpointList enabled={true} />);
      expect(screen.getByText('0 messages')).toBeInTheDocument();
    });
  });

  describe('last activity timestamp', () => {
    it('shows relative time for last activity', () => {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      mockUseRelayEndpoints.mockReturnValue({
        data: [makeEndpoint({ lastActivity: fiveMinutesAgo })],
        isLoading: false,
      });
      render(<EndpointList enabled={true} />);
      expect(screen.getByText('5m ago')).toBeInTheDocument();
    });

    it('hides last activity when not available', () => {
      mockUseRelayEndpoints.mockReturnValue({
        data: [makeEndpoint()],
        isLoading: false,
      });
      render(<EndpointList enabled={true} />);
      expect(screen.queryByText(/ago/)).not.toBeInTheDocument();
    });

    it('shows seconds for very recent activity', () => {
      const thirtySecondsAgo = new Date(Date.now() - 30 * 1000).toISOString();
      mockUseRelayEndpoints.mockReturnValue({
        data: [makeEndpoint({ lastActivity: thirtySecondsAgo })],
        isLoading: false,
      });
      render(<EndpointList enabled={true} />);
      expect(screen.getByText('30s ago')).toBeInTheDocument();
    });
  });

  describe('description', () => {
    it('shows description when available', () => {
      mockUseRelayEndpoints.mockReturnValue({
        data: [makeEndpoint({ description: 'Handles incoming agent messages' })],
        isLoading: false,
      });
      render(<EndpointList enabled={true} />);
      expect(screen.getByText('Handles incoming agent messages')).toBeInTheDocument();
    });

    it('hides description when not available', () => {
      mockUseRelayEndpoints.mockReturnValue({
        data: [makeEndpoint()],
        isLoading: false,
      });
      render(<EndpointList enabled={true} />);
      // No extra paragraph text beyond the subject should appear
      expect(screen.queryByText(/Handles/)).not.toBeInTheDocument();
    });
  });

  describe('onSelectEndpoint callback', () => {
    it('calls onSelectEndpoint with the subject when a card is clicked', () => {
      const onSelect = vi.fn();
      mockUseRelayEndpoints.mockReturnValue({
        data: [makeEndpoint({ subject: 'relay.agent.click-me' })],
        isLoading: false,
      });
      render(<EndpointList enabled={true} onSelectEndpoint={onSelect} />);
      screen.getByText('relay.agent.click-me').closest('button')?.click();
      expect(onSelect).toHaveBeenCalledWith('relay.agent.click-me');
    });
  });
});
