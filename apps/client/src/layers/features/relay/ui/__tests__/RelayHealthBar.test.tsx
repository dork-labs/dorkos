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

import { RelayHealthBar, computeHealthState } from '../RelayHealthBar';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const defaultBudgetRejections = {
  hopLimit: 0,
  ttlExpired: 0,
  cycleDetected: 0,
  budgetExhausted: 0,
};

const mockMetrics = {
  totalMessages: 142,
  deliveredCount: 139,
  failedCount: 3,
  deadLetteredCount: 1,
  avgDeliveryLatencyMs: 45,
  p95DeliveryLatencyMs: 120,
  activeEndpoints: 2,
  budgetRejections: defaultBudgetRejections,
};

const mockMetricsNoFailures = {
  ...mockMetrics,
  failedCount: 0,
  deadLetteredCount: 0,
};

const connectedInstance = {
  id: 'tg-1',
  enabled: true,
  status: {
    id: 'tg-1',
    type: 'telegram',
    displayName: 'Telegram',
    state: 'connected',
    messageCount: { inbound: 10, outbound: 5 },
    errorCount: 0,
  },
};

const disconnectedInstance = {
  id: 'tg-2',
  enabled: true,
  status: {
    id: 'tg-2',
    type: 'telegram',
    displayName: 'Telegram 2',
    state: 'disconnected',
    messageCount: { inbound: 0, outbound: 0 },
    errorCount: 0,
  },
};

const catalogAllConnected = [
  {
    manifest: {
      type: 'telegram',
      displayName: 'Telegram',
      description: '',
      iconId: 'telegram',
      category: 'messaging',
      builtin: false,
      configFields: [],
      multiInstance: false,
    },
    instances: [connectedInstance],
  },
];

const catalogPartiallyConnected = [
  {
    manifest: {
      type: 'telegram',
      displayName: 'Telegram',
      description: '',
      iconId: 'telegram',
      category: 'messaging',
      builtin: false,
      configFields: [],
      multiInstance: false,
    },
    instances: [connectedInstance, disconnectedInstance],
  },
];

const emptyMetrics = {
  totalMessages: 0,
  deliveredCount: 0,
  failedCount: 0,
  deadLetteredCount: 0,
  avgDeliveryLatencyMs: null,
  p95DeliveryLatencyMs: null,
  activeEndpoints: 0,
  budgetRejections: defaultBudgetRejections,
};

// ---------------------------------------------------------------------------
// Helper to enable relay with data
// ---------------------------------------------------------------------------

function enableRelayWithData(
  options: { metrics?: typeof mockMetrics; catalog?: typeof catalogAllConnected } = {}
) {
  const { metrics = mockMetrics, catalog = catalogAllConnected } = options;
  mockUseRelayEnabled.mockReturnValue(true);
  mockUseDeliveryMetrics.mockReturnValue({ data: metrics, isLoading: false });
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
// Unit tests: computeHealthState
// ---------------------------------------------------------------------------

describe('computeHealthState', () => {
  it('returns healthy with "No connections configured" when total is zero', () => {
    const result = computeHealthState(emptyMetrics, 0, 0);
    expect(result.state).toBe('healthy');
    expect(result.message).toBe('No connections configured');
  });

  it('returns healthy when all adapters connected and failure rate < 5%', () => {
    const result = computeHealthState(
      { ...mockMetrics, failedCount: 2, deadLetteredCount: 0 },
      3,
      3
    );
    expect(result.state).toBe('healthy');
    expect(result.message).toBe('3 connections active');
  });

  it('uses singular "connection" when only one adapter is active', () => {
    const result = computeHealthState(mockMetricsNoFailures, 1, 1);
    expect(result.state).toBe('healthy');
    expect(result.message).toBe('1 connection active');
  });

  it('returns degraded when an adapter is disconnected', () => {
    const result = computeHealthState(mockMetricsNoFailures, 2, 3);
    expect(result.state).toBe('degraded');
    expect(result.message).toContain('1 connection disconnected');
  });

  it('uses plural "connections" when multiple adapters are disconnected', () => {
    const result = computeHealthState(mockMetricsNoFailures, 1, 3);
    expect(result.state).toBe('degraded');
    expect(result.message).toContain('2 connections disconnected');
  });

  it('returns degraded when failure rate is between 5% and 50% with all connected', () => {
    const result = computeHealthState(
      { ...mockMetrics, failedCount: 10, deadLetteredCount: 0 },
      3,
      3
    );
    expect(result.state).toBe('degraded');
    expect(result.message).toContain('10 failures in last 24h');
  });

  it('returns critical when failure rate exceeds 50%', () => {
    // 60 failed out of 100 total = 60% > 50%
    const result = computeHealthState(
      { ...mockMetrics, totalMessages: 100, failedCount: 60, deadLetteredCount: 0 },
      3,
      3
    );
    expect(result.state).toBe('critical');
    expect(result.message).toContain('60% failure rate');
    expect(result.message).toContain('60 messages failed today');
  });

  it('returns critical when zero adapters are connected', () => {
    const result = computeHealthState(emptyMetrics, 0, 3);
    expect(result.state).toBe('critical');
  });

  it('includes dead-lettered count in failure rate calculation', () => {
    // 50 failed + 10 dead-lettered = 60/100 = 60% > 50%
    const result = computeHealthState(
      { ...mockMetrics, totalMessages: 100, failedCount: 50, deadLetteredCount: 10 },
      3,
      3
    );
    expect(result.state).toBe('critical');
  });

  it('returns healthy when no messages sent and all adapters connected', () => {
    const result = computeHealthState({ ...emptyMetrics, totalMessages: 0, failedCount: 0 }, 2, 2);
    expect(result.state).toBe('healthy');
    expect(result.message).toBe('2 connections active');
  });
});

// ---------------------------------------------------------------------------
// Integration tests: RelayHealthBar component
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

  describe('healthy state', () => {
    beforeEach(() => enableRelayWithData({ metrics: mockMetricsNoFailures }));

    it('shows the healthy status message with connection count', () => {
      render(<RelayHealthBar />);
      expect(screen.getByText('1 connection active')).toBeInTheDocument();
    });

    it('shows latency alongside the status message', () => {
      render(<RelayHealthBar />);
      expect(screen.getByText('45ms')).toBeInTheDocument();
    });

    it('does not render a metrics dialog trigger button', () => {
      render(<RelayHealthBar />);
      expect(screen.queryByLabelText('Open delivery metrics')).toBeNull();
    });
  });

  describe('status dot colors', () => {
    it('shows emerald dot when healthy (all adapters connected, low failures)', () => {
      enableRelayWithData({ metrics: mockMetricsNoFailures, catalog: catalogAllConnected });
      const { container } = render(<RelayHealthBar />);
      expect(container.querySelector('.bg-emerald-500')).toBeInTheDocument();
      expect(container.querySelector('.bg-amber-500')).toBeNull();
      expect(container.querySelector('.bg-red-500')).toBeNull();
    });

    it('shows amber dot when degraded (some adapters disconnected)', () => {
      enableRelayWithData({ metrics: mockMetricsNoFailures, catalog: catalogPartiallyConnected });
      const { container } = render(<RelayHealthBar />);
      expect(container.querySelector('.bg-amber-500')).toBeInTheDocument();
      expect(container.querySelector('.bg-emerald-500')).toBeNull();
    });

    it('shows red dot when critical (failure rate > 50%)', () => {
      enableRelayWithData({
        metrics: { ...mockMetrics, totalMessages: 10, failedCount: 6, deadLetteredCount: 0 },
        catalog: catalogAllConnected,
      });
      const { container } = render(<RelayHealthBar />);
      expect(container.querySelector('.bg-red-500')).toBeInTheDocument();
      expect(container.querySelector('.bg-emerald-500')).toBeNull();
    });
  });

  describe('degraded/critical clickable status message', () => {
    it('renders status message as a clickable button when degraded and onFailedClick is provided', () => {
      enableRelayWithData({ metrics: mockMetricsNoFailures, catalog: catalogPartiallyConnected });
      const onFailedClick = vi.fn();
      render(<RelayHealthBar onFailedClick={onFailedClick} />);
      const btn = screen.getByRole('button', { name: /disconnected — click to view failures/ });
      expect(btn).toBeInTheDocument();
    });

    it('calls onFailedClick when the degraded status message is clicked', () => {
      enableRelayWithData({ metrics: mockMetricsNoFailures, catalog: catalogPartiallyConnected });
      const onFailedClick = vi.fn();
      render(<RelayHealthBar onFailedClick={onFailedClick} />);
      fireEvent.click(
        screen.getByRole('button', { name: /disconnected — click to view failures/ })
      );
      expect(onFailedClick).toHaveBeenCalledTimes(1);
    });

    it('renders status as plain text when onFailedClick is not provided', () => {
      enableRelayWithData({ metrics: mockMetricsNoFailures, catalog: catalogPartiallyConnected });
      render(<RelayHealthBar />);
      expect(screen.getByText('1 connection disconnected')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /disconnected/ })).toBeNull();
    });
  });

  describe('latency display in healthy state', () => {
    it('omits the latency separator when latency is null', () => {
      mockUseRelayEnabled.mockReturnValue(true);
      mockUseDeliveryMetrics.mockReturnValue({
        data: { ...mockMetricsNoFailures, avgDeliveryLatencyMs: null },
        isLoading: false,
      });
      mockUseAdapterCatalog.mockReturnValue({ data: catalogAllConnected, isLoading: false });
      render(<RelayHealthBar />);
      // No latency span when null
      expect(screen.queryByText('—')).toBeNull();
      expect(screen.getByText('1 connection active')).toBeInTheDocument();
    });

    it('shows <1ms for sub-millisecond latency', () => {
      mockUseRelayEnabled.mockReturnValue(true);
      mockUseDeliveryMetrics.mockReturnValue({
        data: { ...mockMetricsNoFailures, avgDeliveryLatencyMs: 0.5 },
        isLoading: false,
      });
      mockUseAdapterCatalog.mockReturnValue({ data: catalogAllConnected, isLoading: false });
      render(<RelayHealthBar />);
      expect(screen.getByText('<1ms')).toBeInTheDocument();
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
