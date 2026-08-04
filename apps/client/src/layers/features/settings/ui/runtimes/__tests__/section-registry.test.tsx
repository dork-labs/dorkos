/**
 * @vitest-environment jsdom
 *
 * The kind-keyed registry that turns a runtime's DECLARED settings sections into
 * rendered panels.
 *
 * The forward-compatibility rule is the load-bearing case: an older cockpit
 * talking to a newer server will be handed section kinds it has never heard of,
 * and it must degrade to a card without that panel rather than crash. So the
 * unknown-kind test asserts an empty container AND a silent console.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { SystemRequirements } from '@dorkos/shared/agent-runtime';
import type { ServerConfig } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { renderRuntimeSettingsSection } from '../section-registry';

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

const READY_OPENCODE = {
  runtimes: {
    opencode: {
      state: 'ready',
      dependencies: [{ name: 'OpenCode CLI', description: 'binary', status: 'satisfied' }],
      provider: 'openrouter',
    },
  },
} as SystemRequirements;

/**
 * Render whatever the registry resolves for a kind, with both data sources the
 * known renderers read wired up.
 */
function renderKind(
  kind: string,
  type: string,
  overrides: Partial<Parameters<typeof createMockTransport>[0]> = {}
) {
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue({
      claudeCode: { resolvedAccount: '/Users/dev/.claude', inherited: true, accounts: [] },
    } as Partial<ServerConfig>),
    checkRequirements: vi.fn().mockResolvedValue(READY_OPENCODE),
    detectOllama: vi.fn().mockResolvedValue({ running: false, models: [] }),
    ...overrides,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return render(<>{renderRuntimeSettingsSection(kind, { type })}</>, { wrapper });
}

describe('renderRuntimeSettingsSection', () => {
  it('resolves claude-accounts to the billing-account section', async () => {
    renderKind('claude-accounts', 'claude-code');
    await waitFor(() => expect(screen.getByTestId('claude-account-select')).toBeInTheDocument());
  });

  it('resolves opencode-power-source to the power-source section, naming the provider', async () => {
    renderKind('opencode-power-source', 'opencode');
    expect(await screen.findByTestId('power-source-current')).toHaveTextContent(
      'Cloud via OpenRouter'
    );
  });

  it('renders NOTHING for a kind it has never heard of, quietly', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { container } = renderKind('not-a-real-kind', 'opencode');

    expect(container).toBeEmptyDOMElement();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('still renders a known kind when its data has not arrived', async () => {
    // Both surfaces answer with nothing at all — the half-loaded cockpit.
    renderKind('opencode-power-source', 'opencode', {
      checkRequirements: vi.fn().mockResolvedValue({ runtimes: {} } as SystemRequirements),
    });
    expect(await screen.findByTestId('power-source-empty')).toBeInTheDocument();
  });
});
