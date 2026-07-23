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
import {
  RuntimeSetupPanel,
  RuntimeSetupDialog,
  type RuntimeConnectSlotProps,
} from '../ui/RuntimeSetupDialog';

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
// Ready-state reconnect (DOR-438) — a ready login runtime keeps a quiet way to
// fix its sign-in, because "Ready" only fingerprints the credential and cannot
// see a stale or invalid one. Uses a recording stub for the injected connect
// slot so the entity's affordance is tested without a feature dependency.
// ---------------------------------------------------------------------------

const CLAUDE_READY: SystemRequirements = {
  runtimes: {
    'claude-code': {
      state: 'ready',
      dependencies: [
        { name: 'Claude Code CLI', description: 'binary', status: 'satisfied', version: '2.1.0' },
      ],
    },
  },
};

/** A connect-slot stub that records the connect descriptor it was handed. */
function reconnectSlotStub({ type, connect, onConnected }: RuntimeConnectSlotProps) {
  return (
    <div data-testid={`reconnect-slot-${type}`}>
      <span data-testid={`reconnect-slot-kind-${type}`}>{connect.kind}</span>
      <span>{connect.label}</span>
      <button
        data-testid={`reconnect-slot-fire-${type}`}
        onClick={() => onConnected?.({ title: 't', body: 'b' })}
      >
        landed
      </button>
    </div>
  );
}

describe('RuntimeSetupPanel — ready-state reconnect (DOR-438)', () => {
  it('offers a quiet Fix sign-in on a ready login runtime and reveals the login flow', async () => {
    // Purpose: a ready credential can still be stale, so a ready login runtime
    // keeps a calm reconnect path — the Ready badge stays, a small Fix sign-in
    // link expands the SAME login connect flow, and Cancel restores the calm.
    const user = userEvent.setup();
    renderPanel(
      <RuntimeSetupPanel
        runtime="claude-code"
        requirements={CLAUDE_READY}
        registeredTypes={['claude-code']}
        renderConnect={reconnectSlotStub}
      />
    );

    const section = screen.getByTestId('runtime-section-claude-code');
    // Ready stays primary; no loud Connect CTA.
    expect(within(section).getByText('Ready')).toBeInTheDocument();
    expect(within(section).queryByTestId('reconnect-slot-claude-code')).not.toBeInTheDocument();

    // The quiet affordance expands the injected login flow.
    await user.click(within(section).getByTestId('runtime-reconnect-claude-code'));
    expect(within(section).getByTestId('reconnect-slot-claude-code')).toBeInTheDocument();
    expect(within(section).getByTestId('reconnect-slot-kind-claude-code')).toHaveTextContent(
      'login'
    );
    expect(within(section).getByText('Reconnect Claude')).toBeInTheDocument();

    // Cancel restores the calm ready state.
    await user.click(within(section).getByTestId('runtime-reconnect-cancel-claude-code'));
    expect(within(section).queryByTestId('reconnect-slot-claude-code')).not.toBeInTheDocument();
  });

  it('collapses the reconnect flow the instant the connect lands', async () => {
    // Purpose: a successful reconnect ends the inline flow — onConnected closes
    // it, exactly like the OpenCode change path, so it is never a dead end.
    const user = userEvent.setup();
    renderPanel(
      <RuntimeSetupPanel
        runtime="claude-code"
        requirements={CLAUDE_READY}
        registeredTypes={['claude-code']}
        renderConnect={reconnectSlotStub}
      />
    );

    const section = screen.getByTestId('runtime-section-claude-code');
    await user.click(within(section).getByTestId('runtime-reconnect-claude-code'));
    await user.click(within(section).getByTestId('reconnect-slot-fire-claude-code'));
    expect(within(section).queryByTestId('reconnect-slot-claude-code')).not.toBeInTheDocument();
    expect(within(section).getByTestId('runtime-reconnect-claude-code')).toBeInTheDocument();
  });

  it('keeps the ready runtime calm when no connect flow is wired', () => {
    // Purpose: the install-only surface (no injected renderConnect) has no flow
    // to reopen, so a ready runtime shows just the settled Ready badge.
    renderPanel(
      <RuntimeSetupPanel
        runtime="claude-code"
        requirements={CLAUDE_READY}
        registeredTypes={['claude-code']}
      />
    );

    const section = screen.getByTestId('runtime-section-claude-code');
    expect(within(section).getByText('Ready')).toBeInTheDocument();
    expect(within(section).queryByTestId('runtime-reconnect-claude-code')).not.toBeInTheDocument();
  });

  it('does not offer reconnect on a not-ready runtime (not-ready path unchanged)', () => {
    // Purpose: reconnect is a ready-state affordance only — a not-ready runtime
    // keeps its single Connect action, no Fix sign-in link.
    renderPanel(
      <RuntimeSetupPanel
        runtime="codex"
        requirements={THREE_SIBLINGS}
        registeredTypes={REGISTERED}
        renderConnect={reconnectSlotStub}
      />
    );

    const section = screen.getByTestId('runtime-section-codex');
    expect(within(section).queryByText('Ready')).not.toBeInTheDocument();
    expect(within(section).queryByTestId('runtime-reconnect-codex')).not.toBeInTheDocument();
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
};

// A login-kind connect (Codex/Claude), distinct from OpenCode's one-click
// install: the reported bug was connecting a not-yet-ready runtime of ANY kind
// and having it not get selected, so we exercise the login path too.
const CODEX_CONNECT: SystemRequirements = {
  runtimes: {
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
        },
      ],
    },
  },
};

const CODEX_READY: SystemRequirements = {
  runtimes: {
    codex: {
      state: 'ready',
      dependencies: [
        {
          name: 'Codex CLI',
          description: 'The Codex CLI binary.',
          status: 'satisfied',
          version: '1.0.0',
        },
        {
          name: 'Codex authentication',
          description: 'ChatGPT or API-key auth.',
          status: 'satisfied',
        },
      ],
    },
  },
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
      provisionRuntime: vi.fn(
        (_type: string, onProgress?: (p: RuntimeProvisionProgress) => void) => {
          onProgress?.({ stage: 'installing', message: 'Downloading OpenCode…' });
          return install.promise;
        }
      ),
    });

    const connectButton = await screen.findByRole('button', { name: 'Install OpenCode' });
    await user.click(connectButton);

    // Progress row appears while the install is in flight.
    expect(transport.provisionRuntime).toHaveBeenCalledTimes(1);
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
      provisionRuntime: vi.fn().mockRejectedValue(new Error('Install failed: network unreachable')),
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

// ---------------------------------------------------------------------------
// onRuntimeReady — the connect→continue signal. Drives readiness the same way
// the provisioning test does: checkRequirements returns Connect first, then a
// refetch flips it to Ready (the connect having "succeeded").
// ---------------------------------------------------------------------------

function renderReadinessDialog(props: {
  runtime?: string;
  onRuntimeReady: (type: string) => void;
  checkRequirements: () => Promise<SystemRequirements>;
  capabilities?: Record<string, { type: string }>;
  defaultRuntime?: string;
}) {
  const transport = createMockTransport({
    getCapabilities: vi.fn().mockResolvedValue({
      capabilities: props.capabilities ?? { opencode: { type: 'opencode' } },
      defaultRuntime: props.defaultRuntime ?? 'opencode',
    }),
    checkRequirements: vi.fn(props.checkRequirements),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <RuntimeSetupDialog
      runtime={props.runtime}
      open
      onOpenChange={vi.fn()}
      onRuntimeReady={props.onRuntimeReady}
    />,
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>{children}</TransportProvider>
        </QueryClientProvider>
      ),
    }
  );
  return { transport, queryClient };
}

describe('RuntimeSetupDialog — onRuntimeReady (connect success)', () => {
  it('fires once when the scoped runtime transitions not-ready → ready', async () => {
    // Purpose: the connect→continue wiring — when a scoped runtime flips Ready
    // while the dialog is open (connect succeeded), the opener is signalled
    // exactly once so it can continue the flow it was blocked on. Fails if the
    // signal never fires, or fires more than once.
    const onRuntimeReady = vi.fn();
    let call = 0;
    const { queryClient } = renderReadinessDialog({
      runtime: 'opencode',
      onRuntimeReady,
      checkRequirements: () => {
        call += 1;
        return Promise.resolve(call === 1 ? OPENCODE_CONNECT : OPENCODE_READY);
      },
    });

    // Baseline: opened on a not-ready runtime — no auto-fire.
    await screen.findByRole('button', { name: 'Install OpenCode' });
    expect(onRuntimeReady).not.toHaveBeenCalled();

    // Drive the connect success: a refetch flips requirements to Ready.
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['requirements'] });
    });

    await waitFor(() => expect(onRuntimeReady).toHaveBeenCalledWith('opencode'));
    expect(onRuntimeReady).toHaveBeenCalledTimes(1);
  });

  it('fires once for a login-kind runtime (the exact reported not-ready → ready case)', async () => {
    // Purpose: the fire is connect-kind-agnostic — a login runtime (Codex) that
    // transitions Ready after the user connects must signal the opener just like
    // OpenCode's install path. Guards the reported scenario across connect kinds.
    const onRuntimeReady = vi.fn();
    let call = 0;
    const { queryClient } = renderReadinessDialog({
      runtime: 'codex',
      capabilities: { codex: { type: 'codex' } },
      defaultRuntime: 'codex',
      onRuntimeReady,
      checkRequirements: () => {
        call += 1;
        return Promise.resolve(call === 1 ? CODEX_CONNECT : CODEX_READY);
      },
    });

    // Baseline: opened on a not-ready login runtime — no auto-fire.
    await screen.findByRole('button', { name: 'Connect Codex' });
    expect(onRuntimeReady).not.toHaveBeenCalled();

    // Drive the connect success: a refetch flips requirements to Ready.
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['requirements'] });
    });

    await waitFor(() => expect(onRuntimeReady).toHaveBeenCalledWith('codex'));
    expect(onRuntimeReady).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire when the dialog opens on an already-ready runtime', async () => {
    // Purpose: opening the setup surface on a Ready runtime is not a connect
    // transition — the loading→ready flash must not be mistaken for one. Fails
    // if the baseline is captured before readiness is actually known.
    const onRuntimeReady = vi.fn();
    renderReadinessDialog({
      runtime: 'opencode',
      onRuntimeReady,
      checkRequirements: () => Promise.resolve(OPENCODE_READY),
    });

    await waitFor(() => {
      expect(screen.getByTestId('runtime-ready-opencode')).toBeInTheDocument();
    });
    expect(onRuntimeReady).not.toHaveBeenCalled();
  });

  it('does NOT fire in the unscoped "Your runtimes" overview', async () => {
    // Purpose: the overview has no single runtime to select — a readiness
    // change there must never signal a selection.
    const onRuntimeReady = vi.fn();
    let call = 0;
    const { queryClient } = renderReadinessDialog({
      runtime: undefined,
      onRuntimeReady,
      checkRequirements: () => {
        call += 1;
        return Promise.resolve(call === 1 ? OPENCODE_CONNECT : OPENCODE_READY);
      },
    });

    await screen.findByRole('heading', { name: 'Your runtimes' });
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['requirements'] });
    });
    await waitFor(() => {
      expect(screen.getByTestId('runtime-ready-opencode')).toBeInTheDocument();
    });
    expect(onRuntimeReady).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// showConnectSuccess — the explicit success moment. A connect path reports its
// landing via onConnected; the dialog swaps in a success panel with a Done
// button (spec: opencode-connect-overhaul §6), instead of the path's own inline
// confirmation, and stays open until Done.
// ---------------------------------------------------------------------------

/** A connect-slot stub exposing a button that reports a landing via onConnected. */
function fireConnectedStub({ onConnected }: RuntimeConnectSlotProps) {
  return (
    <button
      data-testid="fire-connected"
      onClick={() => onConnected?.({ title: 'OpenCode is connected.', body: 'Frontier unlocked.' })}
    >
      connect
    </button>
  );
}

describe('RuntimeSetupDialog — showConnectSuccess (explicit success moment)', () => {
  function renderSuccessDialog(showConnectSuccess: boolean, onOpenChange = vi.fn()) {
    const transport = createMockTransport({
      getCapabilities: vi.fn().mockResolvedValue({
        capabilities: { codex: { type: 'codex' } },
        defaultRuntime: 'codex',
      }),
      checkRequirements: vi.fn().mockResolvedValue(CODEX_CONNECT),
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    render(
      <RuntimeSetupDialog
        runtime="codex"
        open
        onOpenChange={onOpenChange}
        renderConnect={fireConnectedStub}
        showConnectSuccess={showConnectSuccess}
      />,
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={queryClient}>
            <TransportProvider transport={transport}>{children}</TransportProvider>
          </QueryClientProvider>
        ),
      }
    );
    return onOpenChange;
  }

  it('swaps in the success panel on connect and closes on Done', async () => {
    const user = userEvent.setup();
    const onOpenChange = renderSuccessDialog(true);

    await user.click(await screen.findByTestId('fire-connected'));

    const panel = await screen.findByTestId('runtime-connected-panel');
    expect(panel).toHaveTextContent('OpenCode is connected.');
    expect(panel).toHaveTextContent('Frontier unlocked.');

    await user.click(screen.getByTestId('runtime-connected-done'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('does not inject onConnected when showConnectSuccess is off (no success panel)', async () => {
    const user = userEvent.setup();
    renderSuccessDialog(false);

    // The path renders, but onConnected is undefined, so firing it is a no-op and
    // the dialog keeps the setup panel — the path owns its inline confirmation.
    await user.click(await screen.findByTestId('fire-connected'));
    expect(screen.queryByTestId('runtime-connected-panel')).not.toBeInTheDocument();
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
