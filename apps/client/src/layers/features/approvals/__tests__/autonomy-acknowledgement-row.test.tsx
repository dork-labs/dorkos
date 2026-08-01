/**
 * The standing Full-autonomy acknowledgement in Settings (spec `trust-dial`,
 * decision 5).
 *
 * Ticking "don't show this again" is a choice a person makes once, in a hurry,
 * in a modal they were trying to get past. So the whole promise of this row is
 * that it is findable afterwards and undoable — which is what these cases
 * check, plus the other half: that it says nothing at all before there is
 * anything to say.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ServerConfig } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';

import { TransportProvider } from '@/layers/shared/model';
import { AutonomyAcknowledgementRow } from '../ui/AutonomyAcknowledgementRow';

function setup(acknowledgedAt: string | null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const transport = createMockTransport();
  vi.mocked(transport.getConfig).mockResolvedValue({
    ui: { autonomyAcknowledgedAt: acknowledgedAt },
  } as unknown as ServerConfig);

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );

  render(<AutonomyAcknowledgementRow />, { wrapper });
  return { transport };
}

describe('AutonomyAcknowledgementRow', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it('says nothing while nobody has acknowledged anything', async () => {
    const { transport } = setup(null);
    // Waited for, not asserted at first paint: an empty row is what this renders
    // BEFORE the config arrives too, so asserting immediately would pass under
    // any behavior at all.
    await waitFor(() => expect(transport.getConfig).toHaveBeenCalled());

    expect(screen.queryByText(/full autonomy/i)).not.toBeInTheDocument();
  });

  it('shows when the acknowledgement was given', async () => {
    setup('2026-08-01T09:30:00.000Z');

    expect(await screen.findByText(/full autonomy/i)).toBeInTheDocument();
    expect(screen.getByText(/you acknowledged what this means on/i)).toBeInTheDocument();
  });

  it('clears it on Reset, so the dialog comes back', async () => {
    const { transport } = setup('2026-08-01T09:30:00.000Z');
    const user = userEvent.setup();

    await user.click(await screen.findByTestId('autonomy-ack-reset'));

    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith({
        ui: { autonomyAcknowledgedAt: null },
      })
    );
  });
});
