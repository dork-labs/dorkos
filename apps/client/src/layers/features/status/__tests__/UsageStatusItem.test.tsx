// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { TooltipProvider } from '@/layers/shared/ui';
import { UsageStatusItem, hasRenderableUsage } from '../ui/UsageStatusItem';

afterEach(cleanup);

beforeAll(() => {
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

function Wrapper({ children }: { children: React.ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>;
}

describe('UsageStatusItem', () => {
  it('renders utilization percent as primary for a subscription', () => {
    render(
      <UsageStatusItem
        usage={{ kind: 'subscription', utilization: 0.47, windowLabel: '5-hour window' }}
      />,
      { wrapper: Wrapper }
    );
    expect(screen.getByText('47%')).toBeInTheDocument();
    expect(screen.getByLabelText('Subscription usage')).toBeInTheDocument();
  });

  it('flags high utilization amber (>= 80%) and exhausted red', () => {
    const { rerender } = render(
      <UsageStatusItem usage={{ kind: 'subscription', utilization: 0.85 }} />,
      { wrapper: Wrapper }
    );
    expect(screen.getByLabelText('Subscription usage').className).toContain('text-amber-500');

    rerender(
      <UsageStatusItem usage={{ kind: 'subscription', utilization: 1, state: 'exhausted' }} />
    );
    expect(screen.getByLabelText('Subscription usage').className).toContain('text-red-500');
  });

  it('degrades a subscription with no utilization to its cost figure', () => {
    render(<UsageStatusItem usage={{ kind: 'subscription', costUsd: 0.42 }} />, {
      wrapper: Wrapper,
    });
    expect(screen.getByText('$0.42')).toBeInTheDocument();
    expect(screen.queryByLabelText('Subscription usage')).not.toBeInTheDocument();
  });

  it('renders cost as primary for pay-as-you-go', () => {
    render(<UsageStatusItem usage={{ kind: 'pay-as-you-go', costUsd: 1.5 }} />, {
      wrapper: Wrapper,
    });
    expect(screen.getByText('$1.50')).toBeInTheDocument();
    expect(screen.getByLabelText('Session cost')).toBeInTheDocument();
  });

  it('renders nothing when a pay-as-you-go usage has no cost', () => {
    const { container } = render(<UsageStatusItem usage={{ kind: 'pay-as-you-go' }} />, {
      wrapper: Wrapper,
    });
    expect(container.textContent).toBe('');
  });
});

describe('hasRenderableUsage', () => {
  it('is true for a subscription with utilization or cost', () => {
    expect(hasRenderableUsage({ kind: 'subscription', utilization: 0.1 })).toBe(true);
    expect(hasRenderableUsage({ kind: 'subscription', costUsd: 0.1 })).toBe(true);
  });

  it('is false for a subscription with neither utilization nor cost', () => {
    expect(hasRenderableUsage({ kind: 'subscription' })).toBe(false);
  });

  it('gates pay-as-you-go on cost presence', () => {
    expect(hasRenderableUsage({ kind: 'pay-as-you-go', costUsd: 0 })).toBe(true);
    expect(hasRenderableUsage({ kind: 'pay-as-you-go' })).toBe(false);
  });
});
