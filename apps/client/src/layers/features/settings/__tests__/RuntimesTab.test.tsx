/**
 * The recomposed Runtimes tab (spec `runtimes-settings-redesign`, task 2.9).
 *
 * What this file is for is the COMPOSITION, not the cards: which runtimes appear
 * and in what order, that the default is a card state rather than a dropdown,
 * and that both settings the tab owns — `runtimes.default` and every trust stop —
 * leave through the one write path each. The cards' own behaviour is pinned in
 * `ui/runtimes/__tests__/RuntimeCard.test.tsx`, and the consent contract in
 * `use-trust-stop-writes.test.tsx`; neither is re-tested here.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { SystemRequirements } from '@dorkos/shared/agent-runtime';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { RuntimesTab } from '../ui/runtimes/RuntimesTab';

// The tab composes the exceptions strip, whose rows close the Settings dialog on
// the way to an agent — so it reads the deep-link hook, which needs a router
// these tests deliberately do not mount. Same stand-in `SettingsDialog` uses;
// URL behavior is covered by `use-dialog-deep-link.test.tsx`.
vi.mock('@/layers/shared/model/use-dialog-deep-link', () => ({
  useSettingsDeepLink: () => ({
    isOpen: true,
    activeTab: 'runtimes',
    section: null,
    open: vi.fn(),
    close: vi.fn(),
    setTab: vi.fn(),
    setSection: vi.fn(),
  }),
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
  // Radix needs DOM APIs jsdom lacks to open a listbox or an alert dialog.
  const proto = Element.prototype as unknown as Record<string, unknown>;
  if (!proto.hasPointerCapture) proto.hasPointerCapture = vi.fn();
  if (!proto.releasePointerCapture) proto.releasePointerCapture = vi.fn();
  if (!proto.scrollIntoView) proto.scrollIntoView = vi.fn();
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Every runtime connected — the state the composition assertions are about. */
const ALL_READY = {
  runtimes: {
    'claude-code': { state: 'ready', dependencies: [] },
    codex: { state: 'ready', dependencies: [] },
    opencode: { state: 'ready', dependencies: [], provider: 'ollama' },
  },
} as unknown as SystemRequirements;

type PerRuntime = {
  runtime: string;
  model: string | null;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  supportsEffort: boolean;
  trustStop: 'ask' | 'act' | 'autonomy' | null;
};

/** One `perRuntime` entry, so each test states only what it changes. */
function entry(runtime: string, over: Partial<PerRuntime> = {}): PerRuntime {
  return { runtime, model: null, effort: null, supportsEffort: true, trustStop: null, ...over };
}

/** The `GET /api/config` projection this tab reads. */
function makeConfig(over: Record<string, unknown> = {}) {
  return {
    version: '1.0.0',
    port: 4242,
    uptime: 0,
    workingDirectory: '/test',
    nodeVersion: 'v20.0.0',
    platform: 'linux-x64',
    runtimes: ['claude-code', 'codex', 'opencode'],
    claudeCliPath: null,
    executionDefaults: {
      runtime: 'claude-code',
      trustStop: null,
      perRuntime: [entry('claude-code'), entry('codex'), entry('opencode')],
    },
    tunnel: {
      enabled: false,
      connected: false,
      url: null,
      authEnabled: false,
      tokenConfigured: false,
    },
    ...over,
  };
}

/**
 * A capability map with one runtime beyond the three, plus `test-mode`.
 *
 * Both halves of the ordering rule in one fixture: a future backend appears
 * after the primaries, and the e2e harness runtime appears nowhere.
 */
async function capabilitiesWithExtras() {
  const base = await createMockTransport().getCapabilities();
  const codex = base.capabilities.codex!;
  return {
    ...base,
    capabilities: {
      ...base.capabilities,
      'future-runtime': { ...codex, type: 'future-runtime' },
      'test-mode': { ...codex, type: 'test-mode' },
    },
  };
}

function renderTab(transportOverrides: Record<string, unknown> = {}) {
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue(makeConfig()),
    checkRequirements: vi.fn().mockResolvedValue(ALL_READY),
    updateConfig: vi.fn().mockResolvedValue(undefined),
    ...transportOverrides,
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
  return {
    transport,
    queryClient,
    updateConfig: vi.mocked(transport.updateConfig),
    checkRequirements: vi.mocked(transport.checkRequirements),
  };
}

/** The cards on screen, in the order they are drawn. */
function cardTypes(): string[] {
  return screen
    .getAllByRole('article')
    .map((card) => card.getAttribute('data-testid')?.replace('runtime-card-', '') ?? '');
}

describe('RuntimesTab — which cards, in what order', () => {
  it('gives every runtime a card, in the product’s own order', async () => {
    renderTab();
    await screen.findByTestId('runtime-card-claude-code');
    expect(cardTypes()).toEqual(['claude-code', 'codex', 'opencode']);
  });

  it('appends a future runtime after the three, and never lists the test harness', async () => {
    renderTab({ getCapabilities: vi.fn(capabilitiesWithExtras) });
    await screen.findByTestId('runtime-card-future-runtime');
    expect(cardTypes()).toEqual(['claude-code', 'codex', 'opencode', 'future-runtime']);
    expect(screen.queryByTestId('runtime-card-test-mode')).not.toBeInTheDocument();
  });

  it('has no default-runtime dropdown anywhere: the default is a card state', async () => {
    renderTab();
    await screen.findByTestId('runtime-card-claude-code');
    expect(screen.queryByTestId('default-runtime-select')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Default runtime' })).not.toBeInTheDocument();
  });

  it('marks the default card and offers the choice on the others', async () => {
    renderTab();
    expect(await screen.findByTestId('runtime-default-pill-claude-code')).toBeInTheDocument();
    expect(screen.queryByTestId('runtime-make-default-claude-code')).not.toBeInTheDocument();
    expect(screen.getByTestId('runtime-make-default-codex')).toBeInTheDocument();
    expect(screen.getByTestId('runtime-make-default-opencode')).toBeInTheDocument();
  });
});

describe('RuntimesTab — the writes the tab owns', () => {
  it('writes the default runtime itself, so two cards cannot race', async () => {
    const { updateConfig } = renderTab();
    await userEvent.click(await screen.findByTestId('runtime-make-default-codex'));

    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({ runtimes: { default: 'codex' } })
    );
  });

  it('says what the server said when it refuses the default', async () => {
    const { updateConfig } = renderTab({
      updateConfig: vi.fn().mockRejectedValue(new Error('Only a person can change those settings')),
    });
    await userEvent.click(await screen.findByTestId('runtime-make-default-codex'));

    await waitFor(() => expect(updateConfig).toHaveBeenCalled());
    expect(await screen.findByTestId('runtimes-tab-error')).toHaveTextContent(
      'Only a person can change those settings'
    );
  });

  it('sends a card’s trust change through the tab’s single write path', async () => {
    // The card reports the change and writes nothing itself: what lands on the
    // wire is the runtime's own section, from the hook the tab owns.
    const { updateConfig } = renderTab();
    await userEvent.click(await screen.findByTestId('runtime-card-toggle-codex'));
    const card = await screen.findByTestId('runtime-card-codex');
    await userEvent.click(within(card).getByRole('radio', { name: 'Pauses at big steps' }));

    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({
        runtimes: { codex: { defaultTrustStop: 'act' } },
      })
    );
  });

  it('sends the shared row through that same path', async () => {
    const { updateConfig } = renderTab();
    const row = await screen.findByTestId('global-trust-row');
    await userEvent.click(within(row).getByRole('radio', { name: 'Pauses at big steps' }));

    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({ runtimes: { defaultTrustStop: 'act' } })
    );
  });

  it('asks for Full autonomy through ONE dialog, and sends the answer with the stop', async () => {
    const { updateConfig } = renderTab();
    const row = await screen.findByTestId('global-trust-row');
    await userEvent.click(within(row).getByRole('radio', { name: 'Full autonomy' }));

    // One door for the whole tab, whichever control opened it.
    const dialogs = await screen.findAllByRole('alertdialog');
    expect(dialogs).toHaveLength(1);
    expect(updateConfig).not.toHaveBeenCalled();

    await userEvent.click(
      within(dialogs[0]!).getByRole('button', { name: /turn on|full access|bypass/i })
    );
    await waitFor(() => expect(updateConfig).toHaveBeenCalledTimes(1));
    expect(updateConfig.mock.calls[0]![0]).toMatchObject({
      ui: { autonomyAcknowledgedAt: expect.any(String) },
      runtimes: { defaultTrustStop: 'autonomy' },
    });
  });
});

describe('RuntimesTab — the rest of the page', () => {
  it('draws the shared trust row once, beneath the cards', async () => {
    renderTab();
    const row = await screen.findByTestId('global-trust-row');
    expect(screen.getAllByTestId('global-trust-row')).toHaveLength(1);

    const lastCard = screen.getAllByRole('article').at(-1)!;
    expect(lastCard.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('names every runtime with a stored entry to the row, for the standing-autonomy note', async () => {
    renderTab({
      getConfig: vi.fn().mockResolvedValue(
        makeConfig({
          executionDefaults: {
            runtime: 'claude-code',
            trustStop: 'ask',
            perRuntime: [entry('claude-code'), entry('codex', { trustStop: 'autonomy' })],
          },
        })
      ),
    });

    expect(await screen.findByTestId('default-trust-stop-standing-note')).toHaveTextContent(
      'New sessions on Codex run at full power'
    );
  });

  it('draws no exceptions strip while the whole fleet inherits', async () => {
    const { queryClient } = renderTab();
    await screen.findByTestId('runtime-card-claude-code');
    // Everything the tab asked for has answered — the fleet the strip reads
    // included — so an absent strip is a settled answer rather than one still
    // in flight. A fixed sleep would have asserted the same thing about a race.
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(screen.queryByTestId('execution-exceptions-strip')).not.toBeInTheDocument();
  });

  it('draws a row for an agent that runs on something else', async () => {
    const alpha = {
      id: 'alpha',
      name: 'alpha',
      description: '',
      runtime: 'claude-code',
      model: 'claude-opus-4-6',
      capabilities: [],
      color: '#888',
      icon: '🤖',
    } as unknown as AgentManifest;

    renderTab({
      listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: [{ projectPath: '/a' }] }),
      resolveAgents: vi.fn().mockResolvedValue({ '/a': alpha }),
    });

    expect(await screen.findByTestId('execution-exception')).toHaveTextContent('model');
  });

  it('rechecks the connections from the quiet refresh affordance', async () => {
    const { checkRequirements } = renderTab();
    await waitFor(() => expect(checkRequirements).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByTestId('runtimes-recheck'));
    await waitFor(() => expect(checkRequirements).toHaveBeenCalledTimes(2));
  });

  it('refuses a second recheck while one is still in flight', async () => {
    renderTab({ checkRequirements: vi.fn(() => new Promise(() => {})) });
    expect(await screen.findByTestId('runtimes-recheck')).toBeDisabled();
  });
});
