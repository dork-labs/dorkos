// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  OllamaFitVerdict,
  OllamaModelCatalog,
  OllamaPullProgress,
  OllamaPullResult,
  OllamaStatus,
} from '@dorkos/shared/runtime-connect';
import type { SystemRequirements } from '@dorkos/shared/agent-runtime';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { localDeviceNoun } from '@/layers/shared/lib';
import { RuntimeSetupDialog } from '@/layers/entities/runtime';
import { renderRuntimeConnect } from '../ui/RuntimeConnectFlow';
import { OllamaLocalPath, type OllamaLocalPathProps } from '../ui/OllamaLocalPath';

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

/** A curated catalog with one tiered model at the given hardware-fit verdict. */
function makeCatalog(verdict: OllamaFitVerdict = 'runs-well'): OllamaModelCatalog {
  return {
    hardware: { totalRamBytes: 32 * 1024 ** 3, vramBytes: null, unifiedMemory: true },
    models: [
      {
        model: {
          id: 'qwen2.5-coder:7b',
          label: 'Qwen2.5 Coder 7B',
          paramsB: 7,
          downloadBytes: 4.7 * 1024 ** 3,
          sizeLabel: '~4.7 GB',
          minMemoryBytes: 6 * 1024 ** 3,
          note: 'A capable everyday coding model; not frontier.',
          tier: 'solid-coder',
        },
        verdict,
        // Realistic server explanations END with the caveat (the server owns it) —
        // so the UI must show it exactly once, not twice.
        explanation:
          verdict === 'runs-well'
            ? 'Your ~32 GB of memory comfortably fits this ~4.7 GB model. An estimate, not a benchmark.'
            : 'This model may not fit comfortably in memory. An estimate, not a benchmark.',
      },
    ],
  };
}

/** Ollama running with one already-installed model, assessed with an honest verdict. */
function makeRunningWithInstalled(): OllamaStatus {
  return {
    running: true,
    models: [{ name: 'llama3.1:8b' }],
    installed: [
      {
        id: 'llama3.1:8b',
        sizeBytes: 4.9 * 1024 ** 3,
        assessment: {
          model: {
            id: 'llama3.1:8b',
            label: 'Llama 3.1 8B',
            paramsB: 8,
            downloadBytes: 4.9 * 1024 ** 3,
            sizeLabel: '~4.9 GB',
            minMemoryBytes: 6 * 1024 ** 3,
            note: 'A capable everyday model; not frontier.',
            tier: 'quick-helper',
          },
          verdict: 'runs-well',
          explanation: 'Comfortably fits in memory. An estimate, not a benchmark.',
        },
      },
    ],
  };
}

function renderLocalPath(
  overrides: Partial<Parameters<typeof createMockTransport>[0]> = {},
  props: Partial<OllamaLocalPathProps> = {}
) {
  const transport = createMockTransport({
    detectOllama: vi.fn().mockResolvedValue({ running: true, models: [] }),
    getOllamaModelCatalog: vi.fn().mockResolvedValue(makeCatalog()),
    ...overrides,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <OllamaLocalPath active {...props} />
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

describe('OllamaLocalPath — Ollama not running', () => {
  it('shows the installer link and no raw error', async () => {
    renderLocalPath({ detectOllama: vi.fn().mockResolvedValue({ running: false, models: [] }) });

    expect(await screen.findByTestId('ollama-absent')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /install ollama/i })).toHaveAttribute(
      'href',
      'https://ollama.com/download'
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('OllamaLocalPath — running with an installed model', () => {
  it('shows the status line, the installed model + verdict, and connects via Use', async () => {
    const user = userEvent.setup();
    const transport = renderLocalPath({
      detectOllama: vi.fn().mockResolvedValue(makeRunningWithInstalled()),
    });

    const statusLine = await screen.findByTestId('ollama-status-line');
    expect(statusLine).toHaveTextContent(
      `Ollama is running · 1 models installed · nothing you type leaves ${localDeviceNoun()}`
    );

    const installedItem = await screen.findByTestId('ollama-installed-item');
    expect(installedItem).toHaveTextContent('llama3.1:8b');
    expect(installedItem).toHaveTextContent(/runs well/i);
    expect(screen.queryByLabelText(/api key/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^use$/i }));

    await waitFor(() => {
      expect(transport.updateConfig).toHaveBeenCalledWith({
        runtimes: { opencode: { provider: 'ollama' } },
      });
    });
  });
});

describe('OllamaLocalPath — curated "Add a model" shelf', () => {
  it('renders each curated model with its size + honest fit verdict', async () => {
    renderLocalPath({
      getOllamaModelCatalog: vi.fn().mockResolvedValue(makeCatalog('may-be-slow')),
    });

    const shelf = await screen.findByTestId('ollama-shelf');
    expect(shelf).toHaveTextContent('Qwen2.5 Coder 7B');
    expect(shelf).toHaveTextContent('~4.7 GB');
    expect(shelf).toHaveTextContent(/may be slow/i);
  });

  it('streams progress on Get, then connects with zero auth on completion', async () => {
    const user = userEvent.setup();
    let resolvePull: (r: OllamaPullResult) => void = () => {};
    const pullPromise = new Promise<OllamaPullResult>((resolve) => {
      resolvePull = resolve;
    });
    const pullOllamaModel = vi
      .fn()
      .mockImplementation(
        (
          _model: string,
          onProgress?: (p: OllamaPullProgress) => void
        ): Promise<OllamaPullResult> => {
          onProgress?.({ status: 'downloading', completed: 5, total: 10, percent: 50 });
          return pullPromise;
        }
      );
    const transport = renderLocalPath({ pullOllamaModel });

    await user.click(await screen.findByRole('button', { name: /get/i }));

    const progress = await screen.findByTestId('guided-pull-progress');
    expect(progress).toHaveTextContent(/50%/);
    expect(pullOllamaModel).toHaveBeenCalledWith('qwen2.5-coder:7b', expect.any(Function));

    await act(async () => {
      resolvePull({ ok: true, model: 'qwen2.5-coder:7b' });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(transport.updateConfig).toHaveBeenCalledWith({
        runtimes: { opencode: { provider: 'ollama' } },
      });
    });
  });

  it('a failed pull shows a retryable error and never connects', async () => {
    const user = userEvent.setup();
    const transport = renderLocalPath({
      pullOllamaModel: vi.fn().mockResolvedValue({
        ok: false,
        model: 'qwen2.5-coder:7b',
        error: 'Not enough disk space',
      }),
    });

    await user.click(await screen.findByRole('button', { name: /get/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/not enough disk space/i);
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(transport.updateConfig).not.toHaveBeenCalled();
  });
});

describe('OllamaLocalPath — pull any model by name', () => {
  it('submits a valid tag to pullOllamaModel', async () => {
    const user = userEvent.setup();
    const pullOllamaModel = vi.fn().mockResolvedValue({ ok: true, model: 'qwen2.5-coder:32b' });
    renderLocalPath({ pullOllamaModel });

    await user.type(await screen.findByTestId('ollama-pull-by-name'), 'qwen2.5-coder:32b');
    await user.click(screen.getByRole('button', { name: /^pull$/i }));

    await waitFor(() => {
      expect(pullOllamaModel).toHaveBeenCalledWith('qwen2.5-coder:32b', expect.any(Function));
    });
  });

  it('never submits a syntactically invalid tag', async () => {
    const user = userEvent.setup();
    const pullOllamaModel = vi.fn();
    renderLocalPath({ pullOllamaModel });

    await user.type(await screen.findByTestId('ollama-pull-by-name'), 'Not A Tag!');
    const submit = screen.getByRole('button', { name: /^pull$/i });
    expect(submit).toBeDisabled();

    await user.click(submit);
    expect(pullOllamaModel).not.toHaveBeenCalled();
  });
});

describe('OllamaLocalPath — library link and escape hatch', () => {
  it('links "Browse the library" to the Ollama library', async () => {
    renderLocalPath();
    expect(await screen.findByRole('link', { name: /browse the library/i })).toHaveAttribute(
      'href',
      'https://ollama.com/library'
    );
  });

  it('calls onConnectDirectly when the escape-hatch row is clicked', async () => {
    const user = userEvent.setup();
    const onConnectDirectly = vi.fn();
    renderLocalPath({}, { onConnectDirectly });

    await user.click(await screen.findByTestId('local-connect-directly'));
    expect(onConnectDirectly).toHaveBeenCalledTimes(1);
  });
});

// The provider-picker connect flips OpenCode to Ready through the T0 dialog
// shell — proving the local panel rides the existing Connect CTA, not a
// parallel path. No `showConnectSuccess`, so the dialog shows the Ready badge
// once requirements refetch, not the explicit success panel.
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

describe('OllamaLocalPath — flips OpenCode to Ready through the RuntimeSetupDialog', () => {
  it('a completed pull flips OpenCode to Ready with no manual refresh', async () => {
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
      detectOllama: vi.fn().mockResolvedValue({ running: true, models: [] }),
      getOllamaModelCatalog: vi.fn().mockResolvedValue(makeCatalog()),
      pullOllamaModel: vi.fn().mockResolvedValue({ ok: true, model: 'qwen2.5-coder:7b' }),
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

    // Navigate the picker to the Local path, then pull the curated model.
    await user.click(await screen.findByTestId('power-source-local'));
    await user.click(await screen.findByRole('button', { name: /get/i }));

    await waitFor(() => {
      expect(screen.getByTestId('runtime-ready-opencode')).toBeInTheDocument();
    });
  });
});
