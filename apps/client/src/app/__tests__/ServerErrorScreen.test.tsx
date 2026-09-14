// @vitest-environment jsdom
/**
 * The screen the window shows when the config read was ANSWERED and the answer
 * was an error (DOR-2035).
 *
 * Its sibling suite covers the same ground for `ServerUnreachableScreen`, and
 * the overlap is the point rather than a copy: the two screens share
 * `BootBlockedScreen`, so the promises the frame makes — it keeps asking, the
 * button asks now, the raw failure stays off the page — have to hold on both.
 * A frame change that only one suite drives is a frame change half checked.
 *
 * What is only true here: the status is named, because it is the one fact worth
 * repeating to whoever helps next, and a host refusal shows the server's own
 * words instead, because those say what to do about it.
 *
 * @module app/__tests__/ServerErrorScreen
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { ServerErrorScreen } from '../ServerErrorScreen';

/** The headline this screen renders, whatever the status. */
const HEADLINE = 'The server answered with an error';

/** The other screen's headline, which this one must never borrow. */
const UNREACHABLE_HEADLINE = 'DorkOS can’t reach its server';

/** The frame's retry cadence, as a literal — see `BootBlockedScreen`. */
const RETRY_INTERVAL_MS = 5000;

let transport: Transport;

function renderScreen(props: { status: number; message?: string; code?: string }) {
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
  return render(<ServerErrorScreen {...props} />, { wrapper: Wrapper });
}

beforeEach(() => {
  transport = createMockTransport();
  vi.mocked(transport.getConfig).mockRejectedValue(
    Object.assign(new Error('Internal Server Error'), { status: 500 })
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ServerErrorScreen', () => {
  it('says what happened and names the status', async () => {
    renderScreen({ status: 500, message: 'Internal Server Error' });

    expect(await screen.findByText(HEADLINE)).toBeInTheDocument();
    expect(screen.getByText(/got an error back \(HTTP 500\)/)).toBeInTheDocument();
    // Not the other screen's claim: something replied, so nothing here may say
    // the server is absent or still starting.
    expect(screen.queryByText(UNREACHABLE_HEADLINE)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/starting up|not running|is down/i);
  });

  it('claims only that a reply came back, not that DorkOS sent it', async () => {
    // Remote Access runs through an ngrok tunnel, and a tunnel edge whose origin
    // is dead answers 502 itself. On the phone that is a genuinely unreachable
    // server behind a healthy proxy, so "DorkOS is running" would be false.
    renderScreen({ status: 502 });
    await screen.findByText(HEADLINE);

    expect(screen.getByText(/got an error back \(HTTP 502\)/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/DorkOS is running/i);
  });

  it('leaves the raw failure off the page, as the frame promises', async () => {
    renderScreen({ status: 500, message: 'Internal Server Error' });
    await screen.findByText(HEADLINE);

    // TanStack clears a dataless query's error on every retry, so a line
    // printed from it would blink off the page each time this screen does the
    // asking it promises. The console and the boot sentinel keep the detail.
    expect(screen.queryByText('Internal Server Error')).not.toBeInTheDocument();
  });

  it('shows a host refusal in the server’s own words', async () => {
    // The one refusal whose message is written for the person reading it: it
    // names the address and the two ways out, which "(HTTP 403)" does not.
    const refusal =
      'This instance does not answer to the address "phone.ngrok.app". ' +
      'If that is how you reach DorkOS, list it in DORKOS_TRUSTED_HOSTS, or turn on login.';
    renderScreen({ status: 403, message: refusal, code: 'HOST_NOT_ALLOWED' });

    expect(await screen.findByText(refusal)).toBeInTheDocument();
  });

  it('shows nobody else’s words, whatever status they arrive under', async () => {
    // A proxy, a captive portal or a CDN answers 403 with its own body. Keyed
    // on the status, this screen would have printed a stranger's text
    // full-screen in DorkOS chrome — inert, but a page that looks like it is
    // speaking for the product. The `code` is what only this server sets.
    renderScreen({
      status: 403,
      message: 'Access denied by CorpProxy. Sign in at portal.example.com to continue.',
    });

    expect(await screen.findByText(/got an error back \(HTTP 403\)/)).toBeInTheDocument();
    expect(screen.queryByText(/CorpProxy/)).not.toBeInTheDocument();
  });

  it('clamps even its own refusal, which carries a hostname it was handed', async () => {
    // A hostname can be 253 characters, so the message has no fixed length and
    // a full window of text is not more honest than a clamped one. The part
    // that says what to do comes first.
    const long = `This instance does not answer to the address "${'a'.repeat(253)}". Set DORKOS_TRUSTED_HOSTS.`;
    renderScreen({ status: 403, message: long, code: 'HOST_NOT_ALLOWED' });
    await screen.findByText(HEADLINE);

    expect(screen.queryByText(long)).not.toBeInTheDocument();
    const shown = screen.getByText(/^This instance does not answer/);
    expect(shown.textContent?.length).toBeLessThanOrEqual(241);
    expect(shown.textContent?.endsWith('…')).toBe(true);
  });

  it('asks again when the button is pressed', async () => {
    const user = userEvent.setup();
    renderScreen({ status: 500 });
    await screen.findByText(HEADLINE);
    await waitFor(() => expect(transport.getConfig).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    await waitFor(() => expect(transport.getConfig).toHaveBeenCalledTimes(2));
  });

  it('keeps asking on its own, with nobody touching the page', async () => {
    vi.useFakeTimers();
    renderScreen({ status: 500 });
    await vi.waitFor(() => expect(transport.getConfig).toHaveBeenCalledTimes(1));

    // Two intervals, one after the other: a single extra call could be a
    // straggler from mount, two on a cadence is a loop.
    await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS);
    await vi.waitFor(() => expect(transport.getConfig).toHaveBeenCalledTimes(2));

    await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS);
    await vi.waitFor(() => expect(transport.getConfig).toHaveBeenCalledTimes(3));
  });
});
