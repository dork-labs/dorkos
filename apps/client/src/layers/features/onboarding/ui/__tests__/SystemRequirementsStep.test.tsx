// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import type { ElementType, ReactNode } from 'react';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SystemRequirements, RuntimeRequirements } from '@dorkos/shared/agent-runtime';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { SystemRequirementsStep } from '../SystemRequirementsStep';

// Mock motion so animations resolve instantly and headings render as plain text.
// `useReducedMotion → true` also collapses the min-scan timer to 0ms.
vi.mock('motion/react', () => ({
  motion: new Proxy(
    {},
    {
      get: (_t, prop) =>
        // `motion.create(Component)` wraps a component, unlike every other
        // property here which is a plain HTML tag name string — a shadow that
        // did not special-case this would hand back the string "create" and
        // crash the moment anything called it as a function (DOR-1416).
        prop === 'create'
          ? (Component: ElementType) => Component
          : typeof prop === 'string'
            ? prop
            : undefined,
    }
  ),
  AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
  useReducedMotion: () => true,
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
  vi.clearAllMocks();
});

const CLAUDE_READY: RuntimeRequirements = {
  state: 'ready',
  dependencies: [
    { name: 'Claude Code CLI', description: 'Powers agent sessions.', status: 'satisfied' },
  ],
};

const CODEX_LOGIN: RuntimeRequirements = {
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
};

const CODEX_READY: RuntimeRequirements = {
  state: 'ready',
  dependencies: [{ name: 'Codex CLI', description: 'The Codex CLI binary.', status: 'satisfied' }],
};

const OPENCODE_INSTALL: RuntimeRequirements = {
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
};

/** A stand-in for the injected feature connect flow (Codex/Claude login). */
const stubConnect = ({ type }: { type: string }) => (
  <div data-testid={`connect-${type}`}>
    connect
    <input aria-label={`stub-key-${type}`} />
  </div>
);

/**
 * A `GET /api/config` answer shaped like the two things this step reads: which
 * runtime new chats start on, and whether that was ever decided.
 */
function configWith(options: { runtime?: string; runtimeDefaultSetAt?: string | null } = {}) {
  return {
    version: '1.0.0',
    port: 4242,
    executionDefaults: {
      runtime: options.runtime ?? 'claude-code',
      perRuntime: [],
    },
    onboarding: {
      completedSteps: [],
      skippedSteps: [],
      startedAt: null,
      dismissedAt: null,
      completedAt: null,
      runtimeDefaultSetAt: options.runtimeDefaultSetAt ?? null,
    },
  };
}

function renderStep(options: {
  requirements: SystemRequirements;
  capabilities?: Record<string, { type: string }>;
  onContinue?: () => void;
  config?: ReturnType<typeof configWith>;
  /** Render the way the dev playground does: pre-baked scan AND pre-baked pick. */
  simulated?: boolean;
}) {
  const capabilities =
    options.capabilities ??
    Object.fromEntries(Object.keys(options.requirements.runtimes).map((t) => [t, { type: t }]));
  const transport = createMockTransport({
    checkRequirements: vi.fn().mockResolvedValue(options.requirements),
    getCapabilities: vi.fn().mockResolvedValue({
      capabilities,
      defaultRuntime: Object.keys(capabilities)[0] ?? 'claude-code',
    }),
    getConfig: vi.fn().mockResolvedValue(options.config ?? configWith()),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const onContinue = options.onContinue ?? vi.fn();
  render(
    <SystemRequirementsStep
      onContinue={onContinue}
      renderConnect={stubConnect}
      {...(options.simulated
        ? { simulatedResult: options.requirements, simulatedDefaultRuntime: 'claude-code' }
        : {})}
    />,
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>{children}</TransportProvider>
        </QueryClientProvider>
      ),
    }
  );
  return { transport, onContinue };
}

describe('SystemRequirementsStep', () => {
  it('one runtime ready: shows Meet DorkBot and fires onContinue', async () => {
    const onContinue = vi.fn();
    renderStep({
      requirements: { runtimes: { 'claude-code': CLAUDE_READY, codex: CODEX_LOGIN } },
      onContinue,
    });

    const cta = await screen.findByTestId('onboarding-get-started');
    expect(cta).toHaveTextContent('Meet DorkBot');
    expect(screen.getByRole('heading')).toHaveTextContent("You're ready");
    expect(
      screen.getByText('Claude Code is connected. New chats will start with it.')
    ).toBeInTheDocument();

    await userEvent.click(cta);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('one runtime ready: Enter proceeds', async () => {
    const onContinue = vi.fn();
    renderStep({
      requirements: { runtimes: { 'claude-code': CLAUDE_READY, codex: CODEX_LOGIN } },
      onContinue,
    });

    await screen.findByTestId('onboarding-get-started');
    await userEvent.keyboard('{Enter}');
    expect(onContinue).toHaveBeenCalled();
  });

  it('zero runtimes ready: gate closed, connect cards shown', async () => {
    renderStep({
      requirements: { runtimes: { codex: CODEX_LOGIN, opencode: OPENCODE_INSTALL } },
    });

    // Connect-first heading and the setup panel with per-runtime cards.
    expect(await screen.findByTestId('runtime-setup-panel')).toBeInTheDocument();
    expect(screen.getByRole('heading')).toHaveTextContent('Connect your first runtime');
    // The one-click install card is present; the login card renders the injected flow.
    expect(screen.getByRole('button', { name: 'Install OpenCode' })).toBeInTheDocument();
    expect(screen.getByTestId('connect-codex')).toBeInTheDocument();
    // No "Get started" — nothing is ready yet.
    expect(screen.queryByTestId('onboarding-get-started')).not.toBeInTheDocument();
  });

  it('all runtimes ready: success state without a "more runtimes" disclosure', async () => {
    renderStep({
      requirements: {
        runtimes: { 'claude-code': CLAUDE_READY, codex: { ...CODEX_LOGIN, state: 'ready' } },
      },
    });

    await screen.findByTestId('onboarding-get-started');
    expect(screen.queryByText(/more runtime/)).not.toBeInTheDocument();
  });

  it('ready with others available: reveals the count and setup cards on expand', async () => {
    renderStep({
      requirements: { runtimes: { 'claude-code': CLAUDE_READY, codex: CODEX_LOGIN } },
    });

    await screen.findByTestId('onboarding-get-started');
    const disclosure = screen.getByText('1 more runtime available');
    expect(disclosure).toBeInTheDocument();

    await userEvent.click(disclosure);
    expect(await screen.findByTestId('runtime-setup-panel')).toBeInTheDocument();
    expect(screen.getByText('You can add these anytime from the status bar.')).toBeInTheDocument();
  });

  it('Enter inside a connect form field does not eject the user out of the step', async () => {
    const onContinue = vi.fn();
    renderStep({
      requirements: { runtimes: { 'claude-code': CLAUDE_READY, codex: CODEX_LOGIN } },
      onContinue,
    });

    await screen.findByTestId('onboarding-get-started');
    await userEvent.click(screen.getByText('1 more runtime available'));

    const keyField = await screen.findByLabelText('stub-key-codex');
    await userEvent.click(keyField);
    await userEvent.keyboard('{Enter}');
    expect(onContinue).not.toHaveBeenCalled();
  });

  it('recheck uses the shared requirements query', async () => {
    const { transport } = renderStep({
      requirements: { runtimes: { codex: CODEX_LOGIN, opencode: OPENCODE_INSTALL } },
    });

    await screen.findByTestId('runtime-setup-panel');
    expect(transport.checkRequirements).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: /Check again/ }));
    await waitFor(() => expect(transport.checkRequirements).toHaveBeenCalledTimes(2));
  });

  it('install card leads with reassurance and reveals the exact command on tap', async () => {
    renderStep({
      requirements: { runtimes: { opencode: OPENCODE_INSTALL } },
    });

    await screen.findByRole('button', { name: 'Install OpenCode' });
    const section = within(screen.getByTestId('runtime-section-opencode'));
    // The friendly line is always visible; the raw command is not shown yet.
    expect(section.getByText(/We'll install OpenCode for you\./)).toBeInTheDocument();
    expect(section.queryByText('npm i -g opencode-ai')).not.toBeInTheDocument();

    // Transparency is one tap away — reveal the exact command.
    await userEvent.click(section.getByRole('button', { name: 'What runs?' }));
    expect(await section.findByText('npm i -g opencode-ai')).toBeInTheDocument();
  });
});

describe('SystemRequirementsStep — the default runtime (spec execution-defaults §7)', () => {
  it('only Codex authenticated: the default becomes codex, and the sentence says so', async () => {
    const { transport } = renderStep({
      requirements: {
        runtimes: { 'claude-code': { ...CLAUDE_READY, state: 'connect' }, codex: CODEX_READY },
      },
    });

    expect(
      await screen.findByText('Codex is connected. New chats will start with it.')
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimes: { default: 'codex' },
          onboarding: { runtimeDefaultSetAt: expect.any(String) },
        })
      )
    );
  });

  it('Claude ready: the setting is left alone, and the decision is still recorded', async () => {
    const { transport } = renderStep({
      requirements: { runtimes: { 'claude-code': CLAUDE_READY, codex: CODEX_LOGIN } },
    });

    await screen.findByTestId('onboarding-get-started');
    // Nothing changed, so nothing pretends it did — but the question is closed.
    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith({
        onboarding: { runtimeDefaultSetAt: expect.any(String) },
      })
    );
  });

  it('a ready runtime that is already the default is never traded for another', async () => {
    const { transport } = renderStep({
      requirements: {
        runtimes: { 'claude-code': CLAUDE_READY, codex: CODEX_READY },
      },
      config: configWith({ runtime: 'claude-code' }),
    });

    await screen.findByTestId('onboarding-get-started');
    await waitFor(() => expect(transport.updateConfig).toHaveBeenCalled());
    expect(transport.updateConfig).not.toHaveBeenCalledWith(
      expect.objectContaining({ runtimes: expect.anything() })
    );
  });

  it('second visit: the decision is never re-made', async () => {
    const { transport } = renderStep({
      // Codex is the only thing ready, which on a FIRST run would move the
      // default. It must not move here.
      requirements: {
        runtimes: { 'claude-code': { ...CLAUDE_READY, state: 'connect' }, codex: CODEX_READY },
      },
      config: configWith({
        runtime: 'claude-code',
        runtimeDefaultSetAt: '2026-07-30T12:00:00.000Z',
      }),
    });

    expect(
      await screen.findByText(
        "Codex is connected. New chats will start with Claude Code once it's connected. " +
          "Until then they'll use Codex."
      )
    ).toBeInTheDocument();
    // Give the effect every chance to misfire before asserting it did not.
    await waitFor(() => expect(screen.getByTestId('default-runtime-change')).toBeInTheDocument());
    expect(transport.updateConfig).not.toHaveBeenCalled();
  });

  it('nothing ready: no default is chosen for anybody', async () => {
    const { transport } = renderStep({
      requirements: { runtimes: { codex: CODEX_LOGIN, opencode: OPENCODE_INSTALL } },
    });

    await screen.findByTestId('runtime-setup-panel');
    expect(transport.updateConfig).not.toHaveBeenCalled();
    expect(screen.queryByTestId('default-runtime-change')).not.toBeInTheDocument();
  });

  it('one tap changes it', async () => {
    const { transport } = renderStep({
      requirements: { runtimes: { 'claude-code': CLAUDE_READY, codex: CODEX_READY } },
    });

    await userEvent.click(await screen.findByTestId('default-runtime-change'));
    await userEvent.click(await screen.findByTestId('default-runtime-option-codex'));

    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({ runtimes: { default: 'codex' } })
      )
    );
    // The sentence moves with the tap, without waiting for a refetch.
    expect(
      await screen.findByText(
        'Claude Code and Codex are connected. New chats will start with Codex.'
      )
    ).toBeInTheDocument();
  });

  it('a failed write is not a dead end: the picker stays, and the next settle retries', async () => {
    const { transport } = renderStep({
      requirements: {
        runtimes: { 'claude-code': { ...CLAUDE_READY, state: 'connect' }, codex: CODEX_READY },
      },
    });
    vi.mocked(transport.updateConfig).mockRejectedValue(new Error('disk is full'));

    // The failure is said out loud…
    expect(await screen.findByTestId('default-runtime-error')).toHaveTextContent('disk is full');
    // …and the only route to this setting inside onboarding is still on screen.
    expect(screen.getByTestId('default-runtime-change')).toBeInTheDocument();
    // Nothing was decided, so the sentence claims no default.
    expect(screen.getByText('Codex is connected.')).toBeInTheDocument();
    // ONE attempt, and it stays one. A latch released on failure re-fires on the
    // next render instead of the next settle, which against a failing server is
    // a hot loop — measured at 134 writes in six seconds before this was keyed
    // to the settle rather than to a boolean.
    const failedCalls = vi.mocked(transport.updateConfig).mock.calls.length;
    expect(failedCalls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(vi.mocked(transport.updateConfig).mock.calls.length).toBe(1);

    // The next settle tries again on its own — this is the ref release, not the
    // picker: a recheck re-answers readiness and the decision gets another go.
    vi.mocked(transport.updateConfig).mockResolvedValue(undefined);
    await userEvent.click(screen.getByText('1 more runtime available'));
    await userEvent.click(await screen.findByRole('button', { name: /Check again/ }));

    await waitFor(() =>
      expect(vi.mocked(transport.updateConfig).mock.calls.length).toBeGreaterThan(failedCalls)
    );
    expect(vi.mocked(transport.updateConfig)).toHaveBeenLastCalledWith(
      expect.objectContaining({ runtimes: { default: 'codex' } })
    );
  });

  it('the dev playground never writes anybody real default', async () => {
    const { transport } = renderStep({
      requirements: { runtimes: { 'claude-code': CLAUDE_READY, codex: CODEX_READY } },
      simulated: true,
    });

    await screen.findByTestId('onboarding-get-started');
    await waitFor(() => expect(screen.getByTestId('default-runtime-change')).toBeInTheDocument());
    expect(transport.updateConfig).not.toHaveBeenCalled();
    // The tap is local: it moves the sentence and still writes nothing.
    await userEvent.click(screen.getByTestId('default-runtime-change'));
    await userEvent.click(await screen.findByTestId('default-runtime-option-codex'));
    expect(
      await screen.findByText(
        'Claude Code and Codex are connected. New chats will start with Codex.'
      )
    ).toBeInTheDocument();
    expect(transport.updateConfig).not.toHaveBeenCalled();
  });

  it('a failed scan decides nothing — there is no readiness to decide from', async () => {
    const transport = createMockTransport({
      checkRequirements: vi.fn().mockRejectedValue(new Error('server is down')),
      getCapabilities: vi.fn().mockResolvedValue({
        capabilities: { 'claude-code': { type: 'claude-code' } },
        defaultRuntime: 'claude-code',
      }),
      getConfig: vi.fn().mockResolvedValue(configWith()),
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    render(<SystemRequirementsStep onContinue={vi.fn()} />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>{children}</TransportProvider>
        </QueryClientProvider>
      ),
    });

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(transport.updateConfig).not.toHaveBeenCalled();
    expect(screen.queryByTestId('default-runtime-change')).not.toBeInTheDocument();
  });

  it('a runtime that is not connected can still be chosen, and says so both ways', async () => {
    renderStep({
      requirements: { runtimes: { 'claude-code': CLAUDE_READY, opencode: OPENCODE_INSTALL } },
    });

    await userEvent.click(await screen.findByTestId('default-runtime-change'));
    const option = await screen.findByTestId('default-runtime-option-opencode');
    expect(within(option).getByText('Not connected yet')).toBeInTheDocument();

    await userEvent.click(option);
    expect(
      await screen.findByText(
        "Claude Code is connected. New chats will start with OpenCode once it's connected. " +
          "Until then they'll use Claude Code."
      )
    ).toBeInTheDocument();
  });
});
