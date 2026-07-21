// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SystemRequirements } from '@dorkos/shared/agent-runtime';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { RuntimesTab } from '../ui/tabs/RuntimesTab';

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

// Claude Ready, Codex needs login, OpenCode needs the provider picker — one of
// each Ready/Connect state so the tab's sibling projection is exercised end to
// end (state derives from the server's requirements projection).
const MIXED_REQUIREMENTS: SystemRequirements = {
  runtimes: {
    'claude-code': {
      state: 'ready',
      dependencies: [{ name: 'Claude CLI', description: 'binary', status: 'satisfied' }],
    },
    codex: {
      state: 'connect',
      connect: { kind: 'login', label: 'Connect Codex' },
      dependencies: [{ name: 'Codex CLI', description: 'binary', status: 'satisfied' }],
    },
    opencode: {
      state: 'connect',
      connect: { kind: 'provider-picker', label: 'Connect OpenCode' },
      dependencies: [{ name: 'OpenCode CLI', description: 'binary', status: 'satisfied' }],
    },
  },
};

function renderTab(overrides: Partial<Parameters<typeof createMockTransport>[0]> = {}) {
  const transport = createMockTransport({
    getCapabilities: vi.fn().mockResolvedValue({
      capabilities: {
        'claude-code': { type: 'claude-code' },
        codex: { type: 'codex' },
        opencode: { type: 'opencode' },
      },
      defaultRuntime: 'claude-code',
    }),
    checkRequirements: vi.fn().mockResolvedValue(MIXED_REQUIREMENTS),
    detectOllama: vi.fn().mockResolvedValue({ running: false, models: [] }),
    ...overrides,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <RuntimesTab />
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

describe('RuntimesTab', () => {
  it('renders the runtime setup panel', async () => {
    renderTab();
    expect(await screen.findByTestId('runtime-setup-panel')).toBeInTheDocument();
  });

  it('lists all three runtimes as siblings with their correct Ready/Connect state', async () => {
    renderTab();

    // All three primary runtimes render as siblings.
    expect(await screen.findByTestId('runtime-section-claude-code')).toBeInTheDocument();
    expect(screen.getByTestId('runtime-section-codex')).toBeInTheDocument();
    expect(screen.getByTestId('runtime-section-opencode')).toBeInTheDocument();

    // Claude is Ready; the other two are not (they show Connect flows instead).
    expect(await screen.findByTestId('runtime-ready-claude-code')).toBeInTheDocument();
    expect(screen.queryByTestId('runtime-ready-codex')).not.toBeInTheDocument();
    expect(screen.queryByTestId('runtime-ready-opencode')).not.toBeInTheDocument();
  });

  it('opens each not-ready runtime’s REAL T1 connect flow (composed, not a stub)', async () => {
    renderTab();

    // Codex → the real LoginConnect flow (delegated sign-in + paste-key).
    expect(await screen.findByTestId('login-connect-codex')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in with ChatGPT' })).toBeInTheDocument();

    // OpenCode → the real provider picker (Local / Gateway / Direct).
    expect(screen.getByTestId('opencode-provider-picker')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Local' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Gateway' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Direct' })).toBeInTheDocument();
  });

  it('offers a recheck after connecting', async () => {
    renderTab();
    expect(await screen.findByRole('button', { name: /check again/i })).toBeInTheDocument();
  });
});
