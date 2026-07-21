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
} from '@dorkos/shared/runtime-connect';
import type { SystemRequirements } from '@dorkos/shared/agent-runtime';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { RuntimeSetupDialog } from '@/layers/entities/runtime';
import { renderRuntimeConnect } from '../ui/RuntimeConnectFlow';
import { OllamaLocalPath } from '../ui/OllamaLocalPath';

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

/** A curated catalog with one model at the given hardware-fit verdict. */
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
        },
        verdict,
        // Realistic server explanations END with the caveat (the server owns it,
        // ollama-catalog.ts) — so the UI must show it exactly once, not twice.
        explanation:
          verdict === 'runs-well'
            ? 'Your ~32 GB of memory comfortably fits this ~4.7 GB model. An estimate, not a benchmark.'
            : 'This model may not fit comfortably in memory. An estimate, not a benchmark.',
      },
    ],
  };
}

function renderLocalPath(overrides: Partial<Parameters<typeof createMockTransport>[0]> = {}) {
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
        <OllamaLocalPath active />
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

describe('GuidedOllamaPull — the curated CTA (task 3.6)', () => {
  it('with Ollama running and no coding model, shows the curated model + honest sizing + hardware verdict', async () => {
    // Purpose: the guided pull is offered — a curated model with an honest size
    // and a hardware-fit verdict framed as an estimate (never a benchmark).
    renderLocalPath({ getOllamaModelCatalog: vi.fn().mockResolvedValue(makeCatalog('runs-well')) });

    expect(await screen.findByTestId('guided-pull-card')).toBeInTheDocument();
    expect(screen.getByText('Qwen2.5 Coder 7B')).toBeInTheDocument();
    expect(screen.getByTestId('guided-pull-size')).toHaveTextContent('~4.7 GB');

    const verdict = screen.getByTestId('guided-pull-verdict');
    expect(verdict).toHaveAttribute('data-verdict', 'runs-well');
    expect(verdict).toHaveTextContent(/runs well/i);
    // Honest framing — always an estimate, and rendered EXACTLY ONCE (the
    // server string owns the caveat; the UI must not append a second copy).
    expect(verdict).toHaveTextContent(/an estimate, not a benchmark/i);
    expect(verdict.textContent?.match(/an estimate, not a benchmark/gi)).toHaveLength(1);

    // The honest capability caveat rides along (never oversold as frontier).
    expect(screen.getByText(/not frontier/i)).toBeInTheDocument();

    expect(screen.getByRole('button', { name: /pull qwen2\.5 coder 7b/i })).toBeInTheDocument();
  });

  it('carries the honest "may be slow" verdict through from the server', async () => {
    // Purpose: the verdict is server-driven, not invented — a may-be-slow model
    // reads honestly.
    renderLocalPath({
      getOllamaModelCatalog: vi.fn().mockResolvedValue(makeCatalog('may-be-slow')),
    });

    const verdict = await screen.findByTestId('guided-pull-verdict');
    expect(verdict).toHaveAttribute('data-verdict', 'may-be-slow');
    expect(verdict).toHaveTextContent(/may be slow/i);
  });
});

describe('GuidedOllamaPull — pull → stream → connect (task 3.6)', () => {
  it('streams progress and, on completion, connects to the local model with zero auth', async () => {
    // Purpose: a one-click pull streams real download progress, then connects
    // OpenCode to the pulled model with NO account (records the Ollama provider).
    const user = userEvent.setup();

    let resolvePull: (r: OllamaPullResult) => void = () => {};
    const pullPromise = new Promise<OllamaPullResult>((res) => {
      resolvePull = res;
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

    await user.click(await screen.findByRole('button', { name: /pull qwen2\.5 coder 7b/i }));

    // Real streamed progress — the bar + status reflect the 50% frame.
    const progress = await screen.findByTestId('guided-pull-progress');
    expect(progress).toHaveTextContent(/50%/);
    expect(pullOllamaModel).toHaveBeenCalledWith('qwen2.5-coder:7b', expect.any(Function));

    // Complete the pull → the hook connects (zero auth: provider recorded, no key).
    await act(async () => {
      resolvePull({ ok: true, model: 'qwen2.5-coder:7b' });
      await Promise.resolve();
    });

    const connected = await screen.findByTestId('guided-pull-connected');
    // Identity reads runtime + model (3.1): "OpenCode · qwen2.5-coder:7b".
    expect(connected).toHaveTextContent(/OpenCode/);
    expect(connected).toHaveTextContent(/qwen2\.5-coder:7b/);
    expect(transport.updateConfig).toHaveBeenCalledWith({
      runtimes: { opencode: { provider: 'ollama' } },
    });
    // No secret was ever asked for on this path.
    expect(screen.queryByLabelText(/api key/i)).not.toBeInTheDocument();
  });

  it('a failed pull surfaces an honest, retryable error and never connects', async () => {
    // Purpose: an honest { ok: false } stops before connecting — a retryable
    // error, never a false Ready.
    const user = userEvent.setup();
    const transport = renderLocalPath({
      pullOllamaModel: vi.fn().mockResolvedValue({
        ok: false,
        model: 'qwen2.5-coder:7b',
        error: 'Not enough disk space',
      }),
    });

    await user.click(await screen.findByRole('button', { name: /pull qwen2\.5 coder 7b/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/not enough disk space/i);
    // Retry is offered; the config was never written (no false connect/Ready).
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(transport.updateConfig).not.toHaveBeenCalled();
  });
});

// The provider-picker connect flips OpenCode to Ready through the T0 dialog
// shell — proving the guided pull rides the existing Connect CTA, not a parallel path.
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

describe('GuidedOllamaPull — flips OpenCode to Ready (task 3.6)', () => {
  it('a completed guided pull flips OpenCode to Ready with no manual refresh', async () => {
    // Purpose: end-to-end through the existing Connect CTA — pulling a curated
    // model connects and (via ['requirements'] invalidation) refetches OpenCode
    // to Ready, no "Check again".
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

    await user.click(await screen.findByRole('button', { name: /pull qwen2\.5 coder 7b/i }));

    await waitFor(() => {
      expect(screen.getByTestId('runtime-ready-opencode')).toBeInTheDocument();
    });
  });
});
