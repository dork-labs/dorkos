// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SystemRequirements } from '@dorkos/shared/agent-runtime';
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

const codexMissing: SystemRequirements = {
  runtimes: {
    'claude-code': {
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
      dependencies: [
        {
          name: 'Codex CLI',
          description: 'The Codex CLI binary.',
          status: 'missing',
          installHint: 'npm i -g @openai/codex && codex login',
          infoUrl: 'https://developers.openai.com/codex',
        },
      ],
    },
  },
  allSatisfied: false,
};

describe('RuntimeSetupPanel', () => {
  describe('scoped to one runtime', () => {
    it('renders the needs-setup state with the copyable install command', () => {
      render(
        <RuntimeSetupPanel
          runtime="codex"
          requirements={codexMissing}
          registeredTypes={['claude-code', 'codex']}
        />
      );

      expect(screen.getByTestId('runtime-section-codex')).toBeInTheDocument();
      expect(screen.getByText('Needs setup')).toBeInTheDocument();
      expect(screen.getByText('npm i -g @openai/codex && codex login')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /copy install command for codex cli/i })
      ).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /learn more/i })).toHaveAttribute(
        'href',
        'https://developers.openai.com/codex'
      );
      // Scoped panel shows only the requested runtime.
      expect(screen.queryByTestId('runtime-section-claude-code')).not.toBeInTheDocument();
    });

    it('renders the ready state for a satisfied runtime', () => {
      render(
        <RuntimeSetupPanel
          runtime="claude-code"
          requirements={codexMissing}
          registeredTypes={['claude-code', 'codex']}
        />
      );

      expect(screen.getByText('Ready')).toBeInTheDocument();
      expect(screen.getByText('v2.1.0')).toBeInTheDocument();
      expect(screen.queryByText('Needs setup')).not.toBeInTheDocument();
    });

    it('falls back to static descriptor guidance for an unregistered runtime', () => {
      render(
        <RuntimeSetupPanel
          runtime="opencode"
          requirements={codexMissing}
          registeredTypes={['claude-code', 'codex']}
        />
      );

      expect(screen.getByText('Needs setup')).toBeInTheDocument();
      expect(screen.getByText('npm i -g opencode-ai && opencode auth login')).toBeInTheDocument();
      expect(screen.getByText(/not registered with this server/i)).toBeInTheDocument();
    });
  });

  describe('"Add a runtime" overview (unscoped)', () => {
    it('lists unsatisfied registered runtimes and addable unregistered ones', () => {
      render(
        <RuntimeSetupPanel requirements={codexMissing} registeredTypes={['claude-code', 'codex']} />
      );

      // codex: registered but missing its CLI; opencode: known addable, unregistered.
      expect(screen.getByTestId('runtime-section-codex')).toBeInTheDocument();
      expect(screen.getByTestId('runtime-section-opencode')).toBeInTheDocument();
      // claude-code is registered and ready — the overview is not an inventory.
      expect(screen.queryByTestId('runtime-section-claude-code')).not.toBeInTheDocument();
    });
  });

  it('invokes onRecheck from the Check again button', async () => {
    const user = userEvent.setup();
    const onRecheck = vi.fn();
    render(
      <RuntimeSetupPanel
        runtime="codex"
        requirements={codexMissing}
        registeredTypes={['claude-code', 'codex']}
        onRecheck={onRecheck}
      />
    );

    await user.click(screen.getByRole('button', { name: /check again/i }));
    expect(onRecheck).toHaveBeenCalledTimes(1);
  });
});

describe('RuntimeSetupDialog', () => {
  function renderDialog(runtime?: string) {
    const transport = createMockTransport({
      checkRequirements: vi.fn().mockResolvedValue(codexMissing),
      getCapabilities: vi.fn().mockResolvedValue({
        capabilities: { 'claude-code': { type: 'claude-code' }, codex: { type: 'codex' } },
        defaultRuntime: 'claude-code',
      }),
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
    return render(<RuntimeSetupDialog runtime={runtime} open onOpenChange={vi.fn()} />, {
      wrapper: Wrapper,
    });
  }

  it('titles the scoped panel with the runtime label and loads live requirements', async () => {
    renderDialog('codex');

    expect(screen.getByText('Set up Codex')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('npm i -g @openai/codex && codex login')).toBeInTheDocument();
    });
  });

  it('titles the unscoped panel "Add a runtime"', async () => {
    renderDialog(undefined);

    expect(screen.getByText('Add a runtime')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('runtime-section-opencode')).toBeInTheDocument();
    });
  });
});
