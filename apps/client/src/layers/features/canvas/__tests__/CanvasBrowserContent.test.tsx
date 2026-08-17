/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { WORKBENCH_SANDBOX_EXTERNAL, WORKBENCH_SANDBOX_ISOLATED } from '../lib/browser-url';

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
/** What the server hands back for a dev server: a whole origin of its own. */
const PREVIEW_ORIGIN = 'http://localhost:4390';
const PREVIEW_BOOTSTRAP = `${PREVIEW_ORIGIN}/?__dorkos_preview=tok`;
const createProxyUrl = vi.fn(
  async () => ({ url: PREVIEW_BOOTSTRAP }) as { url: string | null; unavailable?: string }
);
const probeLoopbackPort = vi.fn(async () => ({ listening: true }) as { listening: boolean } | null);

vi.mock('@/layers/shared/model', () => {
  const useAppStore = (selector: (s: typeof mockState) => unknown) => selector(mockState);
  (useAppStore as unknown as { getState: () => typeof mockState }).getState = () => mockState;
  // A FRESH transport object on every render, deliberately. Which transport is
  // in play never changes what a URL resolves to, so the browser must not
  // re-resolve because a provider handed it a new object — and when it did, the
  // render/effect cycle span at 100% CPU rather than failing (the two tests
  // asserting a single mint below are what catch it).
  return {
    useAppStore,
    useTransport: () => ({ createServeUrl, createProxyUrl, probeLoopbackPort }),
  };
});

// The browser's OWN reachability check, which answers about the machine looking
// at the page rather than the machine running DorkOS. Covered directly in
// `lib/__tests__/probe-direct.test.ts`; stubbed here so the cascade between the
// two probes is what these tests exercise.
const probeDirect = vi.fn(async (_url: string) => true);

/** Answer the browser's reachability probe differently per URL. */
function reachable(predicate: (url: string) => boolean): void {
  probeDirect.mockImplementation(async (url: string) => predicate(url));
}
vi.mock('../lib/probe-direct', () => ({
  probeDirect: (url: string) => probeDirect(url),
}));

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
  createProxyUrl.mockResolvedValue({ url: PREVIEW_BOOTSTRAP });
  probeLoopbackPort.mockClear();
  probeLoopbackPort.mockResolvedValue({ listening: true });
  probeDirect.mockClear();
  probeDirect.mockResolvedValue(true);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

describe('CanvasBrowserContent — a dev server on this machine', () => {
  const DEV_URL = 'http://localhost:5178/dorkos/flagship-promo/vo';

  it('frames the dev server on a preview origin of its own', async () => {
    // The path-prefixed proxy made `/src/main.tsx` resolve against the cockpit,
    // which answered with its own SPA shell — every Vite/Next/CRA app rendered
    // blank. The frame's origin root has to BE the app's root.
    render(<CanvasBrowserContent documentId="doc" content={{ type: 'browser', url: DEV_URL }} />);

    await waitFor(() => expect(iframeSrc()).toContain(PREVIEW_ORIGIN));
    // The reachability question was asked of the BROWSER, about the origin it
    // would actually load — and about the one path that needs no token.
    expect(probeDirect).toHaveBeenCalledWith(`${PREVIEW_ORIGIN}/__dorkos_preview/health`);
  });

  it('lands on the page that was asked for, not the app’s front door', async () => {
    render(<CanvasBrowserContent documentId="doc" content={{ type: 'browser', url: DEV_URL }} />);

    await waitFor(() => expect(iframeSrc()).toContain(PREVIEW_ORIGIN));
    const framed = new URL(iframeSrc() as string);
    expect(framed.pathname).toBe('/dorkos/flagship-promo/vo');
    // The one-time token rides along behind the path; the listener strips it.
    expect(framed.searchParams.get('__dorkos_preview')).toBe('tok');
  });

  it('resolves once, however many times the transport object is rebuilt', async () => {
    // The transport arrives fresh on every render here. Re-resolving on that
    // would re-mint a preview token per render — and, because storing the result
    // renders again, would never stop.
    const { rerender } = render(
      <CanvasBrowserContent documentId="doc" content={{ type: 'browser', url: DEV_URL }} />
    );
    await waitFor(() => expect(iframeSrc()).toContain(PREVIEW_ORIGIN));
    for (let i = 0; i < 5; i++) {
      rerender(
        <CanvasBrowserContent documentId="doc" content={{ type: 'browser', url: DEV_URL }} />
      );
    }
    await waitFor(() => expect(iframeSrc()).toContain(PREVIEW_ORIGIN));

    expect(createProxyUrl).toHaveBeenCalledTimes(1);
    expect(probeLoopbackPort).toHaveBeenCalledTimes(1);
  });

  it('gives the preview origin allow-same-origin — it is cross-origin to the API', async () => {
    render(<CanvasBrowserContent documentId="doc" content={{ type: 'browser', url: DEV_URL }} />);
    const frame = await screen.findByTitle('Embedded browser');
    expect(frame.getAttribute('sandbox')).toBe(WORKBENCH_SANDBOX_EXTERNAL);
  });

  it('frames the dev server directly when the preview origin cannot be reached', async () => {
    // "Dev server on my laptop, DorkOS in a container": the preview port was
    // never forwarded, but this page and the dev server are on one machine.
    reachable((url) => url === DEV_URL);
    render(<CanvasBrowserContent documentId="doc" content={{ type: 'browser', url: DEV_URL }} />);

    await waitFor(() => expect(iframeSrc()).toBe(DEV_URL));
    const frame = await screen.findByTitle('Embedded browser');
    expect(frame.getAttribute('sandbox')).toBe(WORKBENCH_SANDBOX_EXTERNAL);
  });

  it('says the connection does not reach the preview port, from a device that is not the machine', async () => {
    // A phone over Tailscale: DorkOS can see the dev server, this browser can
    // see neither the origin DorkOS opened nor `localhost` (which is the phone).
    vi.stubGlobal('location', { ...window.location, hostname: 'machine.tail.ts.net' });
    reachable(() => false);
    render(<CanvasBrowserContent documentId="doc" content={{ type: 'browser', url: DEV_URL }} />);

    expect(
      await screen.findByText(
        /DorkOS can see your dev server, but this connection doesn’t reach port 4390 on localhost\./i
      )
    ).toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();
    // Not a loopback page, so the dev server's own address was never tried.
    expect(probeDirect).not.toHaveBeenCalledWith(DEV_URL);
  });

  /**
   * Every way step 2 can fail, and what each one owes the user.
   *
   * The column that matters is `triesDirect`. A preview origin that could not be
   * opened says NOTHING about whether this page can reach the dev server's own
   * address, so every one of these still has to fall through to step 3 — except
   * a tunnel, where it is already known that it cannot: a tunnel hostname is not
   * a loopback host, so `localhost` there is the viewer's own machine.
   */
  const step2Failures = [
    {
      what: 'a tunnel cockpit',
      mint: () => createProxyUrl.mockResolvedValue({ url: null, unavailable: 'tunnel' }),
      triesDirect: false,
      message: /Dev-server previews aren’t available through a tunnel\./i,
    },
    {
      what: 'every preview port taken',
      mint: () => createProxyUrl.mockResolvedValue({ url: null, unavailable: 'no-port' }),
      triesDirect: true,
      message: /All preview ports are in use\. Close a preview, then reload\./i,
    },
    {
      what: 'the mint itself failing',
      mint: () => createProxyUrl.mockRejectedValue(new Error('network down')),
      triesDirect: true,
      message: /This preview couldn’t be loaded\. Reload to try again/i,
    },
    {
      what: 'a preview origin this browser cannot reach',
      mint: () => createProxyUrl.mockResolvedValue({ url: PREVIEW_BOOTSTRAP }),
      triesDirect: true,
      message: /DorkOS can see your dev server, but this connection doesn’t reach port 4390/i,
    },
  ] as const;

  for (const { what, mint, triesDirect, message } of step2Failures) {
    it(`falls back to the dev server’s own address when step 2 fails: ${what}`, async () => {
      mint();
      // This page IS on the machine running it, and the dev server answers.
      reachable((url) => url === DEV_URL);
      render(<CanvasBrowserContent documentId="doc" content={{ type: 'browser', url: DEV_URL }} />);

      if (!triesDirect) {
        expect(await screen.findByText(message)).toBeInTheDocument();
        expect(probeDirect).not.toHaveBeenCalledWith(DEV_URL);
        return;
      }
      await waitFor(() => expect(iframeSrc()).toBe(DEV_URL));
      expect(probeDirect).toHaveBeenCalledWith(DEV_URL);
    });

    it(`says what went wrong when nothing works either: ${what}`, async () => {
      mint();
      reachable(() => false);
      render(<CanvasBrowserContent documentId="doc" content={{ type: 'browser', url: DEV_URL }} />);

      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(document.querySelector('iframe')).toBeNull();
    });
  }

  it('says so when nothing is listening, instead of framing a blank page', async () => {
    reachable(() => false);
    probeLoopbackPort.mockResolvedValue({ listening: false });
    render(<CanvasBrowserContent documentId="doc" content={{ type: 'browser', url: DEV_URL }} />);

    expect(
      await screen.findByText(
        /Nothing is listening on localhost:5178\. Start the dev server, then reload\./i
      )
    ).toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();
    // Nothing is there, so no listener is opened for it.
    expect(createProxyUrl).not.toHaveBeenCalled();
  });

  it('names the address the way the user typed it', async () => {
    reachable(() => false);
    probeLoopbackPort.mockResolvedValue({ listening: false });
    render(
      <CanvasBrowserContent
        documentId="doc"
        content={{ type: 'browser', url: 'http://127.0.0.1:5399/' }}
      />
    );

    // Telling someone who typed 127.0.0.1 about "localhost" invites them to
    // doubt the message rather than the port.
    expect(
      await screen.findByText(/Nothing is listening on 127\.0\.0\.1:5399\./i)
    ).toBeInTheDocument();
  });

  it('re-mints on reload, because a token expires', async () => {
    reachable(() => false);
    probeLoopbackPort.mockResolvedValue({ listening: false });
    render(<CanvasBrowserContent documentId="doc" content={{ type: 'browser', url: DEV_URL }} />);
    await screen.findByText(/Nothing is listening on localhost:5178/i);

    probeLoopbackPort.mockResolvedValue({ listening: true });
    probeDirect.mockResolvedValue(true);
    fireEvent.click(screen.getByLabelText('Reload'));
    await waitFor(() => expect(iframeSrc()).toContain(PREVIEW_ORIGIN));
    expect(createProxyUrl).toHaveBeenCalledTimes(1);
  });

  it('frames it anyway when the transport cannot check the port', async () => {
    // `null` means "no server to ask", not "nothing is there" — a preview must
    // never be refused on the strength of an answer nobody gave.
    probeLoopbackPort.mockResolvedValue(null);
    render(<CanvasBrowserContent documentId="doc" content={{ type: 'browser', url: DEV_URL }} />);
    await waitFor(() => expect(iframeSrc()).toContain(PREVIEW_ORIGIN));
  });

  it('falls back to the dev server’s own address when there is no server to mint from', async () => {
    // The in-process Obsidian transport: no preview origin exists, so the only
    // remaining option is the address the user typed.
    probeLoopbackPort.mockResolvedValue(null);
    createProxyUrl.mockResolvedValue(null as never);
    render(<CanvasBrowserContent documentId="doc" content={{ type: 'browser', url: DEV_URL }} />);

    await waitFor(() => expect(iframeSrc()).toBe(DEV_URL));
  });

  it('works from another device, where the dev server’s own address never could', async () => {
    // On a phone over Tailscale, `localhost` is the phone. The preview origin is
    // on the machine that can actually reach the dev server.
    vi.stubGlobal('location', { ...window.location, hostname: 'machine.tail.ts.net' });
    render(<CanvasBrowserContent documentId="doc" content={{ type: 'browser', url: DEV_URL }} />);

    await waitFor(() => expect(iframeSrc()).toContain(PREVIEW_ORIGIN));
    expect(probeDirect).not.toHaveBeenCalledWith(DEV_URL);
    expect(probeLoopbackPort).toHaveBeenCalledWith(5178);
  });
});

describe('CanvasBrowserContent — a preview that loads badly', () => {
  const DEV_URL = 'http://localhost:5178/';

  /**
   * Mount and settle under a frozen clock.
   *
   * The deadline is a real timer, so these two tests own the clock — and they
   * settle the mount by draining microtasks rather than by polling, because a
   * `waitFor` running against a clock the test is also driving is a race the
   * test can lose either way.
   */
  async function renderSettled(url: string): Promise<HTMLElement> {
    render(<CanvasBrowserContent documentId="doc" content={{ type: 'browser', url }} />);
    await act(async () => {});
    return screen.getByTitle('Embedded browser');
  }

  it('says when a preview is taking too long, without unmounting it', async () => {
    vi.useFakeTimers();
    try {
      await renderSettled(DEV_URL);
      expect(iframeSrc()).toContain(PREVIEW_ORIGIN);
      expect(screen.queryByText(/taking a long time/i)).not.toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(11_000);
      });
      expect(screen.getByText(/This preview is taking a long time to load\./i)).toBeInTheDocument();
      // A slow page is still a live page — never pull the frame out from under it.
      expect(document.querySelector('iframe')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops saying it once the page loads', async () => {
    vi.useFakeTimers();
    try {
      const frame = await renderSettled(DEV_URL);
      fireEvent.load(frame);
      await act(async () => {
        vi.advanceTimersByTime(11_000);
      });
      expect(screen.queryByText(/taking a long time/i)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts the resources a served preview failed to load and offers a way out', async () => {
    render(
      <CanvasBrowserContent documentId="doc" content={{ type: 'browser', url: 'preview.html' }} />
    );
    const frame = (await screen.findByTitle('Embedded browser')) as HTMLIFrameElement;

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { __dorkosDevtools: 'resource-error', url: '/main.js' },
          source: frame.contentWindow,
          // What a served preview reports: it renders opaque, so its origin is
          // the literal "null". The bridge rejects anything else.
          origin: 'null',
        })
      );
    });
    expect(screen.getByText(/This page hit 1 error while loading\./i)).toBeInTheDocument();

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { __dorkosDevtools: 'resource-error', url: '/app.css' },
          source: frame.contentWindow,
          origin: 'null',
        })
      );
    });
    expect(screen.getByText(/This page hit 2 errors while loading\./i)).toBeInTheDocument();
    expect(
      screen.getAllByRole('button', { name: /open in system browser/i }).length
    ).toBeGreaterThanOrEqual(2);
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
