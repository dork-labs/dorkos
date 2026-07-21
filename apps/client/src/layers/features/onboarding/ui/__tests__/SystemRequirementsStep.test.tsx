// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
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
  motion: new Proxy({}, { get: (_t, prop) => (typeof prop === 'string' ? prop : undefined) }),
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

function renderStep(options: {
  requirements: SystemRequirements;
  capabilities?: Record<string, { type: string }>;
  onContinue?: () => void;
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
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const onContinue = options.onContinue ?? vi.fn();
  render(<SystemRequirementsStep onContinue={onContinue} renderConnect={stubConnect} />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    ),
  });
  return { transport, onContinue };
}

describe('SystemRequirementsStep', () => {
  it('one runtime ready: shows Get started and fires onContinue', async () => {
    const onContinue = vi.fn();
    renderStep({
      requirements: { runtimes: { 'claude-code': CLAUDE_READY, codex: CODEX_LOGIN } },
      onContinue,
    });

    const cta = await screen.findByTestId('onboarding-get-started');
    expect(cta).toHaveTextContent('Get started');
    expect(screen.getByRole('heading')).toHaveTextContent("You're ready");
    expect(screen.getByText('Claude Code is connected.')).toBeInTheDocument();

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
    expect(screen.getByRole('heading')).toHaveTextContent('Connect your first agent');
    // The one-click install card is present; the login card renders the injected flow.
    expect(screen.getByRole('button', { name: 'Install OpenCode' })).toBeInTheDocument();
    expect(screen.getByTestId('connect-codex')).toBeInTheDocument();
    // No "Get started" — nothing is ready yet.
    expect(screen.queryByTestId('onboarding-get-started')).not.toBeInTheDocument();
  });

  it('all runtimes ready: success state without a "more agents" disclosure', async () => {
    renderStep({
      requirements: {
        runtimes: { 'claude-code': CLAUDE_READY, codex: { ...CODEX_LOGIN, state: 'ready' } },
      },
    });

    await screen.findByTestId('onboarding-get-started');
    expect(screen.queryByText(/more agent/)).not.toBeInTheDocument();
  });

  it('ready with others available: reveals the count and setup cards on expand', async () => {
    renderStep({
      requirements: { runtimes: { 'claude-code': CLAUDE_READY, codex: CODEX_LOGIN } },
    });

    await screen.findByTestId('onboarding-get-started');
    const disclosure = screen.getByText('1 more agent available');
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
    await userEvent.click(screen.getByText('1 more agent available'));

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

  it('install card shows transparency fine print naming the exact command', async () => {
    renderStep({
      requirements: { runtimes: { opencode: OPENCODE_INSTALL } },
    });

    await screen.findByRole('button', { name: 'Install OpenCode' });
    expect(screen.getByText('npm i -g opencode-ai')).toBeInTheDocument();
    expect(screen.getAllByText(/on this machine/).length).toBeGreaterThanOrEqual(1);
  });
});
