// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { TooltipProvider } from '@/layers/shared/ui';
import type { UsageStatus } from '@dorkos/shared/types';
import { UsageStatusItem, UsageDetail, hasRenderableUsage } from '../ui/UsageStatusItem';

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
  it('shows small amounts to the cent', () => {
    render(<UsageStatusItem usage={{ kind: 'pay-as-you-go', costUsd: 12.4 }} />, {
      wrapper: Wrapper,
    });
    expect(screen.getByText('$12.40')).toBeInTheDocument();
  });

  it('gets shorter as the amount gets bigger, so the slot never has to grow', () => {
    // A rigid item cannot truncate its way out of a figure too wide for its slot,
    // so the figure must not get wide. Bounding the character count instead was the
    // wrong instrument: a limit written for labels admitted `$99999.99` long after
    // the cluster had run out of room (DOR-461 review).
    for (const [cost, shown] of [
      [999.99, '$999.99'],
      [9999.99, '$10.0k'],
      [99999.99, '$100.0k'],
      [9999999.99, '$10.0M'],
    ] as const) {
      cleanup();
      render(<UsageStatusItem usage={{ kind: 'pay-as-you-go', costUsd: cost }} />, {
        wrapper: Wrapper,
      });
      expect(screen.getByText(shown)).toBeInTheDocument();
      expect(shown.length).toBeLessThanOrEqual(7);
    }
  });
});

describe('UsageStatusItem — a cost says which price list it came from', () => {
  // The figure itself never changes: this item is rigid because a truncated
  // amount is a different amount, so the qualifier rides the accessible name and
  // the tooltip, which cost no width.
  it('leaves a list-priced cost to stand plain', () => {
    render(
      <UsageStatusItem usage={{ kind: 'pay-as-you-go', costUsd: 0.42, costBasis: 'list' }} />,
      {
        wrapper: Wrapper,
      }
    );
    expect(screen.getByLabelText('Session cost')).toBeInTheDocument();
  });

  it('treats a cost with no stated basis as list-priced', () => {
    // Every runtime but claude-code, and claude-code before its first priced
    // request. This is what the figure already meant before the field existed.
    render(<UsageStatusItem usage={{ kind: 'pay-as-you-go', costUsd: 0.42 }} />, {
      wrapper: Wrapper,
    });
    expect(screen.getByLabelText('Session cost')).toBeInTheDocument();
  });

  it('calls a guessed cost estimated in its accessible name', () => {
    render(
      <UsageStatusItem usage={{ kind: 'pay-as-you-go', costUsd: 0.42, costBasis: 'unknown' }} />,
      { wrapper: Wrapper }
    );
    expect(screen.getByLabelText('Estimated session cost')).toBeInTheDocument();
    // The number is untouched — the qualifier is not bought with digits.
    expect(screen.getByText('$0.42')).toBeInTheDocument();
  });
});

describe('UsageStatusItem — every place a cost is named says the same thing', () => {
  // The accessible name and the heading above the figure are one rule, so a
  // screen-reader user and a sighted user are never told different things about
  // the same number.
  it('heads the detail body with the estimated wording too', () => {
    render(<UsageDetail usage={{ kind: 'pay-as-you-go', costUsd: 0.42, costBasis: 'unknown' }} />, {
      wrapper: Wrapper,
    });
    expect(screen.getByText('Estimated session cost')).toBeInTheDocument();
  });

  it('heads a list-priced detail body plainly', () => {
    render(<UsageDetail usage={{ kind: 'pay-as-you-go', costUsd: 0.42, costBasis: 'list' }} />, {
      wrapper: Wrapper,
    });
    expect(screen.getByText('Session cost')).toBeInTheDocument();
  });
});

describe('UsageDetail — the sentence beside the figure', () => {
  it('says nothing extra about a list-priced cost', () => {
    render(<UsageDetail usage={{ kind: 'pay-as-you-go', costUsd: 1.5, costBasis: 'list' }} />, {
      wrapper: Wrapper,
    });
    expect(screen.queryByText(/Estimated/)).not.toBeInTheDocument();
    expect(screen.queryByText(/organization/)).not.toBeInTheDocument();
  });

  it('warns that an unpriced model makes the figure a guess', () => {
    render(<UsageDetail usage={{ kind: 'pay-as-you-go', costUsd: 1.5, costBasis: 'unknown' }} />, {
      wrapper: Wrapper,
    });
    expect(screen.getByText('Estimated — no price was listed for this model.')).toBeInTheDocument();
  });

  it('says whose rates a managed cost was charged at, on a subscription too', () => {
    render(
      <UsageDetail
        usage={{
          kind: 'subscription',
          utilization: 0.3,
          costUsd: 1.5,
          costBasis: 'managed',
        }}
      />,
      { wrapper: Wrapper }
    );
    expect(screen.getByText("Charged at your organization's own rates.")).toBeInTheDocument();
  });

  it('says nothing when there is no figure for a basis to describe', () => {
    render(
      <UsageDetail usage={{ kind: 'subscription', utilization: 0.3, costBasis: 'unknown' }} />,
      {
        wrapper: Wrapper,
      }
    );
    expect(screen.queryByText(/Estimated/)).not.toBeInTheDocument();
  });
});
