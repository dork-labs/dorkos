// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createMockAccountUsage } from '@dorkos/test-utils';
import { UsageRevealPopover } from '../ui/UsageRevealPopover';

beforeAll(() => {
  // Radix Popover positioning touches these in jsdom.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(cleanup);

describe('UsageRevealPopover (DOR-109 /context)', () => {
  it('shows the honest empty state when the session has no usage yet', () => {
    // A cold session (e.g. Codex before any turn) has no usage — never a blank popover.
    render(<UsageRevealPopover usage={null} open onOpenChange={vi.fn()} />);
    expect(screen.getByText('No usage data for this session yet.')).toBeInTheDocument();
  });

  it('shows the honest empty state when usage carries no renderable metric', () => {
    render(<UsageRevealPopover usage={{ kind: 'pay-as-you-go' }} open onOpenChange={vi.fn()} />);
    expect(screen.getByText('No usage data for this session yet.')).toBeInTheDocument();
  });

  it('reveals the usage & cost detail when the session has usage', () => {
    render(
      <UsageRevealPopover
        usage={{ kind: 'subscription', utilization: 0.5, costUsd: 0.42 }}
        open
        onOpenChange={vi.fn()}
      />
    );
    expect(screen.getByText('Subscription usage')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText('$0.42')).toBeInTheDocument();
  });

  it('renders nothing while closed', () => {
    render(<UsageRevealPopover usage={null} open={false} onOpenChange={vi.fn()} />);
    expect(screen.queryByText('No usage data for this session yet.')).not.toBeInTheDocument();
  });
});

describe('UsageRevealPopover — the account windows (spec claude-account-ui §6.8)', () => {
  const NOW = new Date('2026-09-28T12:00:00.000Z');
  const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
  const account = createMockAccountUsage({
    windows: [
      {
        key: 'five_hour',
        label: '5-hour window',
        usedPct: 0,
        resetsAt: minutesAgo(5),
        status: null,
        expired: true,
        observedAt: minutesAgo(30),
        source: 'sdk_event',
      },
      {
        key: 'seven_day',
        label: 'Weekly',
        usedPct: 72,
        resetsAt: null,
        status: 'allowed',
        expired: false,
        observedAt: minutesAgo(12),
        source: 'sdk_event',
      },
      {
        key: 'seven_day_opus',
        label: 'Weekly Opus',
        usedPct: null,
        resetsAt: null,
        status: null,
        expired: false,
        observedAt: minutesAgo(1),
        source: 'sdk_event',
      },
    ],
  });

  it('lists every readable window, an expired one as "reset", and says how fresh they are', () => {
    render(
      <UsageRevealPopover
        usage={{ kind: 'subscription', utilization: 0.72 }}
        accountUsage={account}
        open
        onOpenChange={vi.fn()}
        now={NOW}
      />
    );
    expect(screen.getByRole('img', { name: 'This week 72% used' })).toBeInTheDocument();
    // The window whose reset passed: an empty bar that says so, never its old share.
    expect(screen.getByRole('img', { name: '5-hour reset' })).toBeInTheDocument();
    expect(screen.getByText('reset')).toBeInTheDocument();
    // No reading, no row: nothing is drawn as 0%.
    expect(screen.queryByText(/Weekly Opus/)).not.toBeInTheDocument();
    // The newest reading SHOWN dates the popover, not the unreadable one.
    expect(screen.getByText('as of 12 min ago')).toBeInTheDocument();
  });

  it('keeps the cost worded as it is everywhere else under the bars', () => {
    render(
      <UsageRevealPopover
        usage={{
          kind: 'subscription',
          utilization: 1,
          state: 'exhausted',
          costUsd: 1.5,
          costBasis: 'unknown',
          detail: 'Using overage capacity',
        }}
        accountUsage={account}
        open
        onOpenChange={vi.fn()}
        now={NOW}
      />
    );
    expect(screen.getByText('Estimated session cost')).toBeInTheDocument();
    expect(screen.getByText('Estimated — no price was listed for this model.')).toBeInTheDocument();
    expect(screen.getByText('Using overage capacity')).toBeInTheDocument();
    expect(screen.getByText('Rate limit reached')).toBeInTheDocument();
  });

  it('reads "just now" for a reading under a minute old', () => {
    render(
      <UsageRevealPopover
        usage={{ kind: 'pay-as-you-go', costUsd: 0.42 }}
        observedAt={new Date(NOW.getTime() - 20_000).toISOString()}
        open
        onOpenChange={vi.fn()}
        now={NOW}
      />
    );
    expect(screen.getByText('just now')).toBeInTheDocument();
  });

  it('says nothing about freshness when the time is unknown', () => {
    render(
      <UsageRevealPopover
        usage={{ kind: 'pay-as-you-go', costUsd: 0.42 }}
        open
        onOpenChange={vi.fn()}
        now={NOW}
      />
    );
    expect(screen.queryByText(/as of|just now/)).not.toBeInTheDocument();
  });
});
