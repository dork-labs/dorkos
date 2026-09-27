/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { createMockAccountUsage } from '@dorkos/test-utils';
import type { AccountWindow } from '@/layers/shared/lib/claude-accounts';
import { UsageBar, UsageMiniBars } from '../usage-bar';
import { TooltipProvider } from '../tooltip';

afterEach(cleanup);

const [FIVE_HOUR, WEEK] = createMockAccountUsage().windows as [AccountWindow, AccountWindow];

/** A weekly window resetting Sunday 9am local time, read on the Wednesday before. */
const NOW = new Date(2026, 8, 30, 12, 0);
const SUNDAY_9AM = new Date(2026, 9, 4, 9, 0).toISOString();

function at(usedPct: number | null, status: AccountWindow['status'] = 'allowed'): AccountWindow {
  return { ...WEEK, usedPct, status, resetsAt: SUNDAY_9AM };
}

function renderWith(node: React.ReactNode) {
  return render(<TooltipProvider>{node}</TooltipProvider>);
}

describe('UsageMiniBars', () => {
  it('reads both windows as one sentence', () => {
    renderWith(<UsageMiniBars fiveHour={FIVE_HOUR} week={WEEK} />);
    expect(
      screen.getByRole('img', { name: '5-hour window 40% used, weekly 72% used' })
    ).toBeInTheDocument();
  });

  it.each([
    [69, 'allowed', 'success'],
    [70, 'allowed', 'warning'],
    [100, 'allowed', 'error'],
    [30, 'rejected', 'error'],
  ] as const)('draws %s%% (%s) in the %s tone', (pct, status, tone) => {
    const { container } = renderWith(<UsageMiniBars fiveHour={at(pct, status)} week={null} />);
    const tracks = container.querySelectorAll('[data-slot="usage-track"]');
    expect(tracks[0]).toHaveAttribute('data-tone', tone);
  });

  it.each([
    ['no share reported', at(null, null)],
    ['no window at all', null],
  ])('says unknown and draws no fill with %s', (_case, week) => {
    const { container } = renderWith(<UsageMiniBars fiveHour={null} week={week} />);
    expect(
      screen.getByRole('img', {
        name: '5-hour window usage unknown, weekly usage unknown',
      })
    ).toBeInTheDocument();
    const tracks = container.querySelectorAll('[data-slot="usage-track"]');
    expect(tracks).toHaveLength(2);
    for (const track of tracks) expect(track).toHaveAttribute('data-tone', 'unknown');
    expect(container.querySelector('[data-slot="usage-fill"]')).toBeNull();
  });
});

describe('UsageBar', () => {
  it('shows the share and the reset beside the label, and reads them as a sentence', () => {
    renderWith(<UsageBar window={at(72)} label="This week" now={NOW} />);
    expect(
      screen.getByRole('img', { name: 'This week 72% used, resets Sun 9am' })
    ).toBeInTheDocument();
    expect(screen.getByText('72% · resets Sun 9am')).toBeInTheDocument();
  });

  it('leaves the reset out when asked to or when it is unknown', () => {
    renderWith(
      <>
        <UsageBar window={at(40)} label="5-hour window" showReset={false} now={NOW} />
        <UsageBar window={{ ...at(55), resetsAt: null }} label="This week" now={NOW} />
      </>
    );
    expect(screen.getByRole('img', { name: '5-hour window 40% used' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'This week 55% used' })).toBeInTheDocument();
  });

  it.each([
    [69, 'allowed', 'success'],
    [70, 'allowed', 'warning'],
    [100, 'allowed', 'error'],
    [30, 'rejected', 'error'],
  ] as const)('draws %s%% (%s) in the %s tone', (pct, status, tone) => {
    renderWith(<UsageBar window={at(pct, status)} label="This week" now={NOW} />);
    expect(screen.getByRole('img')).toHaveAttribute('data-tone', tone);
  });

  it.each([
    ['no share reported', at(null, null)],
    ['no window at all', null],
  ])('says unknown and draws no fill with %s', (_case, entry) => {
    const { container } = renderWith(<UsageBar window={entry} label="This week" now={NOW} />);
    const bar = screen.getByRole('img', { name: 'This week usage unknown' });
    expect(bar).toHaveAttribute('data-tone', 'unknown');
    expect(within(bar).getByText('unknown')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="usage-fill"]')).toBeNull();
  });

  it('puts the share and reset in the bar’s tooltip in the compact form', async () => {
    renderWith(<UsageBar window={at(72)} label="This week" compact now={NOW} />);
    expect(screen.queryByText('72% · resets Sun 9am')).toBeNull();
    const bar = screen.getByRole('img', { name: 'This week 72% used, resets Sun 9am' });
    expect(bar).not.toHaveAttribute('tabindex');
    await userEvent.hover(bar);
    expect(await screen.findByRole('tooltip')).toHaveTextContent('72% · resets Sun 9am');
  });

  it.each([
    ['no share reported', at(null, null)],
    ['no window at all', null],
  ])('says unknown in words in the compact form with %s', (_case, entry) => {
    const { container } = renderWith(
      <UsageBar window={entry} label="This week" compact now={NOW} />
    );
    const bar = screen.getByRole('img', { name: 'This week usage unknown' });
    expect(within(bar).getByText('unknown')).toBeVisible();
    expect(container.querySelector('[data-slot="usage-track"]')).toHaveAttribute(
      'data-tone',
      'unknown'
    );
    expect(container.querySelector('[data-slot="usage-fill"]')).toBeNull();
  });
});
