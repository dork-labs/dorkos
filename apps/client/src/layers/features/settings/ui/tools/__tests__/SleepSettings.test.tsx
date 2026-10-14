/**
 * @vitest-environment jsdom
 */
/**
 * The Sleep card: the switch reflects the server's setting, writes only the one
 * key it changes, and is disabled with the reason on a computer that cannot be
 * held awake (but not on a refusal, which is retried).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import type { KeepAwakeStatus } from '@dorkos/shared/schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { SleepSettings } from '../SleepSettings';

afterEach(cleanup);

const status = (overrides: Partial<KeepAwakeStatus>): KeepAwakeStatus => ({
  enabled: true,
  supported: true,
  reason: null,
  asserted: false,
  working: { chats: 0, rooms: 0, tasks: 0, waking: false },
  wake: { enabled: false, setup: 'unsupported', nextWakeAt: null, setupCommand: null },
  ...overrides,
});

function renderWith(answer: KeepAwakeStatus) {
  const transport = createMockTransport();
  vi.mocked(transport.getKeepAwake).mockResolvedValue(answer);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <SleepSettings />
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

const toggle = () =>
  screen.findByRole('switch', { name: 'Keep this computer awake while agents work' });

describe('SleepSettings', () => {
  it('shows the setting as the server reports it, with the caveat', async () => {
    renderWith(status({ enabled: true }));
    expect(await toggle()).toBeChecked();
    expect(screen.getByTestId('sleep-settings-note')).toHaveTextContent(
      'Closing the lid usually still sleeps. The screen still turns off and locks.'
    );
  });

  it('writes only keepAwake.whileAgentsWork, and re-reads the status', async () => {
    const transport = renderWith(status({ enabled: true }));
    fireEvent.click(await toggle());
    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith({
        keepAwake: { whileAgentsWork: false },
      })
    );
    await waitFor(() => expect(transport.getKeepAwake).toHaveBeenCalledTimes(2));
  });

  it.each([
    ['container', 'Not available in a container.'],
    ['tool-missing', 'Not available: this computer has no sleep control tool.'],
  ] as const)('is disabled and says why when %s', async (reason, line) => {
    renderWith(status({ supported: false, reason }));
    expect(await toggle()).toBeDisabled();
    expect(screen.getByTestId('sleep-settings-note')).toHaveTextContent(line);
  });

  it('says so on a refusal but keeps the switch, which retries when turned off and on', async () => {
    // Purpose: a passing refusal must never grey the switch until a restart.
    renderWith(status({ supported: false, reason: 'denied' }));
    expect(await toggle()).toBeEnabled();
    expect(screen.getByTestId('sleep-settings-note')).toHaveTextContent(
      'This computer refused to stay awake. Trying again shortly.'
    );
  });

  it('offers no switch for waking the computer yet', async () => {
    renderWith(status({}));
    await toggle();
    expect(screen.queryByText(/Wake for scheduled tasks/)).not.toBeInTheDocument();
  });
});
