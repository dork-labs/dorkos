/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';

// Mock sonner so toast calls don't error
vi.mock('sonner', () => ({
  toast: {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// The approval queue's hook rides the global `/api/events` fan-out, which needs
// the app-level `EventStreamProvider`. Nothing here is about that stream.
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useEventSubscription: () => {} };
});

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

// Import the component after mocks are set up
import { ExtensionsSettingsTab } from '../ui/ExtensionsSettingsTab';
import { toast } from 'sonner';

// --- Fixtures ---

function makeExtension(overrides: Partial<ExtensionRecordPublic> = {}): ExtensionRecordPublic {
  return {
    id: 'test-ext',
    manifest: {
      id: 'test-ext',
      name: 'Test Extension',
      version: '1.0.0',
      description: 'A test extension',
      author: 'Tester',
    },
    status: 'active',
    scope: 'global',
    origin: 'user',
    bundleReady: true,
    hasServerEntry: false,
    hasDataProxy: false,
    approvedToRun: true,
    shadowedBy: null,
    ...overrides,
  };
}

/** A named extension, for the order and search tests. */
function named(id: string, name: string, overrides: Partial<ExtensionRecordPublic> = {}) {
  return makeExtension({
    id,
    ...overrides,
    manifest: { id, name, version: '1.0.0', ...overrides.manifest },
  });
}

function mockFetch(responses: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      // Match the most specific (longest) key so action URLs like
      // `/api/extensions/:id/enable` win over the broader `/api/extensions` list.
      const key = Object.keys(responses)
        .filter((k) => url.includes(k))
        .sort((a, b) => b.length - a.length)[0];
      if (key) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(responses[key]),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: 'Not found' }),
      });
    })
  );
}

/** Open one extension's row, as a click on its name does. */
function openRow(id: string) {
  const row = screen.getByTestId(`extension-card-${id}`);
  const button = row.querySelector<HTMLButtonElement>('[data-row-button]');
  if (!button) throw new Error(`no row button for ${id}`);
  fireEvent.click(button);
  return row;
}

/** The names of the rows inside one section, top to bottom. */
function rowNames(section: HTMLElement): string[] {
  return Array.from(section.querySelectorAll('[data-row-button] > span:first-child')).map(
    (span) => span.textContent ?? ''
  );
}

// --- Tests ---

describe('ExtensionsSettingsTab', () => {
  it('shows loading state while fetching', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise(() => {
            /* never resolves */
          })
      )
    );

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

    expect(screen.getByRole('status', { name: 'Loading extensions…' })).toBeInTheDocument();
  });

  it('shows empty state only after a load that found none', async () => {
    mockFetch({ '/api/extensions': [] });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

    expect(await screen.findByTestId('no-extensions')).toHaveTextContent('No extensions yet');
    expect(screen.getByRole('button', { name: 'Browse Marketplace' })).toBeInTheDocument();
  });

  // Purpose: a refused or failed list is never shown as "none installed", and
  // Try again reads it again (the sign-in bug, Nov 8).
  it('says it couldn’t load, never "none installed", and tries again', async () => {
    let attempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.endsWith('/api/extensions')) {
          attempts += 1;
          if (attempts === 1) {
            return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
          }
          return Promise.resolve({ ok: true, json: () => Promise.resolve([makeExtension()]) });
        }
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
      })
    );

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

    const alert = await screen.findByRole('alert');
    // The two sentences, word for word: a bold title, then the line under it.
    expect(within(alert).getByText('Couldn’t load your extensions.')).toBeInTheDocument();
    expect(
      within(alert).getByText('They’re still installed, and nothing was turned off.')
    ).toBeInTheDocument();
    expect(screen.queryByTestId('no-extensions')).not.toBeInTheDocument();
    // One way out, not two: Reload waits until there is a list to reload.
    expect(screen.queryByTestId('reload-extensions-button')).not.toBeInTheDocument();

    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('extension-card-test-ext')).toBeInTheDocument();
  });

  it('renders a row for each discovered extension', async () => {
    const extensions = [makeExtension({ id: 'ext-a' }), makeExtension({ id: 'ext-b' })];
    mockFetch({ '/api/extensions': extensions });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('extension-card-ext-a')).toBeInTheDocument();
    });
    expect(screen.getByTestId('extension-card-ext-b')).toBeInTheDocument();
  });

  it('counts what is installed and what needs you', async () => {
    mockFetch({
      '/api/extensions': [
        named('a', 'Alpha'),
        named('b', 'Beta', { approvedToRun: false }),
        named('c', 'Core', { origin: 'core' }),
      ],
    });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

    expect(await screen.findByTestId('extensions-count')).toHaveTextContent(
      '2 installed · 1 needs you'
    );
  });

  // Purpose: the count agrees with its number: one needs, several need.
  it('says "need you" for more than one', async () => {
    mockFetch({
      '/api/extensions': [
        named('a', 'Alpha', { approvedToRun: false }),
        named('b', 'Beta', { approvedToRun: false }),
      ],
    });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

    expect(await screen.findByTestId('extensions-count')).toHaveTextContent(
      '2 installed · 2 need you'
    );
  });

  describe('the row', () => {
    // Purpose: the purpose line is the manifest's summary, else the first
    // sentence of the description, never the whole paragraph.
    it('shows the summary, else the first sentence of the description', async () => {
      mockFetch({
        '/api/extensions': [
          named('s', 'With summary', {
            manifest: {
              id: 's',
              name: 'With summary',
              version: '1.0.0',
              summary: 'Tracks spending.',
              description: 'A long paragraph. With two sentences.',
            },
          }),
          named('d', 'Description only', {
            manifest: {
              id: 'd',
              name: 'Description only',
              version: '1.0.0',
              description: 'Captures notes. Then files them.',
            },
          }),
        ],
      });

      render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

      const withSummary = await screen.findByTestId('extension-card-s');
      expect(withSummary).toHaveTextContent('Tracks spending.');
      expect(withSummary).not.toHaveTextContent('A long paragraph');
      expect(screen.getByTestId('extension-card-d')).toHaveTextContent('Captures notes.');
      expect(screen.getByTestId('extension-card-d')).not.toHaveTextContent('Then files them');
    });

    // Purpose: a long name truncates inside its own column, with the full name
    // kept for hover, so it never pushes the purpose line out of line.
    it('keeps a long name inside the name column', async () => {
      const name = 'Customer Interview Synthesizer For Product Discovery';
      mockFetch({ '/api/extensions': [named('long', name)] });

      render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

      const row = await screen.findByTestId('extension-card-long');
      const nameSpan = row.querySelector('[data-row-button] > span:first-child');
      expect(nameSpan).toHaveAttribute('title', name);
      expect(nameSpan).toHaveClass('truncate', 'w-[200px]', 'shrink-0');
    });

    it('opens in place, and shows the facts of a healthy extension', async () => {
      mockFetch({ '/api/extensions': [makeExtension({ scope: 'local' })] });

      render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });
      await screen.findByTestId('extension-card-test-ext');
      const row = openRow('test-ext');

      expect(row.querySelector('[data-row-button]')).toHaveAttribute('aria-expanded', 'true');
      const region = within(row).getByRole('region', { name: 'Test Extension' });
      expect(region).toHaveTextContent('A test extension');
      expect(region).toHaveTextContent('Version1.0.0');
      expect(region).toHaveTextContent('ByTester');
      expect(region).toHaveTextContent('ForThis project only');
    });

    it('closes on Escape and gives focus back to the row', async () => {
      mockFetch({ '/api/extensions': [makeExtension()] });

      render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });
      await screen.findByTestId('extension-card-test-ext');
      const row = openRow('test-ext');
      const region = within(row).getByRole('region');
      fireEvent.keyDown(region, { key: 'Escape' });

      const button = row.querySelector('[data-row-button]');
      expect(button).toHaveAttribute('aria-expanded', 'false');
      expect(button).toHaveFocus();
    });

    it('moves between rows with the arrow keys', async () => {
      mockFetch({ '/api/extensions': [named('a', 'Alpha'), named('b', 'Beta')] });

      render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });
      const first = (await screen.findByTestId('extension-card-a')).querySelector<HTMLElement>(
        '[data-row-button]'
      )!;
      first.focus();
      fireEvent.keyDown(first, { key: 'ArrowDown' });

      expect(
        screen.getByTestId('extension-card-b').querySelector('[data-row-button]')
      ).toHaveFocus();
    });

    it('badges a dev-linked extension, and links to where it is switched', async () => {
      // Purpose: Settings shows the dev link and its path (DOR-2696).
      mockFetch({
        '/api/extensions': [
          makeExtension({
            approvedToRun: true,
            originProblem: 'dev-link',
            devLink: { path: '/work/flow' },
            sourcePlugin: 'flow',
          }),
        ],
      });

      render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });
      const row = await screen.findByTestId('extension-card-test-ext');
      expect(within(row).getByText('Dev link')).toBeInTheDocument();
      openRow('test-ext');

      const devLink = screen.getByTestId('extension-dev-link-test-ext');
      expect(devLink).toHaveTextContent('Dev link: /work/flow');
      expect(within(devLink).getByRole('button', { name: 'Unlink or switch' })).toBeInTheDocument();
    });

    it('tells a person who approved a changed copy that any further change asks again', async () => {
      mockFetch({
        '/api/extensions': [makeExtension({ approvedToRun: true, originProblem: 'changed' })],
      });

      render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });
      await screen.findByTestId('extension-card-test-ext');
      openRow('test-ext');

      expect(screen.getByTestId('extension-run-allowed-test-ext')).toHaveTextContent(
        'Any further change asks again'
      );
    });
  });

  describe('order', () => {
    // Purpose: what needs you sits on top by need then A–Z; the rest is A–Z
    // whatever the case; DorkOS's own is folded at the end.
    it('puts what needs you first, the rest A–Z, and DorkOS’s own folded last', async () => {
      mockFetch({
        '/api/extensions': [
          named('zed', 'zed'),
          named('broken', 'Broken', {
            status: 'compile_error',
            error: { code: 'COMPILE_ERROR', message: 'boom' },
          }),
          named('apple', 'Apple'),
          named('waiting', 'Waiting', { approvedToRun: false }),
          named('banana', 'banana', { status: 'disabled' }),
          named('core-a', 'Core A', { origin: 'core' }),
        ],
      });

      render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

      const needsYou = await screen.findByTestId('needs-you-section');
      expect(rowNames(needsYou)).toEqual(['Waiting', 'Broken']);
      expect(rowNames(screen.getByTestId('installed-extensions-section'))).toEqual([
        'Apple',
        'banana',
        'zed',
      ]);
      const core = screen.getByTestId('core-extensions-section');
      expect(within(core).getByRole('button', { name: 'Comes with DorkOS · 1' })).toHaveAttribute(
        'aria-expanded',
        'false'
      );
      expect(within(core).queryByTestId('extension-card-core-a')).not.toBeInTheDocument();
      fireEvent.click(within(core).getByRole('button', { name: 'Comes with DorkOS · 1' }));
      expect(within(core).getByTestId('extension-card-core-a')).toBeInTheDocument();
    });

    // Purpose: the fold's chevron is decoration: the button's name stays
    // exactly "Comes with DorkOS · N", and the chevron turns when it opens.
    it('names the fold by its words alone, with a chevron that turns open', async () => {
      mockFetch({
        '/api/extensions': [
          named('core-a', 'Files', { origin: 'core' }),
          named('core-b', 'Terminal', { origin: 'core' }),
        ],
      });

      render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

      const fold = await screen.findByRole('button', { name: 'Comes with DorkOS · 2' });
      const chevron = fold.querySelector('svg');
      expect(chevron).not.toBeNull();
      expect(chevron).toHaveAttribute('aria-hidden', 'true');
      expect(chevron).not.toHaveClass('rotate-90');
      fireEvent.click(fold);
      expect(screen.getByRole('button', { name: 'Comes with DorkOS · 2' })).toHaveAttribute(
        'aria-expanded',
        'true'
      );
      expect(chevron).toHaveClass('rotate-90');
    });

    // Purpose: flipping a switch never moves a row.
    it('keeps a row in place when it is turned off', async () => {
      const list = [named('a', 'Alpha'), named('b', 'Beta'), named('c', 'Gamma')];
      mockFetch({
        '/api/extensions': list,
        '/api/extensions/b/disable': {
          extension: { ...list[1], status: 'disabled' },
          reloadRequired: false,
        },
      });

      render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });
      const section = await screen.findByTestId('installed-extensions-section');
      fireEvent.click(screen.getByRole('switch', { name: 'Beta: on' }));
      mockFetch({ '/api/extensions': [list[0], { ...list[1], status: 'disabled' }, list[2]] });

      await waitFor(() =>
        expect(screen.getByRole('switch', { name: 'Beta: off' })).toBeInTheDocument()
      );
      expect(rowNames(section)).toEqual(['Alpha', 'Beta', 'Gamma']);
    });
  });

  describe('search and filters', () => {
    it('finds by name, purpose, author and tool name', async () => {
      mockFetch({
        '/api/extensions': [
          named('ledger', 'Ledger', {
            manifest: {
              id: 'ledger',
              name: 'Ledger',
              version: '1.0.0',
              summary: 'Tracks spending.',
            },
          }),
          named('mail', 'Mail', {
            tools: [
              { name: 'send_message', title: 'Send an email', tier: 'act', status: 'active' },
            ],
          }),
        ],
      });

      render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });
      const search = await screen.findByRole('searchbox', { name: 'Search extensions' });

      fireEvent.change(search, { target: { value: 'spending' } });
      expect(screen.getByTestId('extension-card-ledger')).toBeInTheDocument();
      expect(screen.queryByTestId('extension-card-mail')).not.toBeInTheDocument();

      fireEvent.change(search, { target: { value: 'send_message' } });
      expect(screen.getByTestId('extension-card-mail')).toBeInTheDocument();
      expect(screen.queryByTestId('extension-card-ledger')).not.toBeInTheDocument();
    });

    it('says when nothing matches, and clears the search', async () => {
      mockFetch({ '/api/extensions': [makeExtension()] });

      render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });
      fireEvent.change(await screen.findByRole('searchbox'), { target: { value: 'zebra' } });

      expect(screen.getByTestId('extensions-no-match')).toHaveTextContent(
        'Nothing matches “zebra”'
      );
      fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
      expect(screen.getByTestId('extension-card-test-ext')).toBeInTheDocument();
    });

    it('shows only what is off under Off, with counts on each filter', async () => {
      mockFetch({
        '/api/extensions': [named('on', 'On one'), named('off', 'Off one', { status: 'disabled' })],
      });

      render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });
      await screen.findByTestId('extension-card-on');
      expect(screen.getByRole('button', { name: 'All 2' })).toHaveAttribute('aria-pressed', 'true');
      fireEvent.click(screen.getByRole('button', { name: 'Off 1' }));

      expect(screen.queryByTestId('extension-card-on')).not.toBeInTheDocument();
      expect(screen.getByTestId('extension-card-off')).toBeInTheDocument();
      // No last-used data yet, so no "Not used in 30 days" filter.
      expect(screen.queryByText(/Not used/)).not.toBeInTheDocument();
    });

    // Purpose: a filter with nothing behind it is not offered.
    it('hides the Off filter when nothing is off', async () => {
      mockFetch({ '/api/extensions': [named('on', 'On one')] });

      render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });
      await screen.findByTestId('extension-card-on');
      expect(screen.getByRole('button', { name: 'All 1' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Off/ })).not.toBeInTheDocument();
    });
  });

  it('calls POST /api/extensions/:id/enable when toggling a disabled extension on', async () => {
    const ext = makeExtension({ id: 'my-ext', status: 'disabled' });
    mockFetch({
      '/api/extensions': [ext],
      '/api/extensions/my-ext/enable': {
        extension: { ...ext, status: 'active' },
        reloadRequired: true,
      },
    });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

    fireEvent.click(await screen.findByRole('switch', { name: 'Test Extension: off' }));

    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        expect.stringContaining('/api/extensions/my-ext/enable'),
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  /**
   * The server's person bar (DOR-1507) answers a refused toggle with a 403 whose
   * `message` says what DorkOS did not do and who can do it. Two things have to
   * hold for the person to actually read that sentence, and each fails silently
   * on its own: the hook must PARSE it off the body instead of throwing the
   * status code, and the toast must show it BARE instead of prefixing its own
   * "Failed to enable extension:" in front of "DorkOS changed nothing".
   */
  describe('a refusal from the server', () => {
    /** Answer the toggle with a refusal body, and the list normally. */
    function mockRefusedToggle(body: unknown, status = 403) {
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string) => {
          if (url.includes('/enable') || url.includes('/disable')) {
            return Promise.resolve({ ok: false, status, json: () => Promise.resolve(body) });
          }
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([makeExtension({ id: 'my-ext', status: 'disabled' })]),
          });
        })
      );
    }

    async function toggleAndCatchToast() {
      render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });
      fireEvent.click(await screen.findByRole('switch', { name: 'Test Extension: off' }));
      await waitFor(() => {
        expect(vi.mocked(toast.error)).toHaveBeenCalled();
      });
      // The refusal rides in `description`; the first argument is the short
      // headline. Reading the description is what pins "the server's sentence
      // reaches the person INTACT".
      const [headline, options] = vi.mocked(toast.error).mock.calls[0] ?? [];
      return { headline, description: (options as { description?: string })?.description };
    }

    it("shows the server's own sentence, with nothing prefixed to it", async () => {
      const refusal =
        'DorkOS changed nothing. Turning an extension on or off decides which code runs ' +
        'inside DorkOS, so it is a decision only a person makes.';
      mockRefusedToggle({
        error: 'Only a person can change this',
        code: 'operator_only_config',
        message: refusal,
      });

      const { headline, description } = await toggleAndCatchToast();
      expect(description).toBe(refusal);
      expect(headline).toBe('Couldn’t turn that on.');
    });

    it('falls back to `error` when the body carries no message', async () => {
      mockRefusedToggle({ error: 'Only a person can change this' });

      expect((await toggleAndCatchToast()).description).toBe('Only a person can change this');
    });

    it('falls back to the status code when the body is not JSON at all', async () => {
      // A proxy or a crash can answer a non-JSON body; the chain must not throw
      // trying to read it, and the person must still be told something.
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string) => {
          if (url.includes('/enable')) {
            return Promise.resolve({
              ok: false,
              status: 502,
              json: () => Promise.reject(new Error('not json')),
            });
          }
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve([makeExtension({ id: 'my-ext', status: 'disabled' })]),
          });
        })
      );

      expect((await toggleAndCatchToast()).description).toBe(
        'Couldn’t turn on my-ext. The server answered 502.'
      );
    });
  });

  it('calls POST /api/extensions/:id/disable when toggling an active extension off', async () => {
    const ext = makeExtension({ id: 'my-ext', status: 'active' });
    mockFetch({
      '/api/extensions': [ext],
      '/api/extensions/my-ext/disable': {
        extension: { ...ext, status: 'disabled' },
        reloadRequired: true,
      },
    });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

    fireEvent.click(await screen.findByRole('switch', { name: 'Test Extension: on' }));

    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        expect.stringContaining('/api/extensions/my-ext/disable'),
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  it('applies the change live with no success toast (the Switch already reads on)', async () => {
    const ext = makeExtension({ id: 'my-ext', status: 'disabled' });
    mockFetch({
      '/api/extensions': [ext],
      '/api/extensions/my-ext/enable': {
        extension: { ...ext, status: 'active' },
        reloadRequired: true,
      },
    });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

    fireEvent.click(await screen.findByRole('switch', { name: 'Test Extension: off' }));

    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        expect.stringContaining('/api/extensions/my-ext/enable'),
        expect.objectContaining({ method: 'POST' })
      );
    });
    // The switch itself is the confirmation.
    expect(toast.success).not.toHaveBeenCalled();
    // The change applies live via the SSE `extension_reloaded` handler.
    expect(toast.info).not.toHaveBeenCalled();
  });

  it('calls POST /api/extensions/reload and shows success toast on reload', async () => {
    const ext = makeExtension();
    mockFetch({
      '/api/extensions': [ext],
      '/api/extensions/reload': [ext],
    });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

    fireEvent.click(await screen.findByTestId('reload-extensions-button'));

    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        expect.stringContaining('/api/extensions/reload'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('1 extension'));
    });
  });

  it('disables the switch and says why for an extension that needs a newer DorkOS', async () => {
    const ext = makeExtension({
      id: 'incompat-ext',
      status: 'incompatible',
      manifest: {
        id: 'incompat-ext',
        name: 'Incompat Extension',
        version: '1.0.0',
        minHostVersion: '99.0.0',
      },
    });
    mockFetch({ '/api/extensions': [ext] });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

    expect(await screen.findByRole('switch')).toBeDisabled();
    expect(screen.getByTestId('extension-health-incompat-ext')).toHaveTextContent(
      'Needs newer DorkOS'
    );
    // A neutral chip: it is not counted as needing you.
    expect(screen.queryByTestId('needs-you-section')).not.toBeInTheDocument();
    openRow('incompat-ext');
    expect(screen.getByText(/needs dorkos 99\.0\.0 or newer/i)).toBeInTheDocument();
  });

  it('says it is not working, and why, for a compile error', async () => {
    const ext = makeExtension({
      id: 'broken-ext',
      status: 'compile_error',
      error: { code: 'COMPILE_ERROR', message: 'Unexpected token' },
    });
    mockFetch({ '/api/extensions': [ext] });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

    expect(await screen.findByTestId('extension-health-broken-ext')).toHaveTextContent(
      'Not working'
    );
    // Health chip AND switch are both present (not conflated).
    expect(screen.getByRole('switch')).toBeInTheDocument();
    openRow('broken-ext');
    expect(screen.getByText('Couldn’t build: Unexpected token')).toBeInTheDocument();
  });

  /**
   * A server-side rebuild that failed while the previous version keeps running
   * is said beside an otherwise healthy extension — never through `status`,
   * which is what the loader and `readBundle` gate the client bundle on
   * (DOR-1336 review round 2).
   */
  it('warns that the server half is stale without calling the extension broken', async () => {
    const ext = makeExtension({
      id: 'stale-srv',
      status: 'compiled',
      hasServerEntry: true,
      serverError: {
        code: 'compilation_failed',
        message: 'Server Compilation failed for stale-srv',
      },
    });
    mockFetch({ '/api/extensions': [ext] });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });
    await screen.findByTestId('extension-card-stale-srv');
    expect(screen.queryByTestId('extension-health-stale-srv')).not.toBeInTheDocument();
    openRow('stale-srv');

    expect(screen.getByText(/couldn’t rebuild its server part/i)).toBeInTheDocument();
    expect(screen.getByText(/last version still runs/i)).toBeInTheDocument();
    expect(screen.queryByText(/couldn’t build:/i)).not.toBeInTheDocument();
  });

  /**
   * A server half that stopped after crashing too often (DOR-2686) is not
   * running, so "the last version still runs" would be false. Its own
   * sentence is shown, once, with no doubled period.
   */
  it('says plainly that a stopped server half does not run', async () => {
    const ext = makeExtension({
      id: 'iso-ext',
      status: 'compiled',
      hasServerEntry: true,
      serverError: {
        code: 'server_crashed',
        message: 'Mail stopped unexpectedly 3 times. Reload it to try again.',
      },
    });
    mockFetch({ '/api/extensions': [ext] });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });
    await screen.findByTestId('extension-card-iso-ext');
    openRow('iso-ext');

    const line = screen.getByText('Mail stopped unexpectedly 3 times. Reload it to try again.');
    expect(line.textContent).not.toMatch(/\.\./);
    expect(screen.queryByText(/last version still runs/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/couldn’t rebuild/i)).not.toBeInTheDocument();
  });
});

describe('ExtensionsSettingsTab — what comes with DorkOS', () => {
  it('locks the switch with "Always on" for canDisable:false extensions', async () => {
    mockFetch({
      '/api/extensions': [
        makeExtension({
          id: 'locked',
          origin: 'core',
          status: 'active',
          manifest: { id: 'locked', name: 'Locked Core', version: '1.0.0', canDisable: false },
        }),
      ],
    });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });
    fireEvent.click(await screen.findByRole('button', { name: 'Comes with DorkOS · 1' }));

    expect(screen.getByTestId('extension-required-locked')).toHaveTextContent('Always on');
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('ignores canDisable:false on a user extension (lock applies to core only)', async () => {
    // The lock is origin-gated to match the server guard (ADR-0271).
    mockFetch({
      '/api/extensions': [
        makeExtension({
          id: 'user-locked',
          origin: 'user',
          status: 'active',
          manifest: { id: 'user-locked', name: 'User Locked', version: '1.0.0', canDisable: false },
        }),
      ],
    });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

    expect(await screen.findByRole('switch')).toBeInTheDocument();
    expect(screen.queryByTestId('extension-required-user-locked')).not.toBeInTheDocument();
  });

  it('never asks about a core extension, which ships inside DorkOS', async () => {
    mockFetch({
      '/api/extensions': [
        makeExtension({
          id: 'linear-issues',
          origin: 'core',
          hasServerEntry: true,
          // Even if the server said false, origin decides — DorkOS must not ask a
          // person for permission to run itself.
          approvedToRun: false,
        }),
      ],
    });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });
    fireEvent.click(await screen.findByRole('button', { name: 'Comes with DorkOS · 1' }));
    openRow('linear-issues');

    expect(screen.queryByTestId('extension-needs-approval-linear-issues')).not.toBeInTheDocument();
    expect(screen.queryByText('Review')).not.toBeInTheDocument();
    expect(screen.getByRole('switch')).toBeInTheDocument();
  });
});

describe('permission to run code inside DorkOS (DOR-516)', () => {
  // Purpose: the switch never approves. A row waiting for an OK shows Review in
  // its place, so no click on the list can turn it on without the panel.
  it('replaces the switch with Review, which opens the panel and focuses Allow', async () => {
    mockFetch({
      '/api/extensions': [
        makeExtension({ id: 'full-stack', hasServerEntry: true, approvedToRun: false }),
      ],
    });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

    const row = await screen.findByTestId('extension-card-full-stack');
    expect(within(row).queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.getByTestId('extension-health-full-stack')).toHaveTextContent('Needs your OK');
    fireEvent.click(within(row).getByRole('button', { name: 'Review Test Extension' }));

    const allow = await screen.findByTestId('extension-approve-run-full-stack');
    await waitFor(() => expect(allow).toHaveFocus());
    // Review hides while the row is open.
    expect(
      within(row).queryByRole('button', { name: 'Review Test Extension' })
    ).not.toBeInTheDocument();
    // Nothing was approved by opening it.
    expect(vi.mocked(fetch)).not.toHaveBeenCalledWith(
      expect.stringContaining('/approve'),
      expect.anything()
    );
  });

  // Purpose: one a person turned off still never offers a switch that would
  // run it unseen.
  it('offers Review, not a switch, for an unapproved extension that is off', async () => {
    mockFetch({
      '/api/extensions': [makeExtension({ id: 'off', status: 'disabled', approvedToRun: false })],
    });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

    const row = await screen.findByTestId('extension-card-off');
    expect(within(row).queryByRole('switch')).not.toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'Review Test Extension' }));
    expect(await screen.findByTestId('extension-approve-run-off')).toBeInTheDocument();
  });

  it('asks in Security’s words, with one line each for access, runs as and network', async () => {
    mockFetch({
      '/api/extensions': [
        makeExtension({
          id: 'full-stack',
          hasServerEntry: true,
          approvedToRun: false,
          isolation: null,
        }),
      ],
    });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });
    await screen.findByTestId('extension-card-full-stack');
    openRow('full-stack');

    const box = screen.getByTestId('extension-needs-approval-full-stack');
    expect(box).toHaveTextContent('Test Extension wants to run on this computer.');
    const facts = within(box).getByTestId('extension-permissions-full-stack');
    expect(facts).toHaveTextContent('AccessRuns inside DorkOS, with full access to this computer');
    expect(facts).toHaveTextContent('Runs asRuns as you');
    expect(within(box).getByRole('button', { name: 'Allow' })).toBeInTheDocument();
    expect(within(box).getByRole('button', { name: 'Not now' })).toBeInTheDocument();
  });

  it('changes nothing on Not now, and leaves the chip in place', async () => {
    mockFetch({
      '/api/extensions': [makeExtension({ id: 'w', approvedToRun: false })],
    });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });
    await screen.findByTestId('extension-card-w');
    const row = openRow('w');
    fireEvent.click(within(row).getByRole('button', { name: 'Not now' }));

    expect(row.querySelector('[data-row-button]')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('extension-health-w')).toHaveTextContent('Needs your OK');
    expect(vi.mocked(fetch)).not.toHaveBeenCalledWith(
      expect.stringContaining('/w/'),
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('says plainly when a project copy changed after DorkOS installed it', async () => {
    mockFetch({
      '/api/extensions': [
        makeExtension({ scope: 'local', approvedToRun: false, originProblem: 'changed' }),
      ],
    });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });
    await screen.findByTestId('extension-card-test-ext');
    openRow('test-ext');

    expect(screen.getByTestId('extension-origin-problem-test-ext')).toHaveTextContent(
      'Its files changed after install'
    );
  });

  it('says a waiting dev-linked extension runs from your folder, not from a shortcut', async () => {
    mockFetch({
      '/api/extensions': [
        makeExtension({ approvedToRun: false, originProblem: 'dev-link', devLink: { path: '/w' } }),
      ],
    });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });
    await screen.findByTestId('extension-card-test-ext');
    openRow('test-ext');

    expect(screen.getByTestId('extension-origin-problem-test-ext')).toHaveTextContent(
      'It runs from your folder'
    );
  });

  it('says plainly when a plugin holds a shortcut to files elsewhere', async () => {
    mockFetch({
      '/api/extensions': [makeExtension({ approvedToRun: false, originProblem: 'linked' })],
    });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });
    await screen.findByTestId('extension-card-test-ext');
    openRow('test-ext');

    expect(screen.getByTestId('extension-origin-problem-test-ext')).toHaveTextContent(
      'links to files elsewhere'
    );
  });

  it('sends the approval and confirms it, so one click is the whole job', async () => {
    const digest = `sha256:${'b'.repeat(64)}`;
    mockFetch({
      '/api/extensions': [
        makeExtension({
          id: 'full-stack',
          origin: 'user',
          hasServerEntry: true,
          approvedToRun: false,
          digest,
        }),
      ],
      '/api/extensions/full-stack/approve': {
        extension: makeExtension({ id: 'full-stack', hasServerEntry: true, approvedToRun: true }),
      },
    });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });
    await screen.findByTestId('extension-card-full-stack');
    openRow('full-stack');
    fireEvent.click(screen.getByTestId('extension-approve-run-full-stack'));

    await waitFor(() => {
      expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
        expect.stringContaining('can now run inside DorkOS')
      );
    });
    // It binds the copy the panel shows, and the files it was drawn for (DOR-3068).
    const approveCall = vi
      .mocked(fetch)
      .mock.calls.find(([url]) => String(url).endsWith('/api/extensions/full-stack/approve'));
    expect(JSON.parse(String((approveCall?.[1] as RequestInit | undefined)?.body))).toEqual({
      version: '1.0.0',
      plugin: null,
      expectedDigest: digest,
    });
  });

  it('shows an approved extension with a way to stop it running', async () => {
    mockFetch({
      '/api/extensions': [
        makeExtension({ id: 'full-stack', hasServerEntry: true, approvedToRun: true }),
      ],
    });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });
    await screen.findByTestId('extension-card-full-stack');
    openRow('full-stack');

    expect(screen.queryByTestId('extension-needs-approval-full-stack')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop it running' })).toBeInTheDocument();
  });

  it('surfaces the server refusal verbatim when the caller is not allowed to approve', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.includes('/approve')) {
          return Promise.resolve({
            ok: false,
            status: 403,
            json: () =>
              Promise.resolve({
                error: 'Only a person can approve an extension to run inside DorkOS',
              }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              makeExtension({ id: 'full-stack', hasServerEntry: true, approvedToRun: false }),
            ]),
        });
      })
    );

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });
    await screen.findByTestId('extension-card-full-stack');
    openRow('full-stack');
    fireEvent.click(screen.getByTestId('extension-approve-run-full-stack'));

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        'Couldn’t let it run.',
        expect.objectContaining({
          description: 'Only a person can approve an extension to run inside DorkOS',
        })
      );
    });
  });
});

describe('screens paused (DOR-3068)', () => {
  // Purpose: an extension allowed to run whose screen code changed is never a
  // silent "allowed": it says so, in Security's words, with what changed.
  it('asks again in Security’s words, says what changed, and allows the new version', async () => {
    const digest = `sha256:${'c'.repeat(64)}`;
    const paused = makeExtension({
      id: 'ledger',
      manifest: { id: 'ledger', name: 'Ledger', version: '2.3.0' },
      approvedToRun: true,
      screensPaused: true,
      bundleReady: false,
      digest,
    });
    mockFetch({
      '/api/extensions': [paused],
      '/api/extensions/pending-approvals': {
        approvals: [
          {
            id: 'ledger',
            name: 'Ledger',
            version: '2.3.0',
            plugin: null,
            sourceLabel: '',
            runsInServer: false,
            adds: null,
            since: new Date().toISOString(),
            why: '',
            changedFiles: ['client.js'],
            updatedFrom: '2.2.1',
          },
        ],
      },
      '/api/extensions/ledger/approve': { extension: { ...paused, screensPaused: false } },
    });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

    const row = await screen.findByTestId('extension-card-ledger');
    expect(within(row).getByTestId('extension-health-ledger')).toHaveTextContent('Needs your OK');
    expect(within(row).queryByRole('switch')).not.toBeInTheDocument();
    openRow('ledger');

    const panel = screen.getByTestId('extension-screens-paused-ledger');
    expect(panel).toHaveTextContent(
      'Ledger’s files changed since you allowed it. Its screens are paused until you look.'
    );
    await waitFor(() =>
      expect(screen.getByTestId('extension-changed-ledger')).toHaveTextContent(
        'Version 2.2.1 → 2.3.0 · client.js · Noticed'
      )
    );
    expect(within(panel).getByRole('button', { name: 'Keep paused' })).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Allow the new version' }));

    await waitFor(() => {
      const call = vi
        .mocked(fetch)
        .mock.calls.find(([url]) => String(url).endsWith('/api/extensions/ledger/approve'));
      expect(JSON.parse(String((call?.[1] as RequestInit).body))).toMatchObject({
        expectedDigest: digest,
      });
    });
  });
});

describe('what an extension can reach (DOR-2686)', () => {
  const ISOLATION: NonNullable<ExtensionRecordPublic['isolation']> = {
    runtime: 'subprocess',
    net: ['imap.fastmail.com'],
    run: ['git', 'bash'],
    resolvedRun: [
      { name: 'git', path: '/usr/bin/git' },
      { name: 'bash', path: '/bin/bash' },
    ],
    agents: false,
    memoryMb: 256,
  };

  // Purpose: a waiting isolated extension lists what it can reach above the
  // yes, makes no "full access" claim, and warns about an interpreter.
  it('lists what a waiting isolated extension can reach', async () => {
    mockFetch({
      '/api/extensions': [
        makeExtension({
          id: 'mail',
          hasServerEntry: true,
          approvedToRun: false,
          bundleReady: false,
          isolation: ISOLATION,
        }),
      ],
    });
    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });
    await screen.findByTestId('extension-card-mail');
    openRow('mail');

    const box = screen.getByTestId('extension-needs-approval-mail');
    const facts = within(box).getByTestId('extension-permissions-mail');
    expect(facts).toHaveTextContent('AccessRuns on its own, apart from DorkOS');
    expect(facts).toHaveTextContent('NetworkCan reach imap.fastmail.com');
    const extras = within(box).getByTestId('extension-permission-extras-mail');
    expect(extras).toHaveTextContent('Can run: git');
    expect(extras).toHaveTextContent('Can run bash, which can run any program.');
    expect(within(box).queryByText(/full access/)).not.toBeInTheDocument();
  });

  // Purpose: "Allow" echoes the set the panel listed.
  it('sends the listed set with the yes', async () => {
    mockFetch({
      '/api/extensions': [
        makeExtension({
          id: 'mail',
          hasServerEntry: true,
          approvedToRun: false,
          isolation: ISOLATION,
        }),
      ],
      '/api/extensions/mail/approve': {
        extension: makeExtension({ id: 'mail', approvedToRun: true, isolation: ISOLATION }),
      },
    });
    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });
    await screen.findByTestId('extension-card-mail');
    openRow('mail');
    fireEvent.click(screen.getByTestId('extension-approve-run-mail'));
    await waitFor(() =>
      expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Test Extension can now run')
    );
    const call = vi
      .mocked(fetch)
      .mock.calls.find(([url]) => String(url).endsWith('/api/extensions/mail/approve'));
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({
      version: '1.0.0',
      plugin: null,
      permissions: {
        runtime: 'subprocess',
        net: ['imap.fastmail.com'],
        run: ['git', 'bash'],
        agents: false,
      },
    });
  });

  // Purpose: a stale yes says so in plain words, and the redrawn panel leads
  // with what the refused one did not list.
  it('says plainly when the extension changed since the panel was drawn', async () => {
    let current = ISOLATION;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.includes('/approve')) {
          // It widened while the panel was on screen.
          current = { ...ISOLATION, net: [...ISOLATION.net, 'api.example.com'] };
          return Promise.resolve({
            ok: false,
            status: 409,
            json: () =>
              Promise.resolve({ error: 'This extension changed.', code: 'stale_approval' }),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              makeExtension({ id: 'mail', approvedToRun: false, isolation: current }),
            ]),
        });
      })
    );
    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });
    await screen.findByTestId('extension-card-mail');
    openRow('mail');
    fireEvent.click(screen.getByTestId('extension-approve-run-mail'));
    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        'Test Extension changed since you saw it. Check it again.'
      )
    );
    await waitFor(() =>
      expect(
        screen.getByTestId('extension-permission-extras-mail').querySelector('li')
      ).toHaveTextContent('Now also wants to connect to: api.example.com')
    );
  });
});
