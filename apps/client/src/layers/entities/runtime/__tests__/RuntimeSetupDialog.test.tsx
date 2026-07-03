// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SystemRequirements } from '@dorkos/shared/agent-runtime';
import type { RuntimeProvisionProgress, RuntimeProvisionResult } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { RuntimeSetupPanel, RuntimeSetupDialog } from '../ui/RuntimeSetupDialog';

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

// A realistic server payload: Claude Ready, Codex needs login, OpenCode needs
// a one-click install — each carrying the derived `state`/`connect` projection.
const THREE_SIBLINGS: SystemRequirements = {
  runtimes: {
    'claude-code': {
      state: 'ready',
      dependencies: [
        {
          name: 'Claude Code CLI',
          description: 'Powers agent sessions.',
          status: 'satisfied',
          version: '2.1.0',
        },
      ],
    },
    codex: {
      state: 'connect',
      connect: { kind: 'login', label: 'Connect Codex' },
      dependencies: [
        { name: 'Codex CLI', description: 'The Codex CLI binary.', status: 'satisfied' },
        {
          name: 'Codex authentication',
          description: 'ChatGPT or API-key auth.',
          status: 'missing',
          installHint: 'codex login',
          infoUrl: 'https://developers.openai.com/codex',
        },
      ],
    },
    opencode: {
      state: 'connect',
      connect: { kind: 'install', label: 'Install OpenCode' },
      dependencies: [
        {
          name: 'OpenCode CLI',
          description: 'The OpenCode binary.',
          status: 'missing',
          installHint: 'npm i -g opencode-ai',
        },
      ],
    },
  },
  allSatisfied: false,
};

const REGISTERED = ['claude-code', 'codex', 'opencode'];

/** Wrap a presentational panel with the providers its OpenCode Connect button needs. */
function renderPanel(ui: ReactNode) {
  const transport = createMockTransport();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{ui}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('RuntimeSetupPanel — Ready/Connect model', () => {
  it('shows Ready and NO Connect for a state:ready runtime', () => {
    // Purpose: a ready runtime is a settled identity, not an action. Fails if a
    // Connect CTA leaks onto a runtime that needs nothing.
    renderPanel(
      <RuntimeSetupPanel
        runtime="claude-code"
        requirements={THREE_SIBLINGS}
        registeredTypes={REGISTERED}
      />
    );

    const section = screen.getByTestId('runtime-section-claude-code');
    expect(within(section).getByText('Ready')).toBeInTheDocument();
    expect(
      within(section).queryByRole('button', { name: /connect|install/i })
    ).not.toBeInTheDocument();
  });

  it('shows exactly one Connect CTA carrying the server label for a state:connect runtime', () => {
    // Purpose: a not-ready runtime offers ONE action with the server's honest
    // label — never a raw dependency error, never two competing CTAs.
    renderPanel(
      <RuntimeSetupPanel
        runtime="codex"
        requirements={THREE_SIBLINGS}
        registeredTypes={REGISTERED}
      />
    );

    const section = screen.getByTestId('runtime-section-codex');
    const connects = within(section).getAllByRole('button', { name: 'Connect Codex' });
    expect(connects).toHaveLength(1);
    expect(within(section).queryByText('Ready')).not.toBeInTheDocument();
  });

  it('hides binary/CLI vocabulary on the default path, revealing it only under Advanced', async () => {
    // Purpose: the Apple Test — the default surface describes what happens for
    // the user; CLI/binary detail is Priya's, gated behind Advanced. Fails if
    // "Codex CLI" or the install command is present before expanding.
    const user = userEvent.setup();
    renderPanel(
      <RuntimeSetupPanel
        runtime="codex"
        requirements={THREE_SIBLINGS}
        registeredTypes={REGISTERED}
      />
    );

    // Exact string match targets the dependency NAME, not the description
    // ("The Codex CLI binary.") which also contains the substring.
    expect(screen.queryByText('Codex CLI')).not.toBeInTheDocument();
    expect(screen.queryByText('codex login')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /setup details/i }));

    expect(await screen.findByText('Codex CLI')).toBeInTheDocument();
    expect(screen.getByText('codex login')).toBeInTheDocument();
  });

  it('renders all three runtimes with the same component shape (siblings)', () => {
    // Purpose: the three-siblings guarantee — Claude, Codex, and OpenCode each
    // render via one shared section as Ready-or-one-Connect. Fails if any
    // runtime shows a structurally different surface.
    renderPanel(<RuntimeSetupPanel requirements={THREE_SIBLINGS} registeredTypes={REGISTERED} />);

    const sections = screen.getAllByTestId(/^runtime-section-/);
    expect(sections.map((s) => s.getAttribute('data-testid'))).toEqual([
      'runtime-section-claude-code',
      'runtime-section-codex',
      'runtime-section-opencode',
    ]);

    // Each section: exactly one of {Ready badge, single Connect CTA} + one
    // Advanced disclosure trigger — identical structure across all three.
    for (const [type, connectLabel] of [
      ['claude-code', null],
      ['codex', 'Connect Codex'],
      ['opencode', 'Install OpenCode'],
    ] as const) {
      const section = screen.getByTestId(`runtime-section-${type}`);
      expect(within(section).getByRole('button', { name: /setup details/i })).toBeInTheDocument();
      if (connectLabel === null) {
        expect(within(section).getByText('Ready')).toBeInTheDocument();
      } else {
        expect(within(section).getByRole('button', { name: connectLabel })).toBeInTheDocument();
        expect(within(section).queryByText('Ready')).not.toBeInTheDocument();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// OpenCode one-click provisioning (task 1.6) — through the live dialog so the
// requirements query genuinely refetches after invalidation.
// ---------------------------------------------------------------------------

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const OPENCODE_CONNECT: SystemRequirements = {
  runtimes: {
    opencode: {
      state: 'connect',
      connect: { kind: 'install', label: 'Install OpenCode' },
      dependencies: [
        { name: 'OpenCode CLI', description: 'The OpenCode binary.', status: 'missing' },
      ],
    },
  },
  allSatisfied: false,
};

const OPENCODE_READY: SystemRequirements = {
  runtimes: {
    opencode: {
      state: 'ready',
      dependencies: [
        {
          name: 'OpenCode CLI',
          description: 'The OpenCode binary.',
          status: 'satisfied',
          version: '1.17.13',
        },
      ],
    },
  },
  allSatisfied: true,
};

function renderDialog(overrides: Partial<Parameters<typeof createMockTransport>[0]> = {}) {
  const transport = createMockTransport({
    getCapabilities: vi.fn().mockResolvedValue({
      capabilities: { opencode: { type: 'opencode' } },
      defaultRuntime: 'opencode',
    }),
    ...overrides,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(<RuntimeSetupDialog runtime="opencode" open onOpenChange={vi.fn()} />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    ),
  });
  return transport;
}

describe('RuntimeSetupDialog — OpenCode provisioning', () => {
  it('provisions on Connect, renders progress, and flips to Ready on success', async () => {
    // Purpose: the one-click install — clicking Connect runs the provision
    // mutation, streams inline progress, and (via ['requirements'] invalidation)
    // refetches to Ready with no manual "Check again". Fails if the progress
    // never renders or OpenCode does not flip to Ready after the install.
    const user = userEvent.setup();
    const install = deferred<RuntimeProvisionResult>();
    let call = 0;
    const transport = renderDialog({
      checkRequirements: vi.fn(() => {
        call += 1;
        return Promise.resolve(call === 1 ? OPENCODE_CONNECT : OPENCODE_READY);
      }),
      provisionOpenCode: vi.fn((onProgress?: (p: RuntimeProvisionProgress) => void) => {
        onProgress?.({ stage: 'installing', message: 'Downloading OpenCode…' });
        return install.promise;
      }),
    });

    const connectButton = await screen.findByRole('button', { name: 'Install OpenCode' });
    await user.click(connectButton);

    // Progress row appears while the install is in flight.
    expect(transport.provisionOpenCode).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('provision-progress')).toHaveTextContent(
      'Downloading OpenCode…'
    );

    // Complete the install → invalidation → refetch → Ready, no manual refresh.
    await act(async () => {
      install.resolve({ ok: true, binaryPath: '/dork/runtimes/opencode/bin/opencode' });
    });

    await waitFor(() => {
      expect(screen.getByTestId('runtime-ready-opencode')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Install OpenCode' })).not.toBeInTheDocument();
  });

  it('shows an honest, retryable error when provisioning rejects', async () => {
    // Purpose: a failed install must not fake success — it surfaces the honest
    // message and a retryable Connect, and never flips to Ready. Fails if the
    // error is swallowed or OpenCode reads as Ready after a rejection.
    const user = userEvent.setup();
    const transport = renderDialog({
      checkRequirements: vi.fn().mockResolvedValue(OPENCODE_CONNECT),
      provisionOpenCode: vi
        .fn()
        .mockRejectedValue(new Error('Install failed: network unreachable')),
    });

    const connectButton = await screen.findByRole('button', { name: 'Install OpenCode' });
    await user.click(connectButton);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Install failed: network unreachable'
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByTestId('runtime-ready-opencode')).not.toBeInTheDocument();
    // Requirements were never invalidated by a failed install.
    expect(transport.checkRequirements).toHaveBeenCalledTimes(1);
  });
});

describe('RuntimeSetupDialog — shell', () => {
  it('titles the scoped dialog with the runtime label and no terminal-steps copy', async () => {
    // Purpose: the default surface never tells a connectable runtime to "run
    // these steps in your terminal". Fails if the legacy terminal copy returns.
    renderDialog({ checkRequirements: vi.fn().mockResolvedValue(OPENCODE_CONNECT) });

    expect(screen.getByRole('heading', { name: 'OpenCode' })).toBeInTheDocument();
    expect(screen.getByText('Connect it to start a session.')).toBeInTheDocument();
    expect(screen.queryByText(/run these steps in your terminal/i)).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Install OpenCode' })).toBeInTheDocument();
    });
  });

  it('titles the unscoped dialog "Your runtimes"', () => {
    const transport = createMockTransport({
      getCapabilities: vi.fn().mockResolvedValue({
        capabilities: { 'claude-code': { type: 'claude-code' } },
        defaultRuntime: 'claude-code',
      }),
      checkRequirements: vi.fn().mockResolvedValue(THREE_SIBLINGS),
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(<RuntimeSetupDialog open onOpenChange={vi.fn()} />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>{children}</TransportProvider>
        </QueryClientProvider>
      ),
    });
    expect(screen.getByRole('heading', { name: 'Your runtimes' })).toBeInTheDocument();
  });
});
