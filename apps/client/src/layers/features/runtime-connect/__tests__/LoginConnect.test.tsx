// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SystemRequirements } from '@dorkos/shared/agent-runtime';
import type { DelegatedLoginResult } from '@dorkos/shared/runtime-connect';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { RuntimeSetupDialog } from '@/layers/entities/runtime';
import { renderRuntimeConnect } from '../ui/RuntimeConnectFlow';
import { LoginConnect } from '../ui/LoginConnect';

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
  vi.clearAllMocks();
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Render a bare connect flow with the providers its mutations need. */
function renderFlow(
  ui: ReactNode,
  overrides: Partial<Parameters<typeof createMockTransport>[0]> = {}
) {
  const transport = createMockTransport(overrides);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{ui}</TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

// A connect-then-ready pair so the integration tests can prove the runtime
// flips to Ready via ['requirements'] invalidation (no manual "Check again").
function connectThenReady(type: string, connectLabel: string) {
  const connect: SystemRequirements = {
    runtimes: {
      [type]: {
        state: 'connect',
        connect: { kind: 'login', label: connectLabel },
        dependencies: [
          { name: `${type} CLI`, description: 'binary', status: 'satisfied' },
          { name: `${type} auth`, description: 'auth', status: 'missing' },
        ],
      },
    },
  };
  const ready: SystemRequirements = {
    runtimes: {
      [type]: {
        state: 'ready',
        dependencies: [{ name: `${type} CLI`, description: 'binary', status: 'satisfied' }],
      },
    },
  };
  return { connect, ready };
}

/** Render the live dialog so the requirements query genuinely refetches after invalidation. */
function renderDialog(
  type: string,
  overrides: Partial<Parameters<typeof createMockTransport>[0]> = {}
) {
  const transport = createMockTransport({
    getCapabilities: vi.fn().mockResolvedValue({
      capabilities: { [type]: { type } },
      defaultRuntime: type,
    }),
    ...overrides,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <RuntimeSetupDialog
      runtime={type}
      open
      onOpenChange={vi.fn()}
      renderConnect={renderRuntimeConnect}
    />,
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>{children}</TransportProvider>
        </QueryClientProvider>
      ),
    }
  );
  return transport;
}

describe('LoginConnect — Codex (task 2.4)', () => {
  it('stores a pasted key, flips Codex to Ready, and never renders the key', async () => {
    // Purpose: the sanctioned paste-key path posts the credential and (via
    // ['requirements'] invalidation) refetches Codex to Ready — while the secret
    // never appears as visible text or a readable field afterwards.
    const user = userEvent.setup();
    const SECRET = 'sk-codex-supersecret-999';
    const { connect, ready } = connectThenReady('codex', 'Connect Codex');
    let call = 0;
    const transport = renderDialog('codex', {
      checkRequirements: vi.fn(() => {
        call += 1;
        return Promise.resolve(call === 1 ? connect : ready);
      }),
      storeRuntimeCredential: vi.fn().mockResolvedValue({ ref: 'file:codex' }),
    });

    const input = await screen.findByLabelText('OpenAI API key');
    expect(input).toHaveAttribute('type', 'password');
    await user.type(input, SECRET);
    await user.click(screen.getByRole('button', { name: 'Save key' }));

    expect(transport.storeRuntimeCredential).toHaveBeenCalledWith('codex', SECRET);

    await waitFor(() => {
      expect(screen.getByTestId('runtime-ready-codex')).toBeInTheDocument();
    });
    // The secret is gone: not visible text, not a readable field value.
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(SECRET)).not.toBeInTheDocument();
  });

  it('signs in with ChatGPT, shows progress, and flips to Ready on completion', async () => {
    // Purpose: the delegated `codex login` path shows honest progress while the
    // CLI login runs and flips Codex to Ready once completion is detected.
    const user = userEvent.setup();
    const { connect, ready } = connectThenReady('codex', 'Connect Codex');
    const login = deferred<DelegatedLoginResult>();
    let call = 0;
    renderDialog('codex', {
      checkRequirements: vi.fn(() => {
        call += 1;
        return Promise.resolve(call === 1 ? connect : ready);
      }),
      delegateRuntimeLogin: vi.fn(() => login.promise),
    });

    await user.click(await screen.findByRole('button', { name: 'Sign in with ChatGPT' }));
    expect(await screen.findByTestId('connect-progress')).toBeInTheDocument();

    await act(async () => {
      login.resolve({ ok: true });
    });
    await waitFor(() => {
      expect(screen.getByTestId('runtime-ready-codex')).toBeInTheDocument();
    });
  });

  it('shows an honest, retryable error when the delegated login times out', async () => {
    // Purpose: a hung/denied login must not fake success — it surfaces the
    // server's honest message and a retry, and never flips to Ready.
    const user = userEvent.setup();
    const { connect } = connectThenReady('codex', 'Connect Codex');
    renderDialog('codex', {
      checkRequirements: vi.fn().mockResolvedValue(connect),
      delegateRuntimeLogin: vi
        .fn()
        .mockResolvedValue({ ok: false, error: 'Sign-in timed out. Please try again.' }),
    });

    await user.click(await screen.findByRole('button', { name: 'Sign in with ChatGPT' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Sign-in timed out. Please try again.'
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByTestId('runtime-ready-codex')).not.toBeInTheDocument();
  });

  it('renders no install affordance for Codex (binary already resolved)', () => {
    // Purpose: Codex's flow is auth-only — the vendored binary is resolved in
    // T0, so no "Install" CTA should appear alongside the connect flow.
    renderFlow(<LoginConnect type="codex" />);
    expect(screen.queryByRole('button', { name: /install/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in with ChatGPT' })).toBeInTheDocument();
  });
});

describe('LoginConnect — Claude (task 2.5)', () => {
  it('delegate-login flips Claude to Ready on completion', async () => {
    // Purpose: Claude stays delegate-first — the Sign in button runs the
    // delegated login and flips to Ready, no reimplemented claude.ai OAuth.
    const user = userEvent.setup();
    const { connect, ready } = connectThenReady('claude-code', 'Connect Claude Code');
    let call = 0;
    renderDialog('claude-code', {
      checkRequirements: vi.fn(() => {
        call += 1;
        return Promise.resolve(call === 1 ? connect : ready);
      }),
      delegateRuntimeLogin: vi.fn().mockResolvedValue({ ok: true }),
    });

    await user.click(await screen.findByRole('button', { name: 'Sign in' }));
    await waitFor(() => {
      expect(screen.getByTestId('runtime-ready-claude-code')).toBeInTheDocument();
    });
  });

  it('stores a pasted Anthropic key without echoing the secret', async () => {
    // Purpose: the paste-key path stores an ANTHROPIC key by reference; the
    // secret never becomes a readable field after submit.
    const user = userEvent.setup();
    const SECRET = 'sk-ant-secret-777';
    const transport = renderFlow(<LoginConnect type="claude-code" />, {
      storeRuntimeCredential: vi.fn().mockResolvedValue({ ref: 'file:anthropic' }),
    });

    const input = screen.getByLabelText('Anthropic API key');
    await user.type(input, SECRET);
    await user.click(screen.getByRole('button', { name: 'Save key' }));

    expect(transport.storeRuntimeCredential).toHaveBeenCalledWith('claude-code', SECRET);
    await waitFor(() => {
      expect(screen.getByTestId('connect-connected')).toBeInTheDocument();
    });
    expect(screen.queryByDisplayValue(SECRET)).not.toBeInTheDocument();
  });

  it('exposes only delegate + paste-key affordances (no claude.ai OAuth UI)', () => {
    // Purpose: the Non-Goal — Claude connect never renders a reimplemented
    // claude.ai browser OAuth. Only the delegate sign-in + paste-key exist.
    renderFlow(<LoginConnect type="claude-code" />);
    const surface = screen.getByTestId('login-connect-claude-code');
    expect(within(surface).getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(within(surface).getByLabelText('Anthropic API key')).toBeInTheDocument();
    expect(within(surface).queryByText(/claude\.ai/i)).not.toBeInTheDocument();
    expect(within(surface).queryByRole('button', { name: /authorize/i })).not.toBeInTheDocument();
  });
});
