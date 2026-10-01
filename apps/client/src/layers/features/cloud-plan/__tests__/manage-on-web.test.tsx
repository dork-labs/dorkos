/**
 * @vitest-environment jsdom
 *
 * Managing the plan, credits and invoices on the web: the buttons ask this
 * DorkOS for a page address and send a browser window there.
 *
 * Driven by the contract package's own synthetic fixtures, so no plan name or
 * price exists in this repository for the UI to render.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, renderHook, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { CloudBillingSessionResponse } from '@dorkos/shared/cloud-schemas';
import { formatMoney } from '@dork-labs/cloud-api/display';
import entitlementsFixture from '@dork-labs/cloud-api/fixtures/v1/billing/entitlements-denominated.json' with { type: 'json' };
import hostedPageFixture from '@dork-labs/cloud-api/fixtures/v1/billing/hosted-page.json' with { type: 'json' };
import offersFixture from '@dork-labs/cloud-api/fixtures/v1/billing/offers.json' with { type: 'json' };
import refusalFixture from '@dork-labs/cloud-api/fixtures/v1/problem/entitlement-required-action.json' with { type: 'json' };
import { TransportProvider } from '@/layers/shared/model';
import { ManageOnWeb } from '../ui/ManageOnWeb';
import { useOpenBillingPage } from '../model/use-billing-page';

const mockWindowGo = vi.fn((_href: string) => true);
const mockWindowClose = vi.fn();
const mockOpenExternalLink = vi.fn((_href: string) => true);
let mockPopupBlocked = false;
const mockOpenLater = vi.fn(() =>
  mockPopupBlocked ? null : { go: mockWindowGo, close: mockWindowClose }
);
vi.mock('@/layers/shared/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/lib')>()),
  openExternalLink: (href: string) => mockOpenExternalLink(href),
  openExternalWindowLater: () => mockOpenLater(),
}));

function renderManage(transport: Transport) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <ManageOnWeb />
      </TransportProvider>
    </QueryClientProvider>
  );
}

/** A linked account with the fixture offers on sale. */
function linkedTransport(): Transport {
  const transport = createMockTransport();
  vi.mocked(transport.getCloudPlan).mockResolvedValue({
    available: true,
    entitlements: entitlementsFixture as never,
    balance: null,
  });
  vi.mocked(transport.getCloudOffers).mockResolvedValue({
    available: true,
    offers: offersFixture as never,
  });
  return transport;
}

/** A promise whose answer the test decides later. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('manage on the web', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPopupBlocked = false;
  });
  afterEach(() => cleanup());

  it('renders nothing, and asks for nothing, with no cloud account', async () => {
    const transport = createMockTransport();
    renderManage(transport);
    await waitFor(() => expect(transport.getCloudPlan).toHaveBeenCalled());
    expect(screen.queryByText(/manage on the web/i)).not.toBeInTheDocument();
    expect(transport.getCloudOffers).not.toHaveBeenCalled();
    expect(transport.createCloudBillingSession).not.toHaveBeenCalled();
  });

  it.each([
    ['Billing and invoices', 'portal'],
    ['Add credits', 'topup'],
  ])('"%s" opens the window in the press, then sends it to the address', async (label, page) => {
    const transport = linkedTransport();
    const answer = deferred<CloudBillingSessionResponse>();
    vi.mocked(transport.createCloudBillingSession).mockReturnValue(answer.promise);
    renderManage(transport);

    await userEvent.click(await screen.findByRole('button', { name: label }));
    // The window is already open before the address comes back.
    expect(mockOpenLater).toHaveBeenCalledOnce();
    expect(mockWindowGo).not.toHaveBeenCalled();
    expect(transport.createCloudBillingSession).toHaveBeenCalledWith(page, undefined);

    answer.resolve({ ok: true, url: hostedPageFixture.url });
    await waitFor(() => expect(mockWindowGo).toHaveBeenCalledWith(hostedPageFixture.url));
    expect(mockWindowClose).not.toHaveBeenCalled();
    // The address is used once and kept nowhere on screen.
    expect(document.body.innerHTML).not.toContain(hostedPageFixture.url);
  });

  it('lists the offers in the order the service sent them, with its names and prices', async () => {
    renderManage(linkedTransport());
    const list = await screen.findByRole('list');
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(offersFixture.offers.length);
    offersFixture.offers.forEach((offer, i) => {
      expect(rows[i]).toHaveTextContent(offer.displayName);
      const price = formatMoney(offer.amountMicro, offersFixture.denomination);
      expect(price).not.toBeNull();
      expect(rows[i].textContent).toContain(`${price} a ${offer.interval}`);
    });
  });

  it('sends a chosen offer to checkout by its own identifier', async () => {
    const transport = linkedTransport();
    vi.mocked(transport.createCloudBillingSession).mockResolvedValue({
      ok: true,
      url: hostedPageFixture.url,
    });
    renderManage(transport);
    const list = await screen.findByRole('list');
    const second = within(list).getAllByRole('listitem')[1];
    await userEvent.click(within(second).getByRole('button', { name: /choose/i }));
    expect(transport.createCloudBillingSession).toHaveBeenCalledWith(
      'checkout',
      offersFixture.offers[1].skuId
    );
    await waitFor(() => expect(mockWindowGo).toHaveBeenCalledWith(hostedPageFixture.url));
  });

  it('sends an account already on a plan to the billing page to change it, never to checkout', async () => {
    const transport = linkedTransport();
    // Month and year of the plan the account is on share one planId.
    vi.mocked(transport.getCloudOffers).mockResolvedValue({
      available: true,
      offers: {
        ...offersFixture,
        offers: offersFixture.offers.map((offer) => ({
          ...offer,
          planId: entitlementsFixture.planId,
        })),
      } as never,
    });
    vi.mocked(transport.createCloudBillingSession).mockResolvedValue({
      ok: true,
      url: hostedPageFixture.url,
    });
    renderManage(transport);
    await userEvent.click(await screen.findByRole('button', { name: 'Change plan' }));
    expect(transport.createCloudBillingSession).toHaveBeenCalledWith('portal', undefined);
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /choose/i })).not.toBeInTheDocument();
    for (const offer of offersFixture.offers) {
      expect(screen.queryByText(offer.displayName)).not.toBeInTheDocument();
    }
  });

  it('refreshes the plan when the person comes back from a billing page', async () => {
    const transport = linkedTransport();
    vi.mocked(transport.createCloudBillingSession).mockResolvedValue({
      ok: true,
      url: hostedPageFixture.url,
    });
    renderManage(transport);
    await userEvent.click(await screen.findByRole('button', { name: 'Add credits' }));
    await waitFor(() => expect(mockWindowGo).toHaveBeenCalled());
    const before = vi.mocked(transport.getCloudPlan).mock.calls.length;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() =>
      expect(vi.mocked(transport.getCloudPlan).mock.calls.length).toBeGreaterThan(before)
    );
    // Once: a second return does not refresh again.
    const after = vi.mocked(transport.getCloudPlan).mock.calls.length;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(vi.mocked(transport.getCloudPlan).mock.calls.length).toBe(after);
  });

  it('does not refresh on focus when no page was opened', async () => {
    const transport = linkedTransport();
    vi.mocked(transport.createCloudBillingSession).mockResolvedValue({
      ok: false,
      message: 'Adding credits isn’t available on your account yet.',
    });
    renderManage(transport);
    await userEvent.click(await screen.findByRole('button', { name: 'Add credits' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Adding credits isn’t available on your account yet.'
    );
    const before = vi.mocked(transport.getCloudPlan).mock.calls.length;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(vi.mocked(transport.getCloudPlan).mock.calls.length).toBe(before);
  });

  describe('exporting the account data', () => {
    it('says the export is being prepared, promising nothing, while it has no link', async () => {
      const transport = linkedTransport();
      vi.mocked(transport.requestCloudAccountExport).mockResolvedValue({
        ok: true,
        export: { requestedAt: '2026-09-15T12:00:00.000Z', readyAt: null, downloadUrl: null },
      });
      renderManage(transport);
      await userEvent.click(
        await screen.findByRole('button', { name: 'Export your account data' })
      );
      expect(await screen.findByRole('status')).toHaveTextContent(
        'Your export is being prepared. Try again in a few minutes to get the link.'
      );
      expect(screen.queryByText(/email/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /download/i })).not.toBeInTheDocument();

      // Asking again is how the link arrives.
      vi.mocked(transport.requestCloudAccountExport).mockResolvedValue({
        ok: true,
        export: {
          requestedAt: '2026-09-15T12:00:00.000Z',
          readyAt: '2026-09-15T12:05:00.000Z',
          downloadUrl: 'https://example.invalid/exports/exp_0001',
        },
      });
      await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(await screen.findByText('Your export is ready.')).toBeInTheDocument();
      expect(transport.requestCloudAccountExport).toHaveBeenCalledTimes(2);
    });

    it('offers the download once the export is ready, opening it only from a press', async () => {
      const transport = linkedTransport();
      const link = 'https://example.invalid/exports/exp_0001';
      vi.mocked(transport.requestCloudAccountExport).mockResolvedValue({
        ok: true,
        export: {
          requestedAt: '2026-09-15T12:00:00.000Z',
          readyAt: '2026-09-15T12:05:00.000Z',
          downloadUrl: link,
        },
      });
      renderManage(transport);
      await userEvent.click(
        await screen.findByRole('button', { name: 'Export your account data' })
      );
      expect(await screen.findByText('Your export is ready.')).toBeInTheDocument();
      expect(mockOpenExternalLink).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole('button', { name: 'Download your data' }));
      expect(mockOpenExternalLink).toHaveBeenCalledWith(link);
    });

    it('says why it could not be asked for, and lets the person try again', async () => {
      const transport = linkedTransport();
      vi.mocked(transport.requestCloudAccountExport).mockResolvedValue({
        ok: false,
        message: 'Exporting your data isn’t available on your account yet.',
      });
      renderManage(transport);
      await userEvent.click(
        await screen.findByRole('button', { name: 'Export your account data' })
      );
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Exporting your data isn’t available on your account yet.'
      );
      expect(screen.getByRole('button', { name: 'Export your account data' })).not.toBeDisabled();
    });

    it('says the account could not be reached when the request fails', async () => {
      const transport = linkedTransport();
      vi.mocked(transport.requestCloudAccountExport).mockRejectedValue(new Error('offline'));
      renderManage(transport);
      await userEvent.click(
        await screen.findByRole('button', { name: 'Export your account data' })
      );
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Couldn’t reach your DorkOS account. Try again.'
      );
    });
  });

  it('reads the offers again when a checkout is refused, and says why', async () => {
    const transport = linkedTransport();
    vi.mocked(transport.createCloudBillingSession).mockResolvedValue({
      ok: false,
      message: 'That plan isn’t available right now.',
    });
    renderManage(transport);
    const list = await screen.findByRole('list');
    const offersReads = vi.mocked(transport.getCloudOffers).mock.calls.length;
    await userEvent.click(within(list).getAllByRole('button', { name: /choose/i })[0]);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That plan isn’t available right now.'
    );
    await waitFor(() =>
      expect(vi.mocked(transport.getCloudOffers).mock.calls.length).toBeGreaterThan(offersReads)
    );
  });

  it('does not read the offers again when another page is refused', async () => {
    const transport = linkedTransport();
    vi.mocked(transport.createCloudBillingSession).mockResolvedValue({
      ok: false,
      message: 'Adding credits isn’t available on your account yet.',
    });
    renderManage(transport);
    await screen.findByRole('list');
    const offersReads = vi.mocked(transport.getCloudOffers).mock.calls.length;
    await userEvent.click(screen.getByRole('button', { name: 'Add credits' }));
    await screen.findByRole('alert');
    await new Promise((r) => setTimeout(r, 20));
    expect(vi.mocked(transport.getCloudOffers).mock.calls.length).toBe(offersReads);
  });

  it('shows a refusal in the service`s own words and closes the waiting window', async () => {
    const transport = linkedTransport();
    vi.mocked(transport.createCloudBillingSession).mockResolvedValue({
      ok: false,
      problem: refusalFixture as never,
    });
    renderManage(transport);
    await userEvent.click(await screen.findByRole('button', { name: 'Billing and invoices' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(refusalFixture.title);
    expect(alert).toHaveTextContent(refusalFixture.detail);
    expect(mockWindowClose).toHaveBeenCalledOnce();
    expect(mockWindowGo).not.toHaveBeenCalled();

    await userEvent.click(within(alert).getByRole('button', { name: refusalFixture.actionLabel }));
    expect(mockOpenExternalLink).toHaveBeenCalledWith(refusalFixture.actionUrl);
  });

  it('says plainly when the account could not be reached', async () => {
    const transport = linkedTransport();
    vi.mocked(transport.createCloudBillingSession).mockRejectedValue(new Error('offline'));
    renderManage(transport);
    await userEvent.click(await screen.findByRole('button', { name: 'Add credits' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t reach your DorkOS account. Try again.'
    );
    expect(mockWindowClose).toHaveBeenCalledOnce();
  });

  it('passes on the local server`s own sentence when it could not ask', async () => {
    const transport = linkedTransport();
    vi.mocked(transport.createCloudBillingSession).mockResolvedValue({
      ok: false,
      message: 'This instance is not linked to a DorkOS account.',
    });
    renderManage(transport);
    await userEvent.click(await screen.findByRole('button', { name: 'Add credits' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This instance is not linked to a DorkOS account.'
    );
  });

  it('asks for no page when the browser blocks the window, and says how to fix it', async () => {
    mockPopupBlocked = true;
    const transport = linkedTransport();
    renderManage(transport);
    await userEvent.click(await screen.findByRole('button', { name: 'Billing and invoices' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/allow pop-ups/i);
    expect(transport.createCloudBillingSession).not.toHaveBeenCalled();
  });

  it('opens one page at a time', async () => {
    const transport = linkedTransport();
    const answer = deferred<CloudBillingSessionResponse>();
    vi.mocked(transport.createCloudBillingSession).mockReturnValue(answer.promise);
    renderManage(transport);
    await userEvent.click(await screen.findByRole('button', { name: 'Billing and invoices' }));
    expect(screen.getByRole('button', { name: /add credits/i })).toBeDisabled();
    answer.resolve({ ok: true, url: hostedPageFixture.url });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add credits' })).not.toBeDisabled()
    );
    expect(transport.createCloudBillingSession).toHaveBeenCalledOnce();
  });

  it('ignores a second press made before the first one re-rendered', async () => {
    const transport = linkedTransport();
    const answer = deferred<CloudBillingSessionResponse>();
    vi.mocked(transport.createCloudBillingSession).mockReturnValue(answer.promise);
    const queryClient = new QueryClient();
    const { result } = renderHook(() => useOpenBillingPage(), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>{children}</TransportProvider>
        </QueryClientProvider>
      ),
    });
    act(() => {
      // The same `open` twice, as two presses inside one render would call it.
      result.current.open({ page: 'portal' });
      result.current.open({ page: 'topup' });
    });
    expect(mockOpenLater).toHaveBeenCalledOnce();
    expect(transport.createCloudBillingSession).toHaveBeenCalledOnce();
    await act(async () => answer.resolve({ ok: true, url: hostedPageFixture.url }));
    expect(result.current.pending).toBeNull();
  });
});
