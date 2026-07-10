/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { WORKBENCH_SANDBOX_ISOLATED } from '../lib/browser-url';

/** Mirror of the store's BrowserHistoryState (the real type comes from the mocked module). */
interface BrowserHistoryEntry {
  contentUrl: string;
  stack: string[];
  cursor: number;
}

// Store + transport mocks: the browser reads selectedCwd, mints signed
// serve/proxy URLs through the transport, and reads/writes per-document browser
// history (DOR-252). `browserHistories` + `writeBrowserHistory` model the store
// round-trip so a remount can restore a stack (guard-on-removal lives in the
// real store and is covered by the store unit tests).
const mockState = {
  selectedCwd: '/work' as string | null,
  browserHistories: {} as Record<string, BrowserHistoryEntry>,
  writeBrowserHistory: vi.fn((documentId: string, entry: BrowserHistoryEntry) => {
    mockState.browserHistories[documentId] = entry;
  }),
};
const createServeUrl = vi.fn(async () => '/api/workbench/serve/tok/preview.html');
const createProxyUrl = vi.fn(async () => '/api/workbench/proxy/tok/');

vi.mock('@/layers/shared/model', () => {
  const useAppStore = (selector: (s: typeof mockState) => unknown) => selector(mockState);
  (useAppStore as unknown as { getState: () => typeof mockState }).getState = () => mockState;
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
  mockState.browserHistories = {};
  mockState.writeBrowserHistory.mockClear();
  createServeUrl.mockClear();
  createProxyUrl.mockClear();
});
afterEach(cleanup);

describe('CanvasBrowserContent — history navigation', () => {
  it('back/forward/reload drive the framed URL through an in-component history stack', async () => {
    render(
      <CanvasBrowserContent
        documentId="doc"
        content={{ type: 'browser', url: 'https://a.test/' }}
      />
    );

    // Initial external page frames directly.
    await waitFor(() => expect(iframeSrc()).toBe('https://a.test/'));

    // Navigate to B via the address bar (click to enter edit mode first).
    fireEvent.click(screen.getByRole('button', { name: /^Address:/ }));
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
    render(
      <CanvasBrowserContent documentId="doc" content={{ type: 'browser', url: 'preview.html' }} />
    );

    await waitFor(() => expect(iframeSrc()).toContain('/api/workbench/serve/'));
    expect(createServeUrl).toHaveBeenCalledTimes(1);
    expect(createServeUrl).toHaveBeenCalledWith('/work', 'preview.html');

    fireEvent.click(screen.getByLabelText('Reload'));
    await waitFor(() => expect(createServeUrl).toHaveBeenCalledTimes(2));
  });
});

describe('CanvasBrowserContent — sandbox posture', () => {
  it('renders served content WITHOUT allow-same-origin (opaque origin)', async () => {
    render(
      <CanvasBrowserContent documentId="doc" content={{ type: 'browser', url: 'preview.html' }} />
    );

    const frame = await screen.findByTitle('Embedded browser');
    const sandbox = frame.getAttribute('sandbox') ?? '';
    expect(sandbox).not.toContain('allow-same-origin');
    expect(sandbox).toBe(WORKBENCH_SANDBOX_ISOLATED);
  });
});

describe('CanvasBrowserContent — url content type routes here (DOR-233)', () => {
  it('renders navigation chrome for a `url` document', async () => {
    render(
      <CanvasBrowserContent documentId="doc" content={{ type: 'url', url: 'https://a.test/' }} />
    );
    expect(screen.getByLabelText('Back')).toBeInTheDocument();
    expect(screen.getByLabelText('Forward')).toBeInTheDocument();
    expect(screen.getByLabelText('Reload')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Address:/ })).toBeInTheDocument();
    await waitFor(() => expect(iframeSrc()).toBe('https://a.test/'));
  });

  it('refuses a blocked protocol (javascript:) — no frame', async () => {
    render(
      <CanvasBrowserContent
        documentId="doc"
        content={{ type: 'url', url: 'javascript:alert(1)' }}
      />
    );
    expect(screen.getByText(/can’t be displayed for security reasons/i)).toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();
  });
});

describe('CanvasBrowserContent — address bar (at rest)', () => {
  it('simplifies an external URL: scheme stripped, host emphasized, path dimmed', () => {
    render(
      <CanvasBrowserContent
        documentId="doc"
        content={{ type: 'browser', url: 'https://www.example.com/docs?x=1' }}
      />
    );
    const bar = screen.getByRole('button', { name: /^Address:/ });
    // Scheme + leading www. stripped from the visible text.
    expect(bar.textContent).toBe('example.com/docs?x=1');
    const host = bar.querySelector('.text-foreground');
    const rest = bar.querySelector('.text-muted-foreground');
    expect(host?.textContent).toBe('example.com');
    expect(rest?.textContent).toBe('/docs?x=1');
    // The accessible name carries the location, not just "Address".
    expect(bar).toHaveAccessibleName('Address: example.com/docs?x=1');
  });

  it('shows a local file as its logical path behind a "local" chip — never the token URL', async () => {
    render(
      <CanvasBrowserContent documentId="doc" content={{ type: 'browser', url: 'preview.html' }} />
    );
    const bar = screen.getByRole('button', { name: /^Address:/ });
    expect(bar.textContent).toContain('local');
    expect(bar.textContent).toContain('preview.html');

    // The accessible name announces the logical path, never the token URL.
    expect(bar).toHaveAccessibleName('Address: preview.html');

    // The signed token URL is what the iframe loads — it must NEVER surface in
    // the address bar.
    await waitFor(() => expect(iframeSrc()).toContain('/api/workbench/serve/'));
    expect(bar.textContent).not.toContain('/api/workbench');
    expect(bar.textContent).not.toContain('tok');
    expect(bar.getAttribute('aria-label')).not.toContain('/api/workbench');
  });
});

describe('CanvasBrowserContent — address bar (editing)', () => {
  it('focus reveals the full logical URL and selects all', () => {
    render(
      <CanvasBrowserContent
        documentId="doc"
        content={{ type: 'browser', url: 'https://example.com/docs' }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /^Address:/ }));
    const input = screen.getByLabelText('Address') as HTMLInputElement;
    expect(input.value).toBe('https://example.com/docs');
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('https://example.com/docs'.length);
  });

  it('Enter navigates to the typed address', async () => {
    render(
      <CanvasBrowserContent
        documentId="doc"
        content={{ type: 'browser', url: 'https://a.test/' }}
      />
    );
    await waitFor(() => expect(iframeSrc()).toBe('https://a.test/'));

    fireEvent.click(screen.getByRole('button', { name: /^Address:/ }));
    const input = screen.getByLabelText('Address') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://c.test/' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    await waitFor(() => expect(iframeSrc()).toBe('https://c.test/'));
  });

  it('normalizes a bare host on Enter (adds a scheme)', async () => {
    render(
      <CanvasBrowserContent
        documentId="doc"
        content={{ type: 'browser', url: 'https://a.test/' }}
      />
    );
    await waitFor(() => expect(iframeSrc()).toBe('https://a.test/'));

    fireEvent.click(screen.getByRole('button', { name: /^Address:/ }));
    const input = screen.getByLabelText('Address') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'example.com' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    await waitFor(() => expect(iframeSrc()).toBe('https://example.com'));
  });

  it('Escape reverts without navigating', async () => {
    render(
      <CanvasBrowserContent
        documentId="doc"
        content={{ type: 'browser', url: 'https://a.test/' }}
      />
    );
    await waitFor(() => expect(iframeSrc()).toBe('https://a.test/'));

    fireEvent.click(screen.getByRole('button', { name: /^Address:/ }));
    const input = screen.getByLabelText('Address') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://evil.test/' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    // Back to the at-rest display showing the original host; URL unchanged.
    const bar = screen.getByRole('button', { name: /^Address:/ });
    expect(bar.textContent).toBe('a.test');
    expect(iframeSrc()).toBe('https://a.test/');
  });

  it('blur reverts without navigating', async () => {
    render(
      <CanvasBrowserContent
        documentId="doc"
        content={{ type: 'browser', url: 'https://a.test/' }}
      />
    );
    await waitFor(() => expect(iframeSrc()).toBe('https://a.test/'));

    fireEvent.click(screen.getByRole('button', { name: /^Address:/ }));
    const input = screen.getByLabelText('Address') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://evil.test/' } });
    fireEvent.blur(input);

    expect(screen.getByRole('button', { name: /^Address:/ })).toBeInTheDocument();
    expect(iframeSrc()).toBe('https://a.test/');
  });
});

describe('CanvasBrowserContent — external embed fallback', () => {
  it('always surfaces an "open in system browser" affordance for external sites', async () => {
    // XFO/frame-ancestors refusal can't be reliably detected cross-origin, so the
    // escape hatch is always present for external pages (honest by design).
    render(
      <CanvasBrowserContent
        documentId="doc"
        content={{ type: 'browser', url: 'https://blocked.test/' }}
      />
    );

    await screen.findByTitle('Embedded browser');
    expect(screen.getByText(/can’t always be embedded/i)).toBeInTheDocument();
    // The escape hatch appears both in the toolbar and the external footer.
    expect(
      screen.getAllByRole('button', { name: /open in system browser/i }).length
    ).toBeGreaterThanOrEqual(1);
  });

  it('does NOT show the external fallback for served local content', async () => {
    render(
      <CanvasBrowserContent documentId="doc" content={{ type: 'browser', url: 'preview.html' }} />
    );
    await screen.findByTitle('Embedded browser');
    expect(screen.queryByText(/can’t always be embedded/i)).not.toBeInTheDocument();
  });
});

describe('CanvasBrowserContent — per-document history across tab switches (DOR-252)', () => {
  /** Enter an address-bar URL and wait for the frame to show it. */
  async function navigateTo(url: string): Promise<void> {
    fireEvent.click(screen.getByRole('button', { name: /^Address:/ }));
    const input = screen.getByLabelText('Address') as HTMLInputElement;
    fireEvent.change(input, { target: { value: url } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    await waitFor(() => expect(iframeSrc()).toBe(url));
  }

  it('restores a document its own stack + cursor after a tab switch away and back', async () => {
    // Mount A, navigate twice so its history has depth > 1.
    const a = render(
      <CanvasBrowserContent documentId="A" content={{ type: 'browser', url: 'https://a1.test/' }} />
    );
    await waitFor(() => expect(iframeSrc()).toBe('https://a1.test/'));
    await navigateTo('https://a2.test/');
    // Sanity: A is at a2 with Back enabled.
    expect(screen.getByLabelText('Back')).not.toBeDisabled();
    a.unmount();

    // Switch to B (a different document) — its own fresh stack.
    const b = render(
      <CanvasBrowserContent documentId="B" content={{ type: 'browser', url: 'https://b1.test/' }} />
    );
    await waitFor(() => expect(iframeSrc()).toBe('https://b1.test/'));
    b.unmount();

    // Back to A: the remount restores its stack + cursor exactly.
    render(
      <CanvasBrowserContent documentId="A" content={{ type: 'browser', url: 'https://a1.test/' }} />
    );
    // Current page is still a2 (cursor restored, not reset to the seed).
    await waitFor(() => expect(iframeSrc()).toBe('https://a2.test/'));
    // Back is enabled exactly as before the switch...
    expect(screen.getByLabelText('Back')).not.toBeDisabled();
    expect(screen.getByLabelText('Forward')).toBeDisabled();
    // ...and pressing Back lands on a1 (the right target, restored stack).
    fireEvent.click(screen.getByLabelText('Back'));
    await waitFor(() => expect(iframeSrc()).toBe('https://a1.test/'));
  });

  it('resets history when an agent-driven url change remounts the same document', async () => {
    const a = render(
      <CanvasBrowserContent documentId="A" content={{ type: 'browser', url: 'https://a1.test/' }} />
    );
    await waitFor(() => expect(iframeSrc()).toBe('https://a1.test/'));
    await navigateTo('https://a2.test/');
    a.unmount();

    // update_canvas swaps this document's url in place → the renderer remounts
    // with a NEW content.url. The stored entry's contentUrl no longer matches,
    // so history reseeds fresh (DOR-233 remount-resets-history semantic).
    render(
      <CanvasBrowserContent documentId="A" content={{ type: 'browser', url: 'https://a3.test/' }} />
    );
    await waitFor(() => expect(iframeSrc()).toBe('https://a3.test/'));
    expect(screen.getByLabelText('Back')).toBeDisabled();
  });

  it('two documents at the same url keep independent histories (keyed by document id)', async () => {
    // A navigates away from the shared url; B (same url, different id) stays fresh.
    const a = render(
      <CanvasBrowserContent
        documentId="A"
        content={{ type: 'browser', url: 'https://same.test/' }}
      />
    );
    await waitFor(() => expect(iframeSrc()).toBe('https://same.test/'));
    await navigateTo('https://a-only.test/');
    a.unmount();

    render(
      <CanvasBrowserContent
        documentId="B"
        content={{ type: 'browser', url: 'https://same.test/' }}
      />
    );
    await waitFor(() => expect(iframeSrc()).toBe('https://same.test/'));
    // B has no history of its own despite sharing A's url.
    expect(screen.getByLabelText('Back')).toBeDisabled();
  });

  it('clamps an out-of-bounds stored cursor into the stack (defensive)', async () => {
    mockState.browserHistories['C'] = {
      contentUrl: 'https://c1.test/',
      stack: ['https://c1.test/', 'https://c2.test/'],
      cursor: 99,
    };
    render(
      <CanvasBrowserContent documentId="C" content={{ type: 'browser', url: 'https://c1.test/' }} />
    );
    // Cursor clamped to the last valid index → shows c2, Forward disabled, Back enabled.
    await waitFor(() => expect(iframeSrc()).toBe('https://c2.test/'));
    expect(screen.getByLabelText('Forward')).toBeDisabled();
    expect(screen.getByLabelText('Back')).not.toBeDisabled();
  });
});
