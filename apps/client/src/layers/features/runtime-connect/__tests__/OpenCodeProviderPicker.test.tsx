// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SystemRequirements } from '@dorkos/shared/agent-runtime';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { setPlatformAdapter } from '@/layers/shared/lib';
import { RuntimeSetupDialog } from '@/layers/entities/runtime';
import { renderRuntimeConnect } from '../ui/RuntimeConnectFlow';
import { OpenCodeProviderPicker } from '../ui/OpenCodeProviderPicker';

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
  // Restore the standalone-web platform between tests (some flip to embedded).
  setPlatformAdapter({ isEmbedded: false, openFile: async () => {} });
});

function renderPicker(overrides: Partial<Parameters<typeof createMockTransport>[0]> = {}) {
  const transport = createMockTransport(overrides);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <OpenCodeProviderPicker />
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

describe('OpenCodeProviderPicker — structure', () => {
  it('renders all three provider paths (Local / Gateway / Direct)', () => {
    // Purpose: OpenCode's connect is "choose where the model comes from" — all
    // three paths must be reachable, Local featured first.
    renderPicker({ detectOllama: vi.fn().mockResolvedValue({ running: false, models: [] }) });
    expect(screen.getByRole('tab', { name: 'Local' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Gateway' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Direct' })).toBeInTheDocument();
  });
});

describe('OpenCodeProviderPicker — Local (Ollama, task 2.7/2.8)', () => {
  it('with a detected model, connects with NO auth input (zero-auth)', async () => {
    // Purpose: the hero path — a running Ollama with a pulled model connects
    // with no account and persists the provider selection (no key).
    const user = userEvent.setup();
    const transport = renderPicker({
      detectOllama: vi
        .fn()
        .mockResolvedValue({ running: true, models: [{ name: 'qwen2.5-coder:7b' }] }),
    });

    await user.click(await screen.findByRole('button', { name: 'Use this' }));

    expect(transport.updateConfig).toHaveBeenCalledWith({
      runtimes: { opencode: { provider: 'ollama' } },
    });
    // No secret was ever asked for on this path.
    expect(screen.queryByLabelText(/api key/i)).not.toBeInTheDocument();
    expect(await screen.findByText('Connected to Ollama')).toBeInTheDocument();
  });

  it('when Ollama is absent, shows the installer link, not an error', async () => {
    // Purpose: DorkOS detects, never manages — an absent Ollama routes to its
    // installer, honestly, without a raw error.
    renderPicker({ detectOllama: vi.fn().mockResolvedValue({ running: false, models: [] }) });

    const link = await screen.findByRole('link', { name: /install ollama/i });
    expect(link).toHaveAttribute('href', 'https://ollama.com/download');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('OpenCodeProviderPicker — Gateway (OpenRouter, task 2.6/2.8)', () => {
  it('paste-key stores a reference and populates the model dropdown', async () => {
    // Purpose: the easiest Gateway path — a validated key stores a reference and
    // the catalog populates the model dropdown.
    const user = userEvent.setup();
    const transport = renderPicker({
      storeOpenRouterKey: vi.fn().mockResolvedValue({ ok: true }),
      getOpenRouterModels: vi
        .fn()
        .mockResolvedValue([{ id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' }]),
    });

    await user.click(screen.getByRole('tab', { name: 'Gateway' }));
    await user.type(await screen.findByLabelText('OpenRouter key'), 'sk-or-abc123');
    await user.click(screen.getByRole('button', { name: 'Save key' }));

    expect(transport.storeOpenRouterKey).toHaveBeenCalledWith('sk-or-abc123');
    expect(await screen.findByRole('option', { name: 'Claude 3.5 Sonnet' })).toBeInTheDocument();
  });

  it('"Connect OpenRouter" starts the OAuth-PKCE flow and opens the authorize URL', async () => {
    // Purpose: the slickest Gateway path — OAuth-PKCE opens the authorize URL
    // and resolves to connected once the loopback callback exchanges the key.
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    renderPicker({
      startOpenRouterOAuth: vi
        .fn()
        .mockResolvedValue({ authorizeUrl: 'https://openrouter.ai/auth?x=1', state: 'st-1' }),
      getOpenRouterOAuthStatus: vi.fn().mockResolvedValue({ status: 'connected' }),
    });

    await user.click(screen.getByRole('tab', { name: 'Gateway' }));
    await user.click(await screen.findByRole('button', { name: 'Connect OpenRouter' }));

    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith(
        'https://openrouter.ai/auth?x=1',
        '_blank',
        'noopener,noreferrer'
      )
    );
    expect(await screen.findByText('Connected to OpenRouter')).toBeInTheDocument();
  });

  it('degrades to paste-key only in the Obsidian embedding (OAuth is browser-only)', async () => {
    // Purpose: DirectTransport stubs OAuth honestly — in embedded mode the
    // "Connect OpenRouter" button is absent; the always-available paste-key
    // path remains. Detected via the platform adapter, not window sniffing.
    setPlatformAdapter({ isEmbedded: true, openFile: async () => {} });
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByRole('tab', { name: 'Gateway' }));
    expect(screen.queryByRole('button', { name: 'Connect OpenRouter' })).not.toBeInTheDocument();
    expect(await screen.findByLabelText('OpenRouter key')).toBeInTheDocument();
  });
});

describe('OpenCodeProviderPicker — Direct provider (task 2.8)', () => {
  it('stores the key + base URL through the single Direct endpoint that backs it, never echoing the secret', async () => {
    // Purpose: bring-your-own-key. The Direct path calls ONE server method that
    // stores the key by reference AND records the provider + base URL — the real
    // Transport method the server now backs (not the runtime-credential store the
    // server rejects for a provider id). The secret is never echoed to the DOM.
    const user = userEvent.setup();
    const SECRET = 'sk-direct-secret-555';
    const transport = renderPicker({
      storeProviderCredential: vi.fn().mockResolvedValue({ ref: 'file:openai' }),
    });

    await user.click(screen.getByRole('tab', { name: 'Direct' }));
    await user.type(await screen.findByLabelText('API key'), SECRET);
    await user.type(screen.getByLabelText(/base url/i), 'https://api.example.com/v1');
    await user.click(screen.getByRole('button', { name: 'Connect provider' }));

    // One call carries the key + provider selection + base URL (server owns config).
    expect(transport.storeProviderCredential).toHaveBeenCalledWith(
      'openai',
      SECRET,
      'https://api.example.com/v1'
    );
    // The dead two-write path (raw runtime credential + a separate config write) is gone.
    expect(transport.storeRuntimeCredential).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('connect-connected')).toBeInTheDocument());
    expect(screen.queryByDisplayValue(SECRET)).not.toBeInTheDocument();
  });
});

// The provider-picker connect flips OpenCode to Ready through the T0 dialog
// shell — proving the single entry point (the existing Connect CTA) drives it.
const OPENCODE_CONNECT: SystemRequirements = {
  runtimes: {
    opencode: {
      state: 'connect',
      connect: { kind: 'provider-picker', label: 'Connect OpenCode' },
      dependencies: [{ name: 'OpenCode CLI', description: 'binary', status: 'satisfied' }],
    },
  },
  allSatisfied: false,
};
const OPENCODE_READY: SystemRequirements = {
  runtimes: {
    opencode: {
      state: 'ready',
      dependencies: [{ name: 'OpenCode CLI', description: 'binary', status: 'satisfied' }],
    },
  },
  allSatisfied: true,
};

describe('OpenCodeProviderPicker — flips OpenCode to Ready (task 2.8)', () => {
  it('the Ollama zero-auth connect flips OpenCode to Ready with no manual refresh', async () => {
    // Purpose: end-to-end through the existing Connect CTA — picking a local
    // Ollama model connects and (via ['requirements'] invalidation) refetches
    // OpenCode to Ready, no "Check again".
    const user = userEvent.setup();
    let call = 0;
    const transport = createMockTransport({
      getCapabilities: vi.fn().mockResolvedValue({
        capabilities: { opencode: { type: 'opencode' } },
        defaultRuntime: 'opencode',
      }),
      checkRequirements: vi.fn(() => {
        call += 1;
        return Promise.resolve(call === 1 ? OPENCODE_CONNECT : OPENCODE_READY);
      }),
      detectOllama: vi
        .fn()
        .mockResolvedValue({ running: true, models: [{ name: 'qwen2.5-coder' }] }),
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    render(
      <RuntimeSetupDialog
        runtime="opencode"
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

    await user.click(await screen.findByRole('button', { name: 'Use this' }));

    await waitFor(() => {
      expect(screen.getByTestId('runtime-ready-opencode')).toBeInTheDocument();
    });
  });

  it('the Direct-provider connect flips OpenCode to Ready (requirements invalidated)', async () => {
    // Purpose: prove the Direct path invalidates ['requirements'] end-to-end —
    // a stored provider key refetches OpenCode to Ready with no manual "Check again".
    const user = userEvent.setup();
    let call = 0;
    const transport = createMockTransport({
      getCapabilities: vi.fn().mockResolvedValue({
        capabilities: { opencode: { type: 'opencode' } },
        defaultRuntime: 'opencode',
      }),
      checkRequirements: vi.fn(() => {
        call += 1;
        return Promise.resolve(call === 1 ? OPENCODE_CONNECT : OPENCODE_READY);
      }),
      storeProviderCredential: vi.fn().mockResolvedValue({ ref: 'file:openai' }),
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    render(
      <RuntimeSetupDialog
        runtime="opencode"
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

    await user.click(await screen.findByRole('tab', { name: 'Direct' }));
    await user.type(await screen.findByLabelText('API key'), 'sk-direct-xyz');
    await user.click(screen.getByRole('button', { name: 'Connect provider' }));

    await waitFor(() => {
      expect(screen.getByTestId('runtime-ready-opencode')).toBeInTheDocument();
    });
  });
});
