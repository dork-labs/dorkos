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

describe('OpenCodeProviderPicker — power-source list (spec §5)', () => {
  it('presents three power sources with cloud recommended and first', () => {
    // Purpose: a single-column choice list, not tabs — cloud (recommended), local,
    // and the quiet bring-your-own-key row, each reachable.
    renderPicker();
    const list = screen.getByTestId('opencode-power-sources');
    const cards = list.querySelectorAll('[data-testid^="power-source-"]');
    expect(cards).toHaveLength(3);
    // Cloud is first and carries the Recommended emphasis.
    expect(cards[0]).toHaveAttribute('data-testid', 'power-source-cloud');
    expect(cards[0]).toHaveTextContent('Recommended');
  });

  it('renders the approved copy for each source verbatim', () => {
    renderPicker();
    expect(screen.getByText('Best models, zero setup')).toBeInTheDocument();
    expect(
      screen.getByText(
        "Claude, GPT, Gemini and 300+ more, running in the cloud — your hardware doesn't matter."
      )
    ).toBeInTheDocument();
    expect(screen.getByText('Private and free, on your computer')).toBeInTheDocument();
    // Platform-adaptive noun (jsdom navigator.platform is not Mac → "this computer").
    expect(
      screen.getByText(/Models run on this computer — nothing you type ever leaves it\./)
    ).toBeInTheDocument();
    expect(screen.getByText('I have my own API key')).toBeInTheDocument();
    expect(
      screen.getByText(/Connect straight to Anthropic, OpenAI, or any OpenAI-compatible server/)
    ).toBeInTheDocument();
  });
});

describe('OpenCodeProviderPicker — in-dialog step navigation (spec §5)', () => {
  it('opens the cloud step and returns with Back', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByTestId('power-source-cloud'));
    // The OpenRouter connect step (OAuth button + paste-key), no model dropdown.
    expect(await screen.findByRole('button', { name: 'Connect OpenRouter' })).toBeInTheDocument();
    expect(screen.getByLabelText('OpenRouter key')).toBeInTheDocument();
    expect(screen.queryByTestId('opencode-power-sources')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('connect-step-back'));
    expect(screen.getByTestId('opencode-power-sources')).toBeInTheDocument();
  });

  it('opens the Direct step and returns with Back', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByTestId('power-source-direct'));
    expect(await screen.findByLabelText('API key')).toBeInTheDocument();
    expect(screen.getByLabelText(/base url/i)).toBeInTheDocument();

    await user.click(screen.getByTestId('connect-step-back'));
    expect(screen.getByTestId('power-source-local')).toBeInTheDocument();
  });

  it('opens the local step under its own header', async () => {
    const user = userEvent.setup();
    renderPicker({ detectOllama: vi.fn().mockResolvedValue({ running: false, models: [] }) });

    await user.click(screen.getByTestId('power-source-local'));
    const step = await screen.findByTestId('opencode-connect-step');
    expect(step).toHaveTextContent('Private and free, on your computer');
    expect(screen.getByTestId('connect-step-back')).toBeInTheDocument();
  });
});

describe('OpenCodeProviderPicker — Direct provider (spec §5)', () => {
  it('stores the key + base URL through the single Direct endpoint, never echoing the secret', async () => {
    const user = userEvent.setup();
    const SECRET = 'sk-direct-secret-555';
    const transport = renderPicker({
      storeProviderCredential: vi.fn().mockResolvedValue({ ref: 'file:openai' }),
    });

    await user.click(screen.getByTestId('power-source-direct'));
    await user.type(await screen.findByLabelText('API key'), SECRET);
    await user.type(screen.getByLabelText(/base url/i), 'https://api.example.com/v1');
    await user.click(screen.getByRole('button', { name: 'Connect provider' }));

    expect(transport.storeProviderCredential).toHaveBeenCalledWith(
      'openai',
      SECRET,
      'https://api.example.com/v1'
    );
    expect(transport.storeRuntimeCredential).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('connect-connected')).toBeInTheDocument());
    expect(screen.queryByDisplayValue(SECRET)).not.toBeInTheDocument();
  });
});

describe('OpenCodeProviderPicker — Gateway (OpenRouter, spec §5)', () => {
  it('paste-key stores a reference and reports connected (no model dropdown)', async () => {
    const user = userEvent.setup();
    const transport = renderPicker({
      storeOpenRouterKey: vi.fn().mockResolvedValue({ ok: true }),
    });

    await user.click(screen.getByTestId('power-source-cloud'));
    await user.type(await screen.findByLabelText('OpenRouter key'), 'sk-or-abc123');
    await user.click(screen.getByRole('button', { name: 'Save key' }));

    expect(transport.storeOpenRouterKey).toHaveBeenCalledWith('sk-or-abc123');
    expect(await screen.findByText('Connected to OpenRouter')).toBeInTheDocument();
    // The dead model dropdown is gone — no runtime-side model discovery here.
    expect(screen.queryByLabelText('Model')).not.toBeInTheDocument();
  });

  it('degrades to paste-key only in the Obsidian embedding (OAuth is browser-only)', async () => {
    setPlatformAdapter({ isEmbedded: true, openFile: async () => {} });
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByTestId('power-source-cloud'));
    expect(screen.queryByRole('button', { name: 'Connect OpenRouter' })).not.toBeInTheDocument();
    expect(await screen.findByLabelText('OpenRouter key')).toBeInTheDocument();
  });
});

// The provider-picker connect flips OpenCode to Ready through the T0 dialog shell,
// proving the single entry point (the existing Connect CTA) drives it.
const OPENCODE_CONNECT: SystemRequirements = {
  runtimes: {
    opencode: {
      state: 'connect',
      connect: { kind: 'provider-picker', label: 'Connect OpenCode' },
      dependencies: [{ name: 'OpenCode CLI', description: 'binary', status: 'satisfied' }],
    },
  },
};
const OPENCODE_READY: SystemRequirements = {
  runtimes: {
    opencode: {
      state: 'ready',
      dependencies: [{ name: 'OpenCode CLI', description: 'binary', status: 'satisfied' }],
    },
  },
};

function renderInDialog(
  overrides: Partial<Parameters<typeof createMockTransport>[0]>,
  dialogProps: { showConnectSuccess?: boolean; onOpenChange?: (open: boolean) => void } = {}
) {
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
    ...overrides,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <RuntimeSetupDialog
      runtime="opencode"
      open
      onOpenChange={dialogProps.onOpenChange ?? vi.fn()}
      renderConnect={renderRuntimeConnect}
      showConnectSuccess={dialogProps.showConnectSuccess}
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

describe('OpenCodeProviderPicker — flips OpenCode to Ready (spec §6)', () => {
  it('the Direct-provider connect flips OpenCode to Ready (requirements invalidated)', async () => {
    const user = userEvent.setup();
    renderInDialog({ storeProviderCredential: vi.fn().mockResolvedValue({ ref: 'file:openai' }) });

    await user.click(await screen.findByTestId('power-source-direct'));
    await user.type(await screen.findByLabelText('API key'), 'sk-direct-xyz');
    await user.click(screen.getByRole('button', { name: 'Connect provider' }));

    await waitFor(() => {
      expect(screen.getByTestId('runtime-ready-opencode')).toBeInTheDocument();
    });
  });

  it('shows the explicit success moment + Done when showConnectSuccess is set', async () => {
    // Purpose (spec §6): the toolbar flow ends on an explicit success panel with a
    // Done button that closes the dialog — not a silent auto-close.
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderInDialog(
      { storeProviderCredential: vi.fn().mockResolvedValue({ ref: 'file:openai' }) },
      { showConnectSuccess: true, onOpenChange }
    );

    await user.click(await screen.findByTestId('power-source-direct'));
    await user.type(await screen.findByLabelText('API key'), 'sk-direct-xyz');
    await user.click(screen.getByRole('button', { name: 'Connect provider' }));

    const panel = await screen.findByTestId('runtime-connected-panel');
    expect(panel).toHaveTextContent('OpenCode is connected.');
    expect(panel).toHaveTextContent('Frontier models are unlocked.');

    await user.click(screen.getByTestId('runtime-connected-done'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
