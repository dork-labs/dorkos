/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
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
    bundleReady: true,
    ...overrides,
  };
}

function mockFetch(responses: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const key = Object.keys(responses).find((k) => url.includes(k));
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
      '/api/extensions/my-ext/enable': { ...ext, status: 'active' },
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

  it('calls POST /api/extensions/:id/disable when toggling an active extension off', async () => {
    const ext = makeExtension({ id: 'my-ext', status: 'active' });
    mockFetch({
      '/api/extensions': [ext],
      '/api/extensions/my-ext/disable': { ...ext, status: 'disabled' },
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

  it('shows a reload-required toast after enabling/disabling', async () => {
    const ext = makeExtension({ id: 'my-ext', status: 'disabled' });
    mockFetch({
      '/api/extensions': [ext],
      '/api/extensions/my-ext/enable': { ...ext, status: 'active' },
    });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByTestId('extension-card-my-ext')).toBeInTheDocument();
    });

    const toggle = screen.getByRole('switch', { name: /enable test extension/i });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(toast.info).toHaveBeenCalledWith(
        expect.stringContaining('reload'),
        expect.objectContaining({ action: expect.objectContaining({ label: 'Reload now' }) })
      );
    });
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

  it('shows global badge for global-scoped extensions', async () => {
    mockFetch({ '/api/extensions': [makeExtension({ scope: 'global' })] });

    render(<ExtensionsSettingsTab />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('global')).toBeInTheDocument();
    });
  });
});
