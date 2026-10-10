/**
 * @vitest-environment jsdom
 *
 * Settings › Profile › Your hours (spec `heartbeats` §3.5): the stored hours
 * read back, a bad window is refused before it is sent, and a save writes the
 * zone, the window and "away until" in one profile write.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { ProfileHoursField } from '../ui/fields/ProfileHoursField';

/** Render the card over a config whose profile is `profile`. */
function renderField(profile: Record<string, unknown>, over: Partial<Transport> = {}) {
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue({ profile }),
    updateConfig: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as Partial<Transport>);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <ProfileHoursField />
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

const STORED = {
  timezone: 'Europe/Berlin',
  // Not the 09:00–17:00 default, so a test can wait for the stored value to
  // land before it edits: a reseed after the edit would wipe it.
  workingHours: { days: [1, 2, 3, 4, 5], start: '08:30', end: '16:30' },
  away: null,
};

afterEach(cleanup);

describe('ProfileHoursField', () => {
  it('describes the setting, and nothing it does not do yet', async () => {
    renderField(STORED);
    expect(await screen.findByText('Your time zone and working hours.')).toBeInTheDocument();
    expect(screen.queryByText(/hold|deliver|wait/i)).not.toBeInTheDocument();
  });

  it('reads the stored days and times back', async () => {
    renderField({ ...STORED, workingHours: { days: [2, 4], start: '10:00', end: '14:00' } });
    await waitFor(() => expect(screen.getByLabelText('Start')).toHaveValue('10:00'));
    expect(screen.getByLabelText('End')).toHaveValue('14:00');
    expect(screen.getByRole('button', { name: 'Tuesday' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Monday' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('refuses a day that ends before it starts, without sending it', async () => {
    const transport = renderField(STORED);
    await waitFor(() => expect(screen.getByLabelText('End')).toHaveValue('16:30'));
    fireEvent.change(screen.getByLabelText('End'), { target: { value: '08:00' } });

    expect(screen.getByRole('alert')).toHaveTextContent('The day has to end after it starts.');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(transport.updateConfig).not.toHaveBeenCalled();
  });

  it('saves the zone, the window and away-until in one write', async () => {
    const transport = renderField(STORED);
    await waitFor(() => expect(screen.getByLabelText('Start')).toHaveValue('08:30'));

    await userEvent.click(screen.getByRole('button', { name: 'Friday' }));
    fireEvent.change(screen.getByLabelText('Away until'), { target: { value: '2026-10-20' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith({
        profile: {
          timezone: 'Europe/Berlin',
          workingHours: { days: [1, 2, 3, 4], start: '08:30', end: '16:30' },
          // Midnight on the 20th in Berlin, which is 22:00 UTC the day before.
          away: { until: '2026-10-19T22:00:00.000Z' },
        },
      })
    );
  });

  it('clears away-until', async () => {
    renderField({ ...STORED, away: { until: '2026-10-19T22:00:00.000Z' } });
    await waitFor(() => expect(screen.getByLabelText('Away until')).toHaveValue('2026-10-20'));
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByLabelText('Away until')).toHaveValue('');
  });
});
