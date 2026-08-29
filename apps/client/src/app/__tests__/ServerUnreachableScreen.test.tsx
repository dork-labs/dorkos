// @vitest-environment jsdom
/**
 * The screen the window shows when `GET /api/config` will not answer (DOR-1475).
 *
 * What it has to be, beyond legible: honest about the retrying it claims to do.
 * The copy says "DorkOS keeps checking", so this suite watches the clock go by
 * with nobody touching the page and asserts the request actually goes out
 * again — a screen that said that and then sat still would be a lie in the
 * product's own voice.
 *
 * @module app/__tests__/ServerUnreachableScreen
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { ServerUnreachableScreen } from '../ServerUnreachableScreen';

/** The headline, spelled with the typographic apostrophe the component renders. */
const HEADLINE = 'DorkOS can’t reach its server.';

/** The screen's own retry cadence, as a literal — see the module's note. */
const RETRY_INTERVAL_MS = 5000;

let transport: Transport;

function renderScreen() {
  const queryClient = new QueryClient({
    // One attempt per fetch, so "how many times did it ask" counts asks and not
    // TanStack's internal retries.
    defaultOptions: { queries: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  return render(<ServerUnreachableScreen />, { wrapper: Wrapper });
}

beforeEach(() => {
  transport = createMockTransport();
  vi.mocked(transport.getConfig).mockRejectedValue(new Error('Failed to fetch'));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ServerUnreachableScreen', () => {
  it('says what is wrong, in the product voice', async () => {
    renderScreen();

    expect(await screen.findByText(HEADLINE)).toBeInTheDocument();
    expect(
      screen.getByText(/It may still be starting up\. DorkOS keeps checking/)
    ).toBeInTheDocument();
    // And not the raw failure, which TanStack clears on every retry anyway —
    // see the component's own note on why this screen leaves it to the console.
    expect(screen.queryByText('Failed to fetch')).not.toBeInTheDocument();
  });

  it('blames no network — the desktop app runs the server it cannot reach', async () => {
    renderScreen();
    await screen.findByText(HEADLINE);

    // The screen is the same one in the browser, the desktop shell and the
    // phone; in the desktop shell the server is a child process of this very
    // window, so anything about the user's connection would be wrong there.
    expect(document.body.textContent).not.toMatch(/network|wi-?fi|internet|offline/i);
  });

  it('asks again when the button is pressed', async () => {
    const user = userEvent.setup();
    renderScreen();
    await screen.findByText(HEADLINE);
    await waitFor(() => expect(transport.getConfig).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(transport.getConfig).toHaveBeenCalledTimes(2));
  });

  it('keeps asking on its own, with nobody touching the page', async () => {
    vi.useFakeTimers();
    renderScreen();
    await vi.waitFor(() => expect(transport.getConfig).toHaveBeenCalledTimes(1));

    // Two intervals, one after the other: a single extra call could be a
    // straggler from mount, two on a cadence is a loop.
    await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS);
    await vi.waitFor(() => expect(transport.getConfig).toHaveBeenCalledTimes(2));

    await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS);
    await vi.waitFor(() => expect(transport.getConfig).toHaveBeenCalledTimes(3));
  });

  it('does not ask before the interval is up — the poll is calm, not tight', async () => {
    vi.useFakeTimers();
    renderScreen();
    await vi.waitFor(() => expect(transport.getConfig).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS - 500);

    expect(transport.getConfig).toHaveBeenCalledTimes(1);
  });
});
