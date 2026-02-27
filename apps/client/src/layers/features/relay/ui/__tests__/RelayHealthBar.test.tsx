/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ---------------------------------------------------------------------------
// Mock entity hooks
// ---------------------------------------------------------------------------

const mockUseRelayEnabled = vi.fn().mockReturnValue(false);
const mockUseDeliveryMetrics = vi.fn().mockReturnValue({ data: undefined, isLoading: false });
const mockUseAdapterCatalog = vi.fn().mockReturnValue({ data: [], isLoading: false });

vi.mock('@/layers/entities/relay', () => ({
  useRelayEnabled: (...args: unknown[]) => mockUseRelayEnabled(...args),
  useDeliveryMetrics: (...args: unknown[]) => mockUseDeliveryMetrics(...args),
  useAdapterCatalog: (...args: unknown[]) => mockUseAdapterCatalog(...args),
}));

// Mock DeliveryMetricsDashboard to avoid deep render dependencies
vi.mock('../DeliveryMetrics', () => ({
  DeliveryMetricsDashboard: () => <div data-testid="delivery-metrics-dashboard" />,
}));

import { RelayHealthBar } from '../RelayHealthBar';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockMetrics = {
  totalMessages: 142,
  deliveredCount: 139,
  failedCount: 3,
  deadLetteredCount: 1,
  avgDeliveryLatencyMs: 45,
  p95DeliveryLatencyMs: 120,
  activeEndpoints: 2,
  budgetRejections: {
    hopLimit: 0,
    ttlExpired: 0,
    cycleDetected: 0,
    budgetExhausted: 0,
  },
};

const mockMetricsNoFailures = {
  ...mockMetrics,
  failedCount: 0,
  deadLetteredCount: 0,
};

const connectedInstance = {
  id: 'tg-1',
  enabled: true,
  status: { id: 'tg-1', type: 'telegram', displayName: 'Telegram', state: 'connected', messageCount: { inbound: 10, outbound: 5 }, errorCount: 0 },
};

const disconnectedInstance = {
  id: 'tg-2',
  enabled: true,
  status: { id: 'tg-2', type: 'telegram', displayName: 'Telegram 2', state: 'disconnected', messageCount: { inbound: 0, outbound: 0 }, errorCount: 0 },
};

const catalogAllConnected = [
  { manifest: { type: 'telegram', displayName: 'Telegram', description: '', iconEmoji: '📨', category: 'messaging', builtin: false, configFields: [], multiInstance: false }, instances: [connectedInstance] },
];

const catalogPartiallyConnected = [
  { manifest: { type: 'telegram', displayName: 'Telegram', description: '', iconEmoji: '📨', category: 'messaging', builtin: false, configFields: [], multiInstance: false }, instances: [connectedInstance, disconnectedInstance] },
];

// ---------------------------------------------------------------------------
// Helper to enable relay with data
// ---------------------------------------------------------------------------

function enableRelayWithData(options: { failedCount?: number; catalog?: typeof catalogAllConnected } = {}) {
  const { failedCount = 3, catalog = catalogAllConnected } = options;
  mockUseRelayEnabled.mockReturnValue(true);
  mockUseDeliveryMetrics.mockReturnValue({
    data: failedCount === 0 ? mockMetricsNoFailures : mockMetrics,
    isLoading: false,
  });
  mockUseAdapterCatalog.mockReturnValue({ data: catalog, isLoading: false });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseRelayEnabled.mockReturnValue(false);
  mockUseDeliveryMetrics.mockReturnValue({ data: undefined, isLoading: false });
  mockUseAdapterCatalog.mockReturnValue({ data: [], isLoading: false });
});

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RelayHealthBar', () => {
  describe('renders null when conditions are not met', () => {
    it('renders null when relay is disabled', () => {
      mockUseRelayEnabled.mockReturnValue(false);
      mockUseDeliveryMetrics.mockReturnValue({ data: mockMetrics, isLoading: false });
      mockUseAdapterCatalog.mockReturnValue({ data: catalogAllConnected, isLoading: false });
      const { container } = render(<RelayHealthBar />);
      expect(container.firstChild).toBeNull();
    });

    it('renders null when enabled prop is false', () => {
      enableRelayWithData();
      const { container } = render(<RelayHealthBar enabled={false} />);
      expect(container.firstChild).toBeNull();
    });

    it('renders null while metrics are loading', () => {
      mockUseRelayEnabled.mockReturnValue(true);
      mockUseDeliveryMetrics.mockReturnValue({ data: undefined, isLoading: true });
      mockUseAdapterCatalog.mockReturnValue({ data: catalogAllConnected, isLoading: false });
      const { container } = render(<RelayHealthBar />);
      expect(container.firstChild).toBeNull();
    });

    it('renders null while catalog is loading', () => {
      mockUseRelayEnabled.mockReturnValue(true);
      mockUseDeliveryMetrics.mockReturnValue({ data: mockMetrics, isLoading: false });
      mockUseAdapterCatalog.mockReturnValue({ data: [], isLoading: true });
      const { container } = render(<RelayHealthBar />);
      expect(container.firstChild).toBeNull();
    });

    it('renders null when metrics data is absent', () => {
      mockUseRelayEnabled.mockReturnValue(true);
      mockUseDeliveryMetrics.mockReturnValue({ data: undefined, isLoading: false });
      mockUseAdapterCatalog.mockReturnValue({ data: catalogAllConnected, isLoading: false });
      const { container } = render(<RelayHealthBar />);
      expect(container.firstChild).toBeNull();
    });
  });

  describe('renders health summary when relay is enabled with data', () => {
    beforeEach(() => enableRelayWithData());

    it('shows total messages', () => {
      render(<RelayHealthBar />);
      expect(screen.getByText('142 today')).toBeInTheDocument();
    });

    it('shows failed count', () => {
      render(<RelayHealthBar />);
      expect(screen.getByText('3 failed')).toBeInTheDocument();
    });

    it('shows adapter connectivity', () => {
      render(<RelayHealthBar />);
      expect(screen.getByText('1/1 connected')).toBeInTheDocument();
    });

    it('shows average latency', () => {
      render(<RelayHealthBar />);
      expect(screen.getByText('45ms avg')).toBeInTheDocument();
    });

    it('renders the metrics button', () => {
      render(<RelayHealthBar />);
      expect(screen.getByLabelText('Open delivery metrics')).toBeInTheDocument();
    });
  });

  describe('adapter connectivity dot color', () => {
    it('shows green dot when all adapters are connected', () => {
      enableRelayWithData({ catalog: catalogAllConnected });
      const { container } = render(<RelayHealthBar />);
      expect(container.querySelector('.bg-green-500')).toBeInTheDocument();
      expect(container.querySelector('.bg-amber-500')).toBeNull();
    });

    it('shows amber dot when some adapters are disconnected', () => {
      enableRelayWithData({ catalog: catalogPartiallyConnected });
      const { container } = render(<RelayHealthBar />);
      expect(container.querySelector('.bg-amber-500')).toBeInTheDocument();
      expect(container.querySelector('.bg-green-500')).toBeNull();
    });
  });

  describe('failure count interaction', () => {
    it('renders failure count as a clickable button when failures exist', () => {
      enableRelayWithData({ failedCount: 3 });
      render(<RelayHealthBar />);
      const btn = screen.getByLabelText('3 failed messages — click to view');
      expect(btn).toBeInTheDocument();
      expect(btn.tagName).toBe('BUTTON');
    });

    it('renders failure count as plain text when zero failures', () => {
      enableRelayWithData({ failedCount: 0 });
      render(<RelayHealthBar />);
      expect(screen.queryByLabelText(/failed messages/)).toBeNull();
      expect(screen.getByText('0 failed')).toBeInTheDocument();
    });

    it('calls onFailedClick when failure count button is clicked', () => {
      enableRelayWithData({ failedCount: 3 });
      const onFailedClick = vi.fn();
      render(<RelayHealthBar onFailedClick={onFailedClick} />);
      fireEvent.click(screen.getByLabelText('3 failed messages — click to view'));
      expect(onFailedClick).toHaveBeenCalledTimes(1);
    });
  });

  describe('latency display', () => {
    it('shows em-dash when latency is null', () => {
      mockUseRelayEnabled.mockReturnValue(true);
      mockUseDeliveryMetrics.mockReturnValue({
        data: { ...mockMetrics, avgDeliveryLatencyMs: null },
        isLoading: false,
      });
      mockUseAdapterCatalog.mockReturnValue({ data: catalogAllConnected, isLoading: false });
      render(<RelayHealthBar />);
      expect(screen.getByText('— avg')).toBeInTheDocument();
    });

    it('shows <1ms for sub-millisecond latency', () => {
      mockUseRelayEnabled.mockReturnValue(true);
      mockUseDeliveryMetrics.mockReturnValue({
        data: { ...mockMetrics, avgDeliveryLatencyMs: 0.5 },
        isLoading: false,
      });
      mockUseAdapterCatalog.mockReturnValue({ data: catalogAllConnected, isLoading: false });
      render(<RelayHealthBar />);
      expect(screen.getByText('<1ms avg')).toBeInTheDocument();
    });
  });

  describe('metrics dialog', () => {
    it('opens the metrics dialog when the chart button is clicked', () => {
      enableRelayWithData();
      render(<RelayHealthBar />);

      fireEvent.click(screen.getByLabelText('Open delivery metrics'));

      expect(screen.getByText('Delivery Metrics')).toBeInTheDocument();
      expect(screen.getByTestId('delivery-metrics-dashboard')).toBeInTheDocument();
    });
  });

  describe('passes enabled flag to useAdapterCatalog', () => {
    it('passes combined enabled state to the catalog hook', () => {
      mockUseRelayEnabled.mockReturnValue(true);
      mockUseDeliveryMetrics.mockReturnValue({ data: mockMetrics, isLoading: false });
      mockUseAdapterCatalog.mockReturnValue({ data: catalogAllConnected, isLoading: false });

      render(<RelayHealthBar enabled={true} />);
      expect(mockUseAdapterCatalog).toHaveBeenCalledWith(true);
    });

    it('passes false to catalog hook when enabled prop is false', () => {
      mockUseRelayEnabled.mockReturnValue(true);
      mockUseDeliveryMetrics.mockReturnValue({ data: mockMetrics, isLoading: false });
      mockUseAdapterCatalog.mockReturnValue({ data: catalogAllConnected, isLoading: false });

      render(<RelayHealthBar enabled={false} />);
      expect(mockUseAdapterCatalog).toHaveBeenCalledWith(false);
    });
  });
});
