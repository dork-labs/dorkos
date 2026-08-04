/**
 * @vitest-environment jsdom
 *
 * OpenCode's declared `opencode-power-source` settings section: which power
 * source the runtime is on, and the quiet way to change it.
 *
 * Two things are worth pinning here. The Change affordance must reopen the ONE
 * existing provider picker (not a second one built for settings), so the tests
 * assert the real picker's own test ids and the exact connect descriptor handed
 * to the injected slot. And the no-provider case must stay honest: a runtime
 * signed in outside DorkOS has nothing DorkOS can change, so it gets a sentence
 * rather than a dead button.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SystemRequirements } from '@dorkos/shared/agent-runtime';
import type { RuntimeConnectSlot } from '@/layers/entities/runtime';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { PowerSourceSection, PowerSourceSectionView } from '../sections/PowerSourceSection';

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

/** OpenCode as `GET /api/system/requirements` reports it, with or without a provider. */
function requirements(provider?: string): SystemRequirements {
  return {
    runtimes: {
      opencode: {
        state: 'ready',
        dependencies: [{ name: 'OpenCode CLI', description: 'binary', status: 'satisfied' }],
        ...(provider ? { provider } : {}),
      },
    },
  };
}

function renderSection(provider?: string) {
  const transport = createMockTransport({
    checkRequirements: vi.fn().mockResolvedValue(requirements(provider)),
    detectOllama: vi.fn().mockResolvedValue({ running: false, models: [] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <PowerSourceSection type="opencode" />
      </TransportProvider>
    </QueryClientProvider>
  );
}

describe('PowerSourceSection', () => {
  it('names the current power source in plain language', async () => {
    renderSection('ollama');
    expect(await screen.findByTestId('power-source-current')).toHaveTextContent(
      'On your computer (Ollama)'
    );
  });

  it('offers Change, which reveals the existing provider picker with the current source labeled', async () => {
    const user = userEvent.setup();
    renderSection('openrouter');

    await user.click(await screen.findByTestId('power-source-change'));

    // The one real picker, not a settings-only copy of it.
    expect(await screen.findByTestId('opencode-power-sources')).toBeInTheDocument();
    expect(screen.getByTestId('opencode-current-source')).toHaveTextContent(
      'Currently: Cloud via OpenRouter'
    );
  });

  it('collapses back to the current source when the change is cancelled', async () => {
    const user = userEvent.setup();
    renderSection('openrouter');

    await user.click(await screen.findByTestId('power-source-change'));
    expect(await screen.findByTestId('opencode-power-sources')).toBeInTheDocument();

    await user.click(screen.getByTestId('power-source-cancel'));

    expect(screen.queryByTestId('opencode-power-sources')).not.toBeInTheDocument();
    expect(screen.getByTestId('power-source-current')).toHaveTextContent('Cloud via OpenRouter');
    expect(screen.getByTestId('power-source-change')).toBeInTheDocument();
  });

  it('says so honestly when no power source was set through DorkOS, with nothing to change', async () => {
    renderSection();

    expect(await screen.findByTestId('power-source-empty')).toHaveTextContent(/outside DorkOS/);
    expect(screen.queryByTestId('power-source-change')).not.toBeInTheDocument();
    expect(screen.queryByTestId('power-source-current')).not.toBeInTheDocument();
  });
});

describe('PowerSourceSectionView', () => {
  it('hands the injected slot the provider-picker descriptor and the current provider', async () => {
    const user = userEvent.setup();
    const renderConnect = vi.fn<RuntimeConnectSlot>(() => <div data-testid="stub-connect" />);

    render(
      <PowerSourceSectionView type="opencode" provider="ollama" renderConnect={renderConnect} />
    );
    await user.click(screen.getByTestId('power-source-change'));

    expect(screen.getByTestId('stub-connect')).toBeInTheDocument();
    expect(renderConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'opencode',
        connect: { kind: 'provider-picker', label: 'Change power source' },
        currentProvider: 'ollama',
      })
    );
  });

  it('renders without a picker when it is handed no provider at all', () => {
    const renderConnect = vi.fn<RuntimeConnectSlot>();
    render(<PowerSourceSectionView type="opencode" renderConnect={renderConnect} />);

    expect(screen.getByTestId('power-source-empty')).toBeInTheDocument();
    expect(renderConnect).not.toHaveBeenCalled();
  });
});
