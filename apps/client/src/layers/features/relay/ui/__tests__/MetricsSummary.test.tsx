/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const mockUseDeliveryMetrics = vi.fn();

vi.mock('@/layers/entities/relay', () => ({
  useDeliveryMetrics: (...args: unknown[]) => mockUseDeliveryMetrics(...args),
}));

import { MetricsSummary } from '../MetricsSummary';

const metrics = {
  totalMessages: 20,
  deliveredCount: 12,
  failedCount: 3,
  noSubscriberCount: 5,
  deadLetteredCount: 2,
  avgDeliveryLatencyMs: 45,
  p50DeliveryLatencyMs: 30,
  p95DeliveryLatencyMs: 120,
  p99DeliveryLatencyMs: 180,
  activeEndpoints: 2,
  budgetRejections: { hopLimit: 0, ttlExpired: 0, cycleDetected: 0, budgetExhausted: 0 },
};

beforeEach(() => {
  mockUseDeliveryMetrics.mockReturnValue({ data: metrics });
});

afterEach(cleanup);

describe('MetricsSummary', () => {
  it('renders nothing when the relay is off or metrics have not loaded', () => {
    const { container: off } = render(<MetricsSummary enabled={false} />);
    expect(off).toBeEmptyDOMElement();

    mockUseDeliveryMetrics.mockReturnValue({ data: undefined });
    const { container: loading } = render(<MetricsSummary enabled />);
    expect(loading).toBeEmptyDOMElement();
  });

  // Messages nothing was listening for used to be counted as failures, so a
  // machine doing nothing wrong showed a wall of red (DOR-789).
  it('counts messages nobody listened for apart from failures', () => {
    render(<MetricsSummary enabled />);

    const noListener = screen.getByText('No listener').parentElement;
    expect(noListener).toHaveTextContent('5');

    const failed = screen.getByText('Failed').parentElement;
    expect(failed).toHaveTextContent('3');
  });

  it('does not colour the no-listener count as a problem', () => {
    render(<MetricsSummary enabled />);

    const value = screen.getByText('No listener').parentElement?.querySelector('span:last-child');
    expect(value).not.toHaveClass('text-red-600');
    expect(value).not.toHaveClass('text-amber-600');
  });

  it('shows every headline count and the average latency', () => {
    render(<MetricsSummary enabled />);

    for (const label of ['Total', 'Delivered', 'Failed', 'No listener', 'Never arrived']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText('Never arrived').parentElement).toHaveTextContent('2');
    expect(screen.getByText('45ms')).toBeInTheDocument();
  });
});
