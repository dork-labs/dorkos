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
    ...overrides,
  };
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

    expect(screen.getByText('Loading extensions…')).toBeInTheDocument();
  });

  it('shows empty state when no extensions are installed', async () => {
    mockFetch({ '/api/extensions': [] });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('no-extensions')).toBeInTheDocument();
    });
    expect(screen.getByText('No extensions installed.')).toBeInTheDocument();
  });

  it('renders a card for each discovered extension', async () => {
    const extensions = [makeExtension({ id: 'ext-a' }), makeExtension({ id: 'ext-b' })];
    mockFetch({ '/api/extensions': extensions });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('extension-card-ext-a')).toBeInTheDocument();
    });
    expect(screen.getByTestId('extension-card-ext-b')).toBeInTheDocument();
  });

  it('shows scope badge on each card', async () => {
    mockFetch({ '/api/extensions': [makeExtension({ scope: 'local' })] });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('local')).toBeInTheDocument();
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

    await waitFor(() => {
      expect(screen.getByTestId('extension-card-my-ext')).toBeInTheDocument();
    });

    const toggle = screen.getByRole('switch', { name: /enable test extension/i });
    fireEvent.click(toggle);

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
      await waitFor(() => {
        expect(screen.getByTestId('extension-card-my-ext')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByRole('switch', { name: /enable test extension/i }));
      await waitFor(() => {
        expect(vi.mocked(toast.error)).toHaveBeenCalled();
      });
      // The refusal rides in `description`; the first argument is the short
      // headline. Reading the description is what pins "the server's sentence
      // reaches the person INTACT" — a prefix concatenated into the headline
      // would leave this assertion passing only if the sentence were also
      // whole, which is the property under test.
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
      // Byte-for-byte, and in the description rather than glued onto the
      // headline — the double-wrapped "Couldn’t turn that on.: DorkOS changed
      // nothing…" is exactly what this refuses to accept.
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
        "Failed to enable extension 'my-ext': 502"
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

    await waitFor(() => {
      expect(screen.getByTestId('extension-card-my-ext')).toBeInTheDocument();
    });

    const toggle = screen.getByRole('switch', { name: /disable test extension/i });
    fireEvent.click(toggle);

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

    await waitFor(() => {
      expect(screen.getByTestId('extension-card-my-ext')).toBeInTheDocument();
    });

    const toggle = screen.getByRole('switch', { name: /enable test extension/i });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        expect.stringContaining('/api/extensions/my-ext/enable'),
        expect.objectContaining({ method: 'POST' })
      );
    });
    // The switch itself is the confirmation — a toast saying the same thing
    // on top of it would be redundant.
    expect(toast.success).not.toHaveBeenCalled();
    // The change applies live via the SSE `extension_reloaded` handler, so the
    // user is never asked to reload the page.
    expect(toast.info).not.toHaveBeenCalled();
  });

  it('calls POST /api/extensions/reload and shows success toast on reload', async () => {
    const ext = makeExtension();
    mockFetch({
      '/api/extensions': [ext],
      '/api/extensions/reload': [ext],
    });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('reload-extensions-button')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('reload-extensions-button'));

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

  it('disables the toggle for incompatible extensions', async () => {
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

    await waitFor(() => {
      expect(screen.getByTestId('extension-card-incompat-ext')).toBeInTheDocument();
    });

    // The switch for an incompatible extension must be disabled
    const toggle = screen.getByRole('switch');
    expect(toggle).toBeDisabled();
  });

  it('shows version requirement message for incompatible extensions', async () => {
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

    await waitFor(() => {
      expect(screen.getByText(/requires dorkos.*99\.0\.0/i)).toBeInTheDocument();
    });
  });

  it('shows warning icon and error message for compile_error extensions', async () => {
    const ext = makeExtension({
      id: 'broken-ext',
      status: 'compile_error',
      error: { code: 'COMPILE_ERROR', message: 'Unexpected token' },
    });
    mockFetch({ '/api/extensions': [ext] });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('extension-card-broken-ext')).toBeInTheDocument();
    });

    expect(screen.getByText(/compilation error/i)).toBeInTheDocument();
    expect(screen.getByText(/unexpected token/i)).toBeInTheDocument();
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

    await waitFor(() => {
      expect(screen.getByTestId('extension-card-stale-srv')).toBeInTheDocument();
    });

    expect(screen.getByText(/server side failed to rebuild/i)).toBeInTheDocument();
    expect(screen.getByText(/previous version is still running/i)).toBeInTheDocument();
    // Not dressed up as a compile failure of the whole extension.
    expect(screen.queryByText(/compilation error/i)).not.toBeInTheDocument();
  });

  it('shows global badge for global-scoped extensions', async () => {
    mockFetch({ '/api/extensions': [makeExtension({ scope: 'global' })] });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('global')).toBeInTheDocument();
    });
  });
});

describe('ExtensionsSettingsTab — Core / Installed partition', () => {
  it('renders Core and Installed sections partitioned by origin', async () => {
    mockFetch({
      '/api/extensions': [
        makeExtension({
          id: 'marketplace',
          origin: 'core',
          manifest: { id: 'marketplace', name: 'Marketplace', version: '1.0.0' },
        }),
        makeExtension({
          id: 'user-ext',
          origin: 'user',
          manifest: { id: 'user-ext', name: 'User Ext', version: '1.0.0' },
        }),
      ],
    });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('core-extensions-section')).toBeInTheDocument();
    });
    expect(screen.getByText('Core extensions')).toBeInTheDocument();
    expect(screen.getByText('Installed extensions')).toBeInTheDocument();

    const coreSection = screen.getByTestId('core-extensions-section');
    expect(within(coreSection).getByTestId('extension-card-marketplace')).toBeInTheDocument();
    expect(within(coreSection).queryByTestId('extension-card-user-ext')).not.toBeInTheDocument();

    const installedSection = screen.getByTestId('installed-extensions-section');
    expect(within(installedSection).getByTestId('extension-card-user-ext')).toBeInTheDocument();
  });

  it('shows the Installed empty-state with a Marketplace pointer when no user extensions exist', async () => {
    mockFetch({
      '/api/extensions': [makeExtension({ id: 'marketplace', origin: 'core' })],
    });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('no-installed-extensions')).toBeInTheDocument();
    });
    expect(screen.getByText(/Marketplace/)).toBeInTheDocument();
  });

  it('locks the toggle with a "Required" hint for canDisable:false extensions', async () => {
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

    await waitFor(() => {
      expect(screen.getByTestId('extension-card-locked')).toBeInTheDocument();
    });
    expect(screen.getByTestId('extension-required-locked')).toBeInTheDocument();
    // A locked extension renders no interactive switch.
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('ignores canDisable:false on a user extension (lock applies to core only)', async () => {
    // The lock is origin-gated to match the server guard (ADR-0271): a
    // user/marketplace extension is always disableable even if its manifest
    // declares canDisable:false, so it must still render an interactive switch.
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

    await waitFor(() => {
      expect(screen.getByTestId('extension-card-user-locked')).toBeInTheDocument();
    });
    expect(screen.getByRole('switch')).toBeInTheDocument();
    expect(screen.queryByTestId('extension-required-user-locked')).not.toBeInTheDocument();
  });

  it('renders a normal interactive toggle when canDisable is omitted', async () => {
    mockFetch({
      '/api/extensions': [makeExtension({ id: 'normal', origin: 'core', status: 'active' })],
    });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('extension-card-normal')).toBeInTheDocument();
    });
    expect(screen.getByRole('switch')).toBeInTheDocument();
    expect(screen.queryByTestId('extension-required-normal')).not.toBeInTheDocument();
  });

  it('renders the health badge distinctly from the on/off toggle for errored extensions', async () => {
    mockFetch({
      '/api/extensions': [
        makeExtension({
          id: 'broken',
          origin: 'user',
          status: 'compile_error',
          error: { code: 'COMPILE_ERROR', message: 'boom' },
        }),
      ],
    });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('extension-card-broken')).toBeInTheDocument();
    });
    // Health badge AND toggle are both present (not conflated).
    expect(screen.getByTestId('extension-health-broken')).toBeInTheDocument();
    expect(screen.getByRole('switch')).toBeInTheDocument();
  });
});

describe('permission to run code inside DorkOS (DOR-516)', () => {
  it('asks the person about an unapproved extension that carries server code', async () => {
    mockFetch({
      '/api/extensions': [
        makeExtension({
          id: 'full-stack',
          origin: 'user',
          hasServerEntry: true,
          approvedToRun: false,
        }),
      ],
    });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('extension-needs-approval-full-stack')).toBeInTheDocument();
    });
    // The copy has to say what the person is deciding, in their terms — not
    // "unapproved extension" and not a status code.
    expect(screen.getByText(/waiting for you/i)).toBeInTheDocument();
    expect(screen.getByText(/anything DorkOS can/i)).toBeInTheDocument();
    // And it has to be TRUE. Nothing of an unapproved extension has run, in the
    // server or on this page, so the card says exactly that.
    expect(screen.getByText(/None of it has run yet/i)).toBeInTheDocument();
  });

  it('tells the truth about a client-only extension, which also has not run', async () => {
    // This card used to read "DorkOS has not run this extension here" and describe
    // the risk in the conditional. Both were false: the bundle was served and
    // activated in the browser the moment the page loaded, on the very screen the
    // person opens to decide. The server now withholds the bundle until they do.
    mockFetch({
      '/api/extensions': [
        makeExtension({
          id: 'client-only',
          origin: 'user',
          hasServerEntry: false,
          hasDataProxy: false,
          approvedToRun: false,
        }),
      ],
    });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('extension-needs-approval-client-only')).toBeInTheDocument();
    });
    expect(screen.getByText(/None of it has run yet/i)).toBeInTheDocument();
    expect(screen.getByText(/signed in as you/i)).toBeInTheDocument();
    expect(screen.queryByText(/has not run this extension here/i)).not.toBeInTheDocument();
  });

  it('sends the approval and confirms it, so one click is the whole job', async () => {
    mockFetch({
      '/api/extensions': [
        makeExtension({
          id: 'full-stack',
          origin: 'user',
          hasServerEntry: true,
          approvedToRun: false,
        }),
      ],
      '/api/extensions/full-stack/approve': {
        extension: makeExtension({ id: 'full-stack', hasServerEntry: true, approvedToRun: true }),
      },
    });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('extension-approve-run-full-stack')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('extension-approve-run-full-stack'));

    await waitFor(() => {
      expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
        expect.stringContaining('can now run inside DorkOS')
      );
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      expect.stringContaining('/api/extensions/full-stack/approve'),
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('shows an approved extension as allowed, with a way to stop it', async () => {
    mockFetch({
      '/api/extensions': [
        makeExtension({
          id: 'full-stack',
          origin: 'user',
          hasServerEntry: true,
          approvedToRun: true,
        }),
      ],
    });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('extension-run-allowed-full-stack')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('extension-needs-approval-full-stack')).not.toBeInTheDocument();
    expect(screen.getByText('Stop it')).toBeInTheDocument();
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

    await waitFor(() => {
      expect(screen.getByTestId('extension-card-linear-issues')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('extension-needs-approval-linear-issues')).not.toBeInTheDocument();
    expect(screen.queryByTestId('extension-run-allowed-linear-issues')).not.toBeInTheDocument();
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
              makeExtension({
                id: 'full-stack',
                origin: 'user',
                hasServerEntry: true,
                approvedToRun: false,
              }),
            ]),
        });
      })
    );

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('extension-approve-run-full-stack')).toBeInTheDocument();
    });
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
