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

    // Navigate to B via the address bar (click to enter edit mode first).
    fireEvent.click(screen.getByRole('button', { name: 'Address' }));
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

describe('CanvasBrowserContent — url content type routes here (DOR-233)', () => {
  it('renders navigation chrome for a `url` document', async () => {
    render(<CanvasBrowserContent content={{ type: 'url', url: 'https://a.test/' }} />);
    expect(screen.getByLabelText('Back')).toBeInTheDocument();
    expect(screen.getByLabelText('Forward')).toBeInTheDocument();
    expect(screen.getByLabelText('Reload')).toBeInTheDocument();
    expect(screen.getByLabelText('Address')).toBeInTheDocument();
    await waitFor(() => expect(iframeSrc()).toBe('https://a.test/'));
  });

  it('refuses a blocked protocol (javascript:) — no frame', async () => {
    render(<CanvasBrowserContent content={{ type: 'url', url: 'javascript:alert(1)' }} />);
    expect(screen.getByText(/can’t be displayed for security reasons/i)).toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();
  });
});

describe('CanvasBrowserContent — address bar (at rest)', () => {
  it('simplifies an external URL: scheme stripped, host emphasized, path dimmed', () => {
    render(
      <CanvasBrowserContent
        content={{ type: 'browser', url: 'https://www.example.com/docs?x=1' }}
      />
    );
    const bar = screen.getByRole('button', { name: 'Address' });
    // Scheme + leading www. stripped from the visible text.
    expect(bar.textContent).toBe('example.com/docs?x=1');
    const host = bar.querySelector('.text-foreground');
    const rest = bar.querySelector('.text-muted-foreground');
    expect(host?.textContent).toBe('example.com');
    expect(rest?.textContent).toBe('/docs?x=1');
  });

  it('shows a local file as its logical path behind a "local" chip — never the token URL', async () => {
    render(<CanvasBrowserContent content={{ type: 'browser', url: 'preview.html' }} />);
    const bar = screen.getByRole('button', { name: 'Address' });
    expect(bar.textContent).toContain('local');
    expect(bar.textContent).toContain('preview.html');

    // The signed token URL is what the iframe loads — it must NEVER surface in
    // the address bar.
    await waitFor(() => expect(iframeSrc()).toContain('/api/workbench/serve/'));
    expect(bar.textContent).not.toContain('/api/workbench');
    expect(bar.textContent).not.toContain('tok');
  });
});

describe('CanvasBrowserContent — address bar (editing)', () => {
  it('focus reveals the full logical URL and selects all', () => {
    render(<CanvasBrowserContent content={{ type: 'browser', url: 'https://example.com/docs' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Address' }));
    const input = screen.getByLabelText('Address') as HTMLInputElement;
    expect(input.value).toBe('https://example.com/docs');
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('https://example.com/docs'.length);
  });

  it('Enter navigates to the typed address', async () => {
    render(<CanvasBrowserContent content={{ type: 'browser', url: 'https://a.test/' }} />);
    await waitFor(() => expect(iframeSrc()).toBe('https://a.test/'));

    fireEvent.click(screen.getByRole('button', { name: 'Address' }));
    const input = screen.getByLabelText('Address') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://c.test/' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    await waitFor(() => expect(iframeSrc()).toBe('https://c.test/'));
  });

  it('normalizes a bare host on Enter (adds a scheme)', async () => {
    render(<CanvasBrowserContent content={{ type: 'browser', url: 'https://a.test/' }} />);
    await waitFor(() => expect(iframeSrc()).toBe('https://a.test/'));

    fireEvent.click(screen.getByRole('button', { name: 'Address' }));
    const input = screen.getByLabelText('Address') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'example.com' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    await waitFor(() => expect(iframeSrc()).toBe('https://example.com'));
  });

  it('Escape reverts without navigating', async () => {
    render(<CanvasBrowserContent content={{ type: 'browser', url: 'https://a.test/' }} />);
    await waitFor(() => expect(iframeSrc()).toBe('https://a.test/'));

    fireEvent.click(screen.getByRole('button', { name: 'Address' }));
    const input = screen.getByLabelText('Address') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://evil.test/' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    // Back to the at-rest display showing the original host; URL unchanged.
    const bar = screen.getByRole('button', { name: 'Address' });
    expect(bar.textContent).toBe('a.test');
    expect(iframeSrc()).toBe('https://a.test/');
  });

  it('blur reverts without navigating', async () => {
    render(<CanvasBrowserContent content={{ type: 'browser', url: 'https://a.test/' }} />);
    await waitFor(() => expect(iframeSrc()).toBe('https://a.test/'));

    fireEvent.click(screen.getByRole('button', { name: 'Address' }));
    const input = screen.getByLabelText('Address') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://evil.test/' } });
    fireEvent.blur(input);

    expect(screen.getByRole('button', { name: 'Address' })).toBeInTheDocument();
    expect(iframeSrc()).toBe('https://a.test/');
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
