// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { ExecutionException } from '@/layers/entities/agent';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { useProfileStore } from '@/layers/features/profile';
import { ExecutionExceptionsStrip } from '../ui/runtimes/ExecutionExceptionsStrip';

// No RouterProvider here — the strip only asks the deep-link hook to CLOSE the
// dialog, which the close-then-open assertion below stands in for. URL behavior
// is covered by `use-dialog-deep-link.test.tsx`.
const mockCloseSettings = vi.fn();
vi.mock('@/layers/shared/model/use-dialog-deep-link', () => ({
  useSettingsDeepLink: () => ({
    isOpen: true,
    activeTab: 'runtimes',
    section: null,
    open: vi.fn(),
    close: mockCloseSettings,
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
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function agent(name: string, extra: Partial<AgentManifest> = {}): AgentManifest {
  return {
    id: name,
    name,
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    color: '#888',
    icon: '🤖',
    ...extra,
  } as AgentManifest;
}

const CATALOG = [
  { value: 'opus', displayName: 'Opus', description: '', supportsEffort: true },
  { value: 'haiku', displayName: 'Haiku', description: '', supportsEffort: false },
];

/** The runtimes this machine has, and what each declares about effort. */
const CAPABILITIES = {
  capabilities: { 'claude-code': { type: 'claude-code' } },
  defaultRuntime: 'claude-code',
};

/** Two registered accounts, plus the unregistered root the server synthesizes. */
const ACCOUNTS = {
  resolvedAccount: '/Users/dev/.claude',
  inherited: true,
  accounts: [
    { id: null, path: '/Users/dev/.claude', label: null, isAccountRoot: true },
    { id: 'work', path: '/Users/dev/.claude-work', label: 'Acme Corp', isAccountRoot: true },
  ],
};

function renderStrip(
  agents: Record<string, AgentManifest>,
  opts: {
    models?: typeof CATALOG;
    perRuntimeModel?: string | null;
    capabilities?: typeof CAPABILITIES;
    claudeCode?: typeof ACCOUNTS;
  } = {}
) {
  const models = opts.models ?? CATALOG;
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue({
      version: '1.0.0',
      port: 4242,
      uptime: 0,
      workingDirectory: '/test',
      nodeVersion: 'v20.0.0',
      platform: 'linux-x64',
      runtimes: ['claude-code'],
      claudeCliPath: null,
      claudeCode: opts.claudeCode,
      executionDefaults: {
        runtime: 'claude-code',
        perRuntime: [
          {
            runtime: 'claude-code',
            model: opts.perRuntimeModel ?? null,
            effort: null,
            supportsEffort: true,
          },
        ],
      },
      tunnel: {
        enabled: false,
        connected: false,
        url: null,
        authEnabled: false,
        tokenConfigured: false,
      },
    }),
    getCapabilities: vi.fn().mockResolvedValue(opts.capabilities ?? CAPABILITIES),
    listMeshAgentPaths: vi
      .fn()
      .mockResolvedValue({ agents: Object.keys(agents).map((p) => ({ projectPath: p })) }),
    resolveAgents: vi.fn().mockResolvedValue(agents),
    getModels: vi.fn().mockResolvedValue(models),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <ExecutionExceptionsStrip />
      </TransportProvider>
    </QueryClientProvider>
  );
}

describe('ExecutionExceptionsStrip — an injected fleet (showcase path)', () => {
  /** One exception, already decided, as a showcase hands it over. */
  function exception(name: string, broken: boolean): ExecutionException {
    return {
      path: `/${name}`,
      agent: agent(name),
      report: {
        breakages: broken
          ? [{ kind: 'runtime-not-connected', message: 'Codex is not connected.' }]
          : [],
        deviations: broken ? [] : [{ field: 'model', label: 'opus' }],
        isException: true,
        isBroken: broken,
      },
    };
  }

  function renderInjected(exceptions: ExecutionException[]) {
    const transport = createMockTransport();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <ExecutionExceptionsStrip exceptions={exceptions} />
        </TransportProvider>
      </QueryClientProvider>
    );
    return transport;
  }

  it('draws what it was handed, over a fleet that deviates in nothing', async () => {
    // The transport's fleet is empty, so every row on screen came from the prop.
    renderInjected([exception('beta', true), exception('alpha', false)]);

    expect(await screen.findByTestId('execution-exception-broken')).toHaveTextContent(
      'Codex is not connected.'
    );
    expect(screen.getByTestId('execution-exception')).toHaveTextContent('model opus');
  });

  it('spends no catalog round-trip deciding what the caller already decided', async () => {
    const transport = renderInjected([exception('alpha', false)]);
    await screen.findByTestId('execution-exception');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(transport.getModels).not.toHaveBeenCalled();
  });

  it('still draws nothing at all when it is handed an empty fleet', async () => {
    renderInjected([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId('execution-exceptions-strip')).toBeNull();
  });
});

describe('ExecutionExceptionsStrip', () => {
  it('draws nothing at all when the whole fleet inherits', async () => {
    renderStrip({ '/a': agent('alpha') });
    await waitFor(() => expect(screen.queryByTestId('execution-exceptions-strip')).toBeNull());
    // Give the queries a chance to settle and still show nothing.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('execution-exceptions-strip')).toBeNull();
  });

  it('names a healthy deviation without calling it broken', async () => {
    renderStrip({ '/a': agent('alpha', { model: 'opus' }) });
    expect(await screen.findByTestId('execution-exception')).toHaveTextContent('model opus');
    expect(screen.queryByTestId('execution-exception-broken')).toBeNull();
  });

  it('puts broken agents first, in their own row kind', async () => {
    renderStrip({
      '/a': agent('alpha', { model: 'opus' }),
      '/b': agent('beta', { runtime: 'codex' }),
    });
    const broken = await screen.findByTestId('execution-exception-broken');
    expect(broken).toHaveTextContent('Codex is not connected');
    const rows = screen.getAllByRole('button');
    expect(rows[0]).toBe(broken);
  });

  it('opens the agent’s own profile, and gets the dialog out of the way first', async () => {
    const openProfileDocked = vi.spyOn(useProfileStore.getState(), 'openProfileDocked');
    renderStrip({ '/a': agent('alpha', { model: 'opus' }) });
    await userEvent.click(await screen.findByTestId('execution-exception'));
    expect(mockCloseSettings).toHaveBeenCalled();
    expect(openProfileDocked).toHaveBeenCalledWith('/a');
    // Naming the agent is not the same as showing it: without these the dialog
    // closes onto an unchanged dashboard.
    expect(useAppStore.getState().explicitAgentPath).toBe('/a');
    expect(useAppStore.getState().rightPanelOpen).toBe(true);
    expect(useAppStore.getState().activeRightPanelTab).toBe('profile');
  });

  it('calls a pinned model the runtime no longer offers broken', async () => {
    renderStrip({ '/a': agent('alpha', { model: 'opus-3' }) });
    expect(await screen.findByTestId('execution-exception-broken')).toHaveTextContent(
      'Claude Code no longer offers opus-3'
    );
  });

  // ── B1: the catalog answers 200 {models: []} while it warms up ─────────────
  it('does not turn the whole fleet amber against a cold catalog', async () => {
    renderStrip({ '/a': agent('alpha', { model: 'opus' }) }, { models: [] });
    // The row still appears — pinning a model IS a deviation — but a warming
    // catalog must not upgrade that deviation to breakage.
    expect(await screen.findByTestId('execution-exception')).toHaveTextContent('model opus');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('execution-exception-broken')).toBeNull();
  });

  // ── I3: the strip and the Config tab judge effort by the same model ────────
  it('calls an effort broken against the INHERITED model that cannot take it', async () => {
    // The agent pins nothing; the server default for its runtime is Haiku,
    // which takes no effort. The strip used to look only at pinned models and
    // so called this agent healthy while its own Config tab called it broken.
    renderStrip({ '/a': agent('alpha', { effort: 'high' }) }, { perRuntimeModel: 'haiku' });
    expect(await screen.findByTestId('execution-exception-broken')).toHaveTextContent(
      'haiku does not take an effort setting'
    );
  });

  // A runtime this machine does not have declares nothing, so its effort
  // support is unknown rather than absent — and unknown is never reported. The
  // one breakage a person can act on is the one they get.
  it('says only that an unconnected runtime is missing, not what its effort would do', async () => {
    renderStrip({ '/a': agent('alpha', { runtime: 'opencode', effort: 'high' }) });
    const row = await screen.findByTestId('execution-exception-broken');
    expect(row).toHaveTextContent('OpenCode is not connected on this machine.');
    expect(row).not.toHaveTextContent('so this one does nothing.');
  });

  // ── I4: a joined multi-breakage sentence must not be cut off mid-word ──────
  it('carries the whole reason in a tooltip, however many breakages joined it', async () => {
    // A connected OpenCode that declares no effort, carrying a model pin its
    // catalog dropped: two breakages at once, from one agent, both real.
    renderStrip(
      { '/a': agent('alpha', { runtime: 'opencode', model: 'haiku', effort: 'high' }) },
      {
        capabilities: {
          capabilities: {
            'claude-code': { type: 'claude-code' },
            opencode: {
              type: 'opencode',
              settings: { configSection: 'opencode', supportsEffort: false, sections: [] },
            },
          },
          defaultRuntime: 'claude-code',
        } as unknown as typeof CAPABILITIES,
        models: [{ value: 'opus', displayName: 'Opus', description: '', supportsEffort: true }],
      }
    );
    const row = await screen.findByTestId('execution-exception-broken');
    const reason = row.querySelector('[title]');
    expect(reason).not.toBeNull();
    // The full sentence, not the clipped render — both breakages, both intact.
    expect(reason).toHaveAttribute(
      'title',
      expect.stringContaining('OpenCode no longer offers haiku.')
    );
    expect(reason?.getAttribute('title')).toContain('so this one does nothing.');
    // Clamped to two lines rather than one, so the pair fits without a tooltip
    // at every width the strip is drawn at.
    expect(reason).toHaveClass('line-clamp-2');
  });
});

describe('ExecutionExceptionsStrip — billing overrides', () => {
  it('names an agent that bills to another account', async () => {
    renderStrip({ '/a': agent('alpha', { account: 'work' }) }, { claudeCode: ACCOUNTS });
    // The registry's label, not the raw id — the strip sits under cards that
    // call the same account "Acme Corp".
    expect(await screen.findByTestId('execution-exception')).toHaveTextContent(
      'bills to Acme Corp'
    );
    expect(screen.queryByTestId('execution-exception-broken')).toBeNull();
  });

  it('calls an account nobody registered broken, and puts it above a plain deviation', async () => {
    renderStrip(
      {
        '/a': agent('alpha', { model: 'opus' }),
        '/b': agent('zeta', { account: 'retired-client' }),
      },
      { claudeCode: ACCOUNTS }
    );
    const broken = await screen.findByTestId('execution-exception-broken');
    expect(broken).toHaveTextContent('no longer registered');
    // Broken first, however the fleet came back and whatever the names sort to:
    // "zeta" would follow "alpha" on name alone.
    const rows = screen.getAllByRole('button');
    expect(rows[0]).toHaveTextContent('zeta');
    expect(rows[1]).toHaveTextContent('alpha');
  });

  it('says nothing about any account until the registry has been read', async () => {
    // No `claudeCode` on the config at all — the same silence a cold model
    // catalog keeps. The override is still named; only the verdict waits.
    renderStrip({ '/a': agent('alpha', { account: 'retired-client' }) });
    expect(await screen.findByTestId('execution-exception')).toHaveTextContent(
      'bills to retired-client'
    );
    expect(screen.queryByTestId('execution-exception-broken')).toBeNull();
  });

  it('leaves an agent that inherits its account out of the strip entirely', async () => {
    renderStrip({ '/a': agent('alpha') }, { claudeCode: ACCOUNTS });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('execution-exceptions-strip')).toBeNull();
  });
});
