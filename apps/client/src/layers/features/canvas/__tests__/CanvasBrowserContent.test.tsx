/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { WORKBENCH_SANDBOX_ISOLATED } from '../lib/browser-url';

// Store + transport mocks: the browser reads selectedCwd and mints signed
// serve/proxy URLs through the transport.
const mockState = { selectedCwd: '/work' as string | null };
const createServeUrl = vi.fn(async () => '/api/workbench/serve/tok/preview.html');
const createProxyUrl = vi.fn(async () => '/api/workbench/proxy/tok/');

vi.mock('@/layers/shared/model', () => {
  const useAppStore = (selector: (s: typeof mockState) => unknown) => selector(mockState);
  // Stable transport reference (the real context value is stable too) — a fresh
  // object each render would re-fire the resolve effect and double the mint.
  // Lazily built on first use so the spies are initialized by then.
  let transport: { createServeUrl: typeof createServeUrl; createProxyUrl: typeof createProxyUrl };
  return {
    useAppStore,
    useTransport: () => (transport ??= { createServeUrl, createProxyUrl }),
  };
});

import { CanvasBrowserContent } from '../ui/CanvasBrowserContent';

function iframeSrc(): string | null {
  return document.querySelector('iframe')?.getAttribute('src') ?? null;
}

beforeEach(() => {
  mockState.selectedCwd = '/work';
  createServeUrl.mockClear();
  createProxyUrl.mockClear();
});
afterEach(cleanup);

describe('CanvasBrowserContent — history navigation', () => {
  it('back/forward/reload drive the framed URL through an in-component history stack', async () => {
    render(<CanvasBrowserContent content={{ type: 'browser', url: 'https://a.test/' }} />);

    // Initial external page frames directly.
    await waitFor(() => expect(iframeSrc()).toBe('https://a.test/'));

    // Navigate to B via the address bar.
    const address = screen.getByLabelText('Address') as HTMLInputElement;
    fireEvent.change(address, { target: { value: 'https://b.test/' } });
    fireEvent.submit(address.closest('form') as HTMLFormElement);
    await waitFor(() => expect(iframeSrc()).toBe('https://b.test/'));

    // Back → A, Forward → B.
    fireEvent.click(screen.getByLabelText('Back'));
    await waitFor(() => expect(iframeSrc()).toBe('https://a.test/'));
    fireEvent.click(screen.getByLabelText('Forward'));
    await waitFor(() => expect(iframeSrc()).toBe('https://b.test/'));
  });

  it('reload re-mints the signed URL for served local content', async () => {
    render(<CanvasBrowserContent content={{ type: 'browser', url: 'preview.html' }} />);

    await waitFor(() => expect(iframeSrc()).toContain('/api/workbench/serve/'));
    expect(createServeUrl).toHaveBeenCalledTimes(1);
    expect(createServeUrl).toHaveBeenCalledWith('/work', 'preview.html');

    fireEvent.click(screen.getByLabelText('Reload'));
    await waitFor(() => expect(createServeUrl).toHaveBeenCalledTimes(2));
  });
});

describe('CanvasBrowserContent — sandbox posture', () => {
  it('renders served content WITHOUT allow-same-origin (opaque origin)', async () => {
    render(<CanvasBrowserContent content={{ type: 'browser', url: 'preview.html' }} />);

    const frame = await screen.findByTitle('Embedded browser');
    const sandbox = frame.getAttribute('sandbox') ?? '';
    expect(sandbox).not.toContain('allow-same-origin');
    expect(sandbox).toBe(WORKBENCH_SANDBOX_ISOLATED);
  });
});

describe('CanvasBrowserContent — external embed fallback', () => {
  it('always surfaces an "open in system browser" affordance for external sites', async () => {
    // XFO/frame-ancestors refusal can't be reliably detected cross-origin, so the
    // escape hatch is always present for external pages (honest by design).
    render(<CanvasBrowserContent content={{ type: 'browser', url: 'https://blocked.test/' }} />);

    await screen.findByTitle('Embedded browser');
    expect(screen.getByText(/can’t always be embedded/i)).toBeInTheDocument();
    // The escape hatch appears both in the toolbar and the external footer.
    expect(
      screen.getAllByRole('button', { name: /open in system browser/i }).length
    ).toBeGreaterThanOrEqual(1);
  });

  it('does NOT show the external fallback for served local content', async () => {
    render(<CanvasBrowserContent content={{ type: 'browser', url: 'preview.html' }} />);
    await screen.findByTitle('Embedded browser');
    expect(screen.queryByText(/can’t always be embedded/i)).not.toBeInTheDocument();
  });
});
