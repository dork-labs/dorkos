// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { TooltipProvider } from '@/layers/shared/ui';
import { STATUS_VALUE_MAX_CHARS } from '@dorkos/shared/constants';
import type { UsageStatus } from '@dorkos/shared/types';
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

describe('UsageStatusItem — the figure never abbreviates', () => {
  /** Every render branch, each keyed by what it puts on the line. */
  const branches: [string, UsageStatus, string][] = [
    [
      'subscription utilization',
      { kind: 'subscription', utilization: 0.78, state: 'warning' },
      '78%',
    ],
    ['cost with no detail', { kind: 'pay-as-you-go', costUsd: 12.4 }, '$12.40'],
    [
      'cost with a detail tooltip',
      { kind: 'pay-as-you-go', costUsd: 12.4, detail: 'billed hourly' },
      '$12.40',
    ],
  ];

  for (const [name, usage, figure] of branches) {
    it(`keeps its pixels and never truncates — ${name}`, () => {
      // All three branches shipped `shrink-0` with no `truncate` and nothing beside
      // the number able to give way, so a squeezed row drew the item outside its own
      // box and over its neighbour (DOR-461 review). The registry now marks the item
      // rigid so the row cannot squeeze it; `shrink-0` says the same thing one level
      // down. What must never appear is a `truncate` — `$12.4…` is a different
      // amount, not the same one in fewer letters.
      const { container } = render(<UsageStatusItem usage={usage} />, { wrapper: Wrapper });
      const value = screen.getByText(figure);
      expect(value.className).not.toContain('truncate');
      expect(container.querySelector('[class*="truncate"]')).toBeNull();
      expect(container.firstElementChild?.className).toContain('shrink-0');
    });
  }
});

describe('UsageStatusItem — the one value with no upper bound', () => {
  it('draws a cost that fits the bound every other value is held to', () => {
    render(<UsageStatusItem usage={{ kind: 'pay-as-you-go', costUsd: 99999.99 }} />, {
      wrapper: Wrapper,
    });
    expect(screen.getByText('$99999.99')).toBeInTheDocument();
  });

  it('steps aside instead of drawing a figure too long for a slot', () => {
    // Every other value in the line is a percent, a small count, or a name held to
    // `STATUS_VALUE_MAX_CHARS`. A cost has no ceiling, and a rigid item cannot
    // truncate its way out of one — so it renders nothing and the amount lands on
    // the `⋯`, still exact. `selectPromotedItems` drops a null node, and a pin is
    // what makes this reachable: it bypasses `promote` entirely (DOR-461 review).
    const { container } = render(
      <UsageStatusItem usage={{ kind: 'pay-as-you-go', costUsd: 12345678901.99 }} />,
      { wrapper: Wrapper }
    );
    expect(`$${(12345678901.99).toFixed(2)}`.length).toBeGreaterThan(STATUS_VALUE_MAX_CHARS);
    expect(container).toBeEmptyDOMElement();
  });
});
