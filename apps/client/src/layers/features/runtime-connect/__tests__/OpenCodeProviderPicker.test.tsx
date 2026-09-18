// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SystemRequirements } from '@dorkos/shared/agent-runtime';
import type { OpenCodeDirectSetup } from '@dorkos/shared/runtime-connect';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { setPlatformAdapter } from '@/layers/shared/lib';
import { RuntimeSetupDialog } from '@/layers/entities/runtime';
import { renderRuntimeConnect } from '../ui/RuntimeConnectFlow';
import { OpenCodeProviderPicker } from '../ui/OpenCodeProviderPicker';
import { DirectProviderPath } from '../ui/DirectProviderPath';

beforeAll(() => {
  // Radix Select needs DOM APIs jsdom lacks to open its listbox under userEvent.
  const proto = Element.prototype as unknown as Record<string, unknown>;
  if (!proto.hasPointerCapture) proto.hasPointerCapture = vi.fn();
  if (!proto.releasePointerCapture) proto.releasePointerCapture = vi.fn();
  if (!proto.scrollIntoView) proto.scrollIntoView = vi.fn();
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
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
        'Claude, GPT, Gemini and 300+ more, running in the cloud. Your hardware doesn’t matter.'
      )
    ).toBeInTheDocument();
    expect(screen.getByText('Private and free, on your computer')).toBeInTheDocument();
    // Platform-adaptive noun (jsdom navigator.platform is not Mac → "this computer").
    expect(
      screen.getByText(/Models run on this computer. Nothing you type ever leaves it\./)
    ).toBeInTheDocument();
    expect(screen.getByText('I have my own API key')).toBeInTheDocument();
    expect(
      screen.getByText(/Connect straight to Anthropic, OpenAI, or any OpenAI-compatible server/)
    ).toBeInTheDocument();
  });
});

// Three cards of four lines each is a wall to read before you have chosen
// anything. The list says the headline and the one line under it; the detail
// waits until you have picked a path, where it is what you actually need.
describe('OpenCodeProviderPicker — the list is short, the detail is at the step (DOR-917)', () => {
  const CLOUD_SUB = 'One OpenRouter account covers all of them. Pay only for what you use.';
  const CLOUD_TRADE_OFF = 'Your prompts and code are sent to the model’s provider.';
  const LOCAL_SUB = 'Runs Quick helpers and Solid coders. Frontier models stay cloud-only.';
  const LOCAL_TRADE_OFF =
    'Smaller models: great for edits and quick help, not frontier-level reasoning.';

  it('keeps the sub-line and the trade-off off the choose list', () => {
    renderPicker();

    expect(screen.queryByText(CLOUD_SUB)).not.toBeInTheDocument();
    expect(screen.queryByText(LOCAL_SUB)).not.toBeInTheDocument();
    expect(screen.queryByText(/Trade-off:/)).not.toBeInTheDocument();
    // What survives on a card: the headline, its badge, and the one line under it.
    expect(screen.getByText('Best models, zero setup')).toBeInTheDocument();
    expect(screen.getByTestId('power-source-cloud')).toHaveTextContent('Recommended');
  });

  it('says the cloud path’s sub-line and trade-off at the step, word for word', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByTestId('power-source-cloud'));

    const details = await screen.findByTestId('connect-step-details');
    expect(details).toHaveTextContent(CLOUD_SUB);
    expect(details).toHaveTextContent(`Trade-off: ${CLOUD_TRADE_OFF}`);
  });

  it('says the local path’s sub-line and trade-off at the step, word for word', async () => {
    const user = userEvent.setup();
    renderPicker({ detectOllama: vi.fn().mockResolvedValue({ running: false, models: [] }) });

    await user.click(screen.getByTestId('power-source-local'));

    const details = await screen.findByTestId('connect-step-details');
    expect(details).toHaveTextContent(LOCAL_SUB);
    expect(details).toHaveTextContent(`Trade-off: ${LOCAL_TRADE_OFF}`);
  });

  it('adds nothing to the quiet key path, which was already two lines', async () => {
    const user = userEvent.setup();
    renderPicker();

    await user.click(screen.getByTestId('power-source-direct'));

    expect(await screen.findByLabelText('API key')).toBeInTheDocument();
    expect(screen.queryByTestId('connect-step-details')).not.toBeInTheDocument();
  });

  it('commits nothing on the way in: Back returns to the list unchanged', async () => {
    const user = userEvent.setup();
    const transport = renderPicker();

    await user.click(screen.getByTestId('power-source-cloud'));
    await user.click(await screen.findByTestId('connect-step-back'));

    expect(screen.getByTestId('opencode-power-sources')).toBeInTheDocument();
    expect(transport.storeOpenRouterKey).not.toHaveBeenCalled();
    expect(transport.storeProviderCredential).not.toHaveBeenCalled();
  });
});

describe('OpenCodeProviderPicker — Change power source label (spec §9)', () => {
  function renderWithProvider(currentProvider: string) {
    const transport = createMockTransport();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <OpenCodeProviderPicker currentProvider={currentProvider} />
        </TransportProvider>
      </QueryClientProvider>
    );
  }

  it('labels the current source in plain language for the local path', () => {
    renderWithProvider('ollama');
    expect(screen.getByTestId('opencode-current-source')).toHaveTextContent(
      'Currently: On your computer (Ollama)'
    );
  });

  it('labels the current source for the cloud path', () => {
    renderWithProvider('openrouter');
    expect(screen.getByTestId('opencode-current-source')).toHaveTextContent(
      'Currently: Cloud via OpenRouter'
    );
  });

  it('labels a bring-your-own-key source by provider name', () => {
    renderWithProvider('openai');
    expect(screen.getByTestId('opencode-current-source')).toHaveTextContent(
      'Currently: Your own API key (OpenAI)'
    );
  });

  it('omits the current-source line on a first connect (no currentProvider)', () => {
    renderPicker();
    expect(screen.queryByTestId('opencode-current-source')).not.toBeInTheDocument();
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
    // The address is behind Advanced for a named service — it is noise for the
    // person who picked OpenAI and only matters to the one who did not.
    expect(screen.queryByLabelText(/base url/i)).not.toBeInTheDocument();
    await user.click(screen.getByTestId('direct-provider-advanced'));
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
    await user.click(screen.getByTestId('direct-provider-advanced'));
    // The field is prefilled with OpenAI's own address, so an override replaces it.
    await user.clear(screen.getByLabelText(/base url/i));
    await user.type(screen.getByLabelText(/base url/i), 'https://api.example.com/v1');
    await user.click(screen.getByRole('button', { name: 'Save & connect' }));

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
    await user.click(screen.getByRole('button', { name: 'Save & connect' }));

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
    await user.click(screen.getByRole('button', { name: 'Save & connect' }));

    const panel = await screen.findByTestId('runtime-connected-panel');
    expect(panel).toHaveTextContent('OpenCode is connected.');
    // Direct is provider-honest — no frontier claim (a Direct key can point at a
    // local LM Studio / vLLM server), just the connection + handoff line.
    expect(panel).toHaveTextContent('This session will use OpenCode');
    expect(panel).not.toHaveTextContent('Frontier models are unlocked.');

    await user.click(screen.getByTestId('runtime-connected-done'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('RuntimeSetupDialog — Change a connected OpenCode (spec §9)', () => {
  const OPENCODE_READY_OLLAMA: SystemRequirements = {
    runtimes: {
      opencode: {
        state: 'ready',
        provider: 'ollama',
        dependencies: [{ name: 'OpenCode CLI', description: 'binary', status: 'satisfied' }],
      },
    },
  };

  function renderReady(
    requirements: SystemRequirements,
    overrides: Partial<Parameters<typeof createMockTransport>[0]> = {}
  ) {
    const transport = createMockTransport({
      getCapabilities: vi.fn().mockResolvedValue({
        capabilities: { opencode: { type: 'opencode' } },
        defaultRuntime: 'opencode',
      }),
      checkRequirements: vi.fn().mockResolvedValue(requirements),
      ...overrides,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <RuntimeSetupDialog
            runtime="opencode"
            open
            onOpenChange={vi.fn()}
            renderConnect={renderRuntimeConnect}
            showConnectSuccess
          />
        </TransportProvider>
      </QueryClientProvider>
    );
  }

  it('offers Change on a ready, provider-connected OpenCode and reopens the picker with the current source', async () => {
    const user = userEvent.setup();
    renderReady(OPENCODE_READY_OLLAMA);

    // Ready, so no Connect CTA — but a Change affordance is present.
    const change = await screen.findByTestId('runtime-change-opencode');
    await user.click(change);

    // The picker reopens, prefilled with the current source label.
    expect(await screen.findByTestId('opencode-power-sources')).toBeInTheDocument();
    expect(screen.getByTestId('opencode-current-source')).toHaveTextContent(
      'Currently: On your computer (Ollama)'
    );
    // Selecting a new source reaches its connect step (the normal connect flow).
    await user.click(screen.getByTestId('power-source-cloud'));
    expect(await screen.findByLabelText('OpenRouter key')).toBeInTheDocument();
  });

  it('ends an in-place switch in the success panel with Done, cancel gone', async () => {
    // Purpose (spec §9): switching source on a ready runtime is not a dead end —
    // a successful switch reaches the same success moment a first connect does,
    // and the "Keep current source" cancel disappears once switched.
    const user = userEvent.setup();
    renderReady(OPENCODE_READY_OLLAMA, {
      storeProviderCredential: vi.fn().mockResolvedValue({ ref: 'file:openai' }),
    });

    await user.click(await screen.findByTestId('runtime-change-opencode'));
    // Switch to a Direct provider and complete the connect.
    await user.click(await screen.findByTestId('power-source-direct'));
    await user.type(await screen.findByLabelText('API key'), 'sk-direct-xyz');
    await user.click(screen.getByRole('button', { name: 'Save & connect' }));

    // The success panel replaces the change UI; the cancel affordance is gone.
    const panel = await screen.findByTestId('runtime-connected-panel');
    expect(panel).toHaveTextContent('OpenCode is connected.');
    expect(screen.queryByTestId('runtime-change-cancel-opencode')).not.toBeInTheDocument();
    expect(screen.getByTestId('runtime-connected-done')).toBeInTheDocument();
  });

  it('does not offer Change when the ready runtime reports no connected provider', async () => {
    const user = userEvent.setup();
    renderReady({
      runtimes: {
        opencode: {
          state: 'ready',
          dependencies: [{ name: 'OpenCode CLI', description: 'binary', status: 'satisfied' }],
        },
      },
    });

    // Ready badge appears, but with no provider there is nothing to change.
    await screen.findByTestId('runtime-ready-opencode');
    expect(screen.queryByTestId('runtime-change-opencode')).not.toBeInTheDocument();
    // Guard the assertion isn't vacuous.
    expect(user).toBeDefined();
  });
});

// DOR-2123 (report FB-48): check the key before saving it, give me a Test
// button, and show me what I entered last time.
describe('DirectProviderPath — the form remembers what you entered', () => {
  /** Render the key form on its own, with a given saved setup. */
  function renderDirect(overrides: Partial<Parameters<typeof createMockTransport>[0]> = {}) {
    const transport = createMockTransport(overrides);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <DirectProviderPath />
        </TransportProvider>
      </QueryClientProvider>
    );
    return transport;
  }

  it('reopens with the saved source, address, and a hint naming the last four of the key', async () => {
    renderDirect({
      getOpenCodeDirectSetup: vi.fn().mockResolvedValue({
        providerId: 'openai',
        baseURL: 'https://lm.example.com:8000/v1',
        key: { saved: true, last4: 'ab12' },
      }),
    });

    // A saved `openai` pointing somewhere other than OpenAI reopens as "Other",
    // with its address on screen rather than hidden behind Advanced.
    expect(await screen.findByRole('combobox')).toHaveTextContent('Other (OpenAI-compatible)');
    expect(screen.getByLabelText(/base url/i)).toHaveValue('https://lm.example.com:8000/v1');
    expect(screen.getByLabelText('API key')).toHaveAttribute(
      'placeholder',
      'Saved · ends in ab12 — paste a new key to replace it'
    );
  });

  it('shows a progress row rather than a flash of empty fields while it loads', () => {
    renderDirect({
      getOpenCodeDirectSetup: vi.fn(() => new Promise<OpenCodeDirectSetup>(() => {})),
    });
    expect(screen.getByTestId('connect-progress')).toBeInTheDocument();
    expect(screen.queryByLabelText('API key')).not.toBeInTheDocument();
  });

  it('follows the chosen source with its own key format hint', async () => {
    const user = userEvent.setup();
    renderDirect();

    expect(await screen.findByLabelText('API key')).toHaveAttribute('placeholder', 'sk-…');
    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'Anthropic' }));

    expect(screen.getByLabelText('API key')).toHaveAttribute('placeholder', 'sk-ant-…');
  });

  it('requires an address for an OpenAI-compatible server, and nothing else does', async () => {
    const user = userEvent.setup();
    renderDirect();

    await user.type(await screen.findByLabelText('API key'), 'sk-test-key');
    expect(screen.getByRole('button', { name: 'Save & connect' })).toBeEnabled();

    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: 'Other (OpenAI-compatible)' }));

    // The address is now shown, empty (the last service's address is not carried
    // into "not that service"), required, and both actions wait for it.
    expect(screen.getByLabelText(/base url/i)).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Save & connect' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Test key' })).toBeDisabled();
    await user.type(screen.getByLabelText(/base url/i), 'https://lm.example.com:8000/v1');
    expect(screen.getByRole('button', { name: 'Save & connect' })).toBeEnabled();
  });
});

describe('DirectProviderPath — the Test button', () => {
  function renderDirect(overrides: Partial<Parameters<typeof createMockTransport>[0]> = {}) {
    const transport = createMockTransport(overrides);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <DirectProviderPath />
        </TransportProvider>
      </QueryClientProvider>
    );
    return transport;
  }

  it('says the key works, and saves nothing', async () => {
    const user = userEvent.setup();
    const transport = renderDirect({
      checkProviderCredential: vi.fn().mockResolvedValue({ ok: true }),
    });

    await user.type(await screen.findByLabelText('API key'), 'sk-good-key');
    await user.click(screen.getByRole('button', { name: 'Test key' }));

    expect(await screen.findByText('Key works')).toBeInTheDocument();
    expect(transport.checkProviderCredential).toHaveBeenCalledWith('openai', 'sk-good-key', null);
    expect(transport.storeProviderCredential).not.toHaveBeenCalled();
  });

  it('shows the service’s own words when the key is refused, as a plain line', async () => {
    const user = userEvent.setup();
    renderDirect({
      checkProviderCredential: vi.fn().mockResolvedValue({
        ok: false,
        reason: 'rejected',
        message: 'That key was not accepted. Check it and try again.',
      }),
    });

    await user.type(await screen.findByLabelText('API key'), 'sk-bad-key');
    await user.click(screen.getByRole('button', { name: 'Test key' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That key was not accepted. Check it and try again.'
    );
    // No Retry: there is nothing to retry blindly. The key or the address is
    // wrong, both are fixed in the fields above, and Test is still right there.
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test key' })).toBeEnabled();
  });

  it('forgets a stale answer as soon as the key is edited', async () => {
    const user = userEvent.setup();
    renderDirect({ checkProviderCredential: vi.fn().mockResolvedValue({ ok: true }) });

    await user.type(await screen.findByLabelText('API key'), 'sk-good-key');
    await user.click(screen.getByRole('button', { name: 'Test key' }));
    expect(await screen.findByText('Key works')).toBeInTheDocument();

    await user.type(screen.getByLabelText('API key'), 'x');
    await waitFor(() => expect(screen.queryByText('Key works')).not.toBeInTheDocument());
  });
});

describe('DirectProviderPath — nothing is saved until the key is accepted', () => {
  function renderDirect(overrides: Partial<Parameters<typeof createMockTransport>[0]> = {}) {
    const transport = createMockTransport(overrides);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <DirectProviderPath />
        </TransportProvider>
      </QueryClientProvider>
    );
    return transport;
  }

  it('keeps the form and the typed key on screen when the key is refused', async () => {
    const user = userEvent.setup();
    const SECRET = 'sk-typo-key-999';
    const transport = renderDirect({
      checkProviderCredential: vi.fn().mockResolvedValue({
        ok: false,
        reason: 'rejected',
        message: 'That key was not accepted. Check it and try again.',
      }),
    });

    await user.type(await screen.findByLabelText('API key'), SECRET);
    await user.click(screen.getByRole('button', { name: 'Save & connect' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That key was not accepted. Check it and try again.'
    );
    // Nothing was stored, and the key is still there to fix rather than retype.
    expect(transport.storeProviderCredential).not.toHaveBeenCalled();
    expect(screen.getByLabelText('API key')).toHaveValue(SECRET);
  });

  it('will not move a saved key to a new address — it asks for the key again', async () => {
    const user = userEvent.setup();
    const transport = renderDirect({
      getOpenCodeDirectSetup: vi.fn().mockResolvedValue({
        providerId: 'openai',
        baseURL: null,
        key: { saved: true, last4: 'ab12' },
      }),
    });

    await user.click(await screen.findByTestId('direct-provider-advanced'));
    await user.clear(screen.getByLabelText(/base url/i));
    await user.type(screen.getByLabelText(/base url/i), 'https://moved.example.com/v1');

    // The server would ignore a caller-named address for a saved key, so the
    // form says why rather than offering a button that quietly does otherwise.
    expect(screen.getByTestId('direct-provider-repaste')).toHaveTextContent(
      'Paste your key again to change the address.'
    );
    expect(screen.getByRole('button', { name: 'Save & connect' })).toBeDisabled();
    // Testing the saved key against an address it was never saved for would
    // answer a question nobody asked, so that is off too.
    expect(screen.getByRole('button', { name: 'Test key' })).toBeDisabled();
    expect(transport.storeProviderCredential).not.toHaveBeenCalled();
  });

  it('saves to the new address once the key is pasted again', async () => {
    const user = userEvent.setup();
    const transport = renderDirect({
      getOpenCodeDirectSetup: vi.fn().mockResolvedValue({
        providerId: 'openai',
        baseURL: null,
        key: { saved: true, last4: 'ab12' },
      }),
      checkProviderCredential: vi.fn().mockResolvedValue({ ok: true }),
      storeProviderCredential: vi.fn().mockResolvedValue({ ref: 'file:openai' }),
    });

    await user.click(await screen.findByTestId('direct-provider-advanced'));
    await user.clear(screen.getByLabelText(/base url/i));
    await user.type(screen.getByLabelText(/base url/i), 'https://moved.example.com/v1');
    await user.type(screen.getByLabelText('API key'), 'sk-pasted-again');

    expect(screen.queryByTestId('direct-provider-repaste')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save & connect' }));

    await waitFor(() =>
      expect(transport.storeProviderCredential).toHaveBeenCalledWith(
        'openai',
        'sk-pasted-again',
        'https://moved.example.com/v1'
      )
    );
  });

  it('leaves Save off when a key is saved and nothing has changed', async () => {
    renderDirect({
      getOpenCodeDirectSetup: vi.fn().mockResolvedValue({
        providerId: 'openai',
        baseURL: null,
        key: { saved: true, last4: 'ab12' },
      }),
    });

    // Nothing to save — but the saved key can still be tested.
    expect(await screen.findByRole('button', { name: 'Save & connect' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Test key' })).toBeEnabled();
  });
});

// Picking a power source fills its own address in, so nobody has to know one.
describe('DirectProviderPath — a named source brings its own address', () => {
  function renderDirect(overrides: Partial<Parameters<typeof createMockTransport>[0]> = {}) {
    const transport = createMockTransport(overrides);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <DirectProviderPath />
        </TransportProvider>
      </QueryClientProvider>
    );
    return transport;
  }

  /** Pick a power source from the list by its visible label. */
  async function pick(user: ReturnType<typeof userEvent.setup>, label: string) {
    await user.click(await screen.findByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: label }));
  }

  it('offers the named sources from the shared list, plus Other', async () => {
    const user = userEvent.setup();
    renderDirect();

    await user.click(await screen.findByRole('combobox'));
    const names = screen.getAllByRole('option').map((option) => option.textContent);
    expect(names).toEqual(['OpenAI', 'Anthropic', 'Other (OpenAI-compatible)']);
  });

  it('fills the chosen source’s own address into the field', async () => {
    const user = userEvent.setup();
    renderDirect();

    await pick(user, 'Anthropic');
    await user.click(screen.getByTestId('direct-provider-advanced'));
    expect(screen.getByLabelText(/base url/i)).toHaveValue('https://api.anthropic.com');
  });

  it('says plainly when an address is not encrypted, without opening Advanced', async () => {
    const user = userEvent.setup();
    renderDirect();

    // Nothing to warn about while the address is an https one.
    expect(await screen.findByLabelText('API key')).toBeInTheDocument();
    expect(screen.queryByTestId('direct-provider-insecure')).not.toBeInTheDocument();

    await pick(user, 'Other (OpenAI-compatible)');
    await user.type(screen.getByLabelText(/base url/i), 'http://lm.example.com:8000/v1');

    // On the face of the form: the person who never opens Advanced is exactly
    // the one who needs telling.
    expect(screen.getByTestId('direct-provider-insecure')).toHaveTextContent(
      'This address isn’t encrypted. Your key travels in the open.'
    );
  });

  it('offers no "Get an API key" link for a source with no such page', async () => {
    const user = userEvent.setup();
    renderDirect();

    expect(await screen.findByRole('link', { name: /Get an API key/ })).toBeInTheDocument();
    await pick(user, 'Other (OpenAI-compatible)');
    expect(screen.queryByRole('link', { name: /Get an API key/ })).not.toBeInTheDocument();
  });

  it('does not send a base URL for a source that already sits at its own address', async () => {
    const user = userEvent.setup();
    const transport = renderDirect({
      checkProviderCredential: vi.fn().mockResolvedValue({ ok: true }),
      storeProviderCredential: vi.fn().mockResolvedValue({ ref: 'file:anthropic' }),
    });

    await pick(user, 'Anthropic');
    await user.type(screen.getByLabelText('API key'), 'sk-ant-key');
    await user.click(screen.getByRole('button', { name: 'Save & connect' }));

    // `OPENAI_BASE_URL` is set from whatever is stored, so storing Anthropic's
    // own address here would point an OpenAI variable at Anthropic.
    await waitFor(() =>
      expect(transport.storeProviderCredential).toHaveBeenCalledWith(
        'anthropic',
        'sk-ant-key',
        null
      )
    );
  });
});

describe('DirectProviderPath — reopening tells the services apart by address', () => {
  function renderWith(setup: OpenCodeDirectSetup) {
    const transport = createMockTransport({
      getOpenCodeDirectSetup: vi.fn().mockResolvedValue(setup),
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <DirectProviderPath />
        </TransportProvider>
      </QueryClientProvider>
    );
    return transport;
  }

  const CASES: Array<{ name: string; setup: OpenCodeDirectSetup; expected: string }> = [
    {
      name: 'openai with no address is OpenAI',
      setup: { providerId: 'openai', baseURL: null, key: { saved: true, last4: 'ab12' } },
      expected: 'OpenAI',
    },
    {
      name: 'openai at its own address is still OpenAI',
      setup: {
        providerId: 'openai',
        baseURL: 'https://api.openai.com/v1',
        key: { saved: false },
      },
      expected: 'OpenAI',
    },
    {
      name: 'openai anywhere else is an OpenAI-compatible server',
      setup: {
        providerId: 'openai',
        baseURL: 'https://lm.example.com:8000/v1',
        key: { saved: false },
      },
      expected: 'Other (OpenAI-compatible)',
    },
    {
      name: 'anthropic is Anthropic, address or not',
      setup: {
        providerId: 'anthropic',
        baseURL: 'https://proxy.example.com',
        key: { saved: false },
      },
      expected: 'Anthropic',
    },
    {
      name: 'nothing saved opens on OpenAI',
      setup: { providerId: null, baseURL: null, key: { saved: false } },
      expected: 'OpenAI',
    },
  ];

  it.each(CASES)('$name', async ({ setup, expected }) => {
    renderWith(setup);
    expect(await screen.findByRole('combobox')).toHaveTextContent(expected);
  });

  it('warns about an unencrypted address on reopen too', async () => {
    renderWith({
      providerId: 'openai',
      baseURL: 'http://lm.example.com:8000/v1',
      key: { saved: true, last4: 'ab12' },
    });
    expect(await screen.findByTestId('direct-provider-insecure')).toBeInTheDocument();
  });
});

describe('DirectProviderPath — when the saved settings cannot be read', () => {
  it('offers a retry instead of spinning for good', async () => {
    const user = userEvent.setup();
    const getOpenCodeDirectSetup = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ providerId: null, baseURL: null, key: { saved: false } });
    const transport = createMockTransport({ getOpenCodeDirectSetup });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <DirectProviderPath />
        </TransportProvider>
      </QueryClientProvider>
    );

    // A failed read is not a read still running: no permanent spinner.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t load your saved settings.'
    );
    expect(screen.queryByTestId('connect-progress')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText('API key')).toBeInTheDocument();
  });
});

describe('DirectProviderPath — the Test result says WHICH key it is about', () => {
  function renderDirect(overrides: Partial<Parameters<typeof createMockTransport>[0]> = {}) {
    const transport = createMockTransport(overrides);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <DirectProviderPath />
        </TransportProvider>
      </QueryClientProvider>
    );
    return transport;
  }

  const SAVED = {
    getOpenCodeDirectSetup: vi.fn().mockResolvedValue({
      providerId: 'openai',
      baseURL: null,
      key: { saved: true, last4: 'ab12' },
    }),
    checkProviderCredential: vi.fn().mockResolvedValue({ ok: true }),
  };

  it('says "Your saved key works" when the field is empty', async () => {
    const user = userEvent.setup();
    const transport = renderDirect({ ...SAVED });

    await user.click(await screen.findByRole('button', { name: 'Test key' }));

    expect(await screen.findByText('Your saved key works')).toBeInTheDocument();
    expect(transport.checkProviderCredential).toHaveBeenCalledWith('openai', null, null);
  });

  it('treats a field holding only whitespace as empty', async () => {
    const user = userEvent.setup();
    const transport = renderDirect({ ...SAVED });

    await user.type(await screen.findByLabelText('API key'), '   ');
    await user.click(screen.getByRole('button', { name: 'Test key' }));

    expect(await screen.findByText('Your saved key works')).toBeInTheDocument();
    expect(transport.checkProviderCredential).toHaveBeenCalledWith('openai', null, null);
  });

  it('says "Key works" about a key that was actually typed', async () => {
    const user = userEvent.setup();
    renderDirect({ ...SAVED });

    await user.type(await screen.findByLabelText('API key'), 'sk-typed-key');
    await user.click(screen.getByRole('button', { name: 'Test key' }));

    expect(await screen.findByText('Key works')).toBeInTheDocument();
    expect(screen.queryByText('Your saved key works')).not.toBeInTheDocument();
  });
});

describe('DirectProviderPath — another path’s saved source is not this form’s', () => {
  function renderWithProvider(providerId: string) {
    const transport = createMockTransport({
      getOpenCodeDirectSetup: vi
        .fn()
        .mockResolvedValue({ providerId, baseURL: null, key: { saved: true, last4: 'ab12' } }),
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <DirectProviderPath />
        </TransportProvider>
      </QueryClientProvider>
    );
  }

  it.each(['openrouter', 'ollama'])(
    'treats a saved %s as nothing saved here — no prefill, no saved-key hint',
    async (providerId) => {
      renderWithProvider(providerId);

      // `runtimes.opencode.provider` is shared with the cloud and local paths,
      // so it can name a source this form does not own. Prefilling from it would
      // claim a key that is not this form's and offer to overwrite it.
      expect(await screen.findByRole('combobox')).toHaveTextContent('OpenAI');
      expect(screen.getByLabelText('API key')).toHaveAttribute('placeholder', 'sk-…');
      expect(screen.queryByLabelText(/base url/i)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Test key' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Save & connect' })).toBeDisabled();
    }
  );
});

// Browser-found on the real app (Settings → Runtimes → OpenCode → Change →
// I have my own API key): the form left the page while a save was in flight,
// the panel lost its height, and the refusal came back off-screen.
describe('DirectProviderPath — the form stays put while it works', () => {
  function renderDirect(overrides: Partial<Parameters<typeof createMockTransport>[0]> = {}) {
    const transport = createMockTransport(overrides);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <DirectProviderPath />
        </TransportProvider>
      </QueryClientProvider>
    );
    return transport;
  }

  /** A promise this test decides when to settle. */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it('keeps the fields mounted (and read-only) while the save is in flight', async () => {
    const user = userEvent.setup();
    const gate = deferred<{ ok: true }>();
    renderDirect({ checkProviderCredential: vi.fn(() => gate.promise) });

    await user.type(await screen.findByLabelText('API key'), 'sk-in-flight');
    await user.click(screen.getByRole('button', { name: 'Save & connect' }));

    // The form is still on the page, so the panel keeps its height and the
    // scroll position — which is what put the refusal off-screen before.
    expect(await screen.findByTestId('connect-progress')).toHaveTextContent('Checking your key…');
    expect(screen.getByTestId('direct-provider')).toBeInTheDocument();
    expect(screen.getByLabelText('API key')).toHaveValue('sk-in-flight');
    // Read-only rather than gone: nothing can be changed out from under the
    // request that is already running.
    expect(screen.getByLabelText('API key')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save & connect' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Test key' })).toBeDisabled();

    await act(async () => {
      gate.resolve({ ok: true });
    });
  });

  it('replaces a failed Test result with the save’s answer, never both at once', async () => {
    const user = userEvent.setup();
    const refusal = {
      ok: false as const,
      reason: 'rejected' as const,
      message: 'That key was not accepted. Check it and try again.',
    };
    renderDirect({ checkProviderCredential: vi.fn().mockResolvedValue(refusal) });

    await user.type(await screen.findByLabelText('API key'), 'sk-bad-key');
    await user.click(screen.getByRole('button', { name: 'Test key' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save & connect' }));

    // Exactly one message on screen — the same refusal twice, once from the
    // stale Test row and once from the save, is what this prevents.
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(1));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'That key was not accepted. Check it and try again.'
    );
  });

  it('puts the cursor back in the key field after a refusal', async () => {
    const user = userEvent.setup();
    renderDirect({
      checkProviderCredential: vi.fn().mockResolvedValue({
        ok: false,
        reason: 'rejected',
        message: 'That key was not accepted. Check it and try again.',
      }),
    });

    await user.type(await screen.findByLabelText('API key'), 'sk-typo');
    await user.click(screen.getByRole('button', { name: 'Save & connect' }));

    await screen.findByRole('alert');
    // Reading a message and then hunting for the field it is about is the thing
    // this avoids: the fix happens where the cursor already is.
    await waitFor(() => expect(screen.getByLabelText('API key')).toHaveFocus());
  });
});
