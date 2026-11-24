// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, within, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { ExecutionDefaults, ModelOption } from '@dorkos/shared/types';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import { createMockAccountUsage, createMockTransport } from '@dorkos/test-utils/mock-factories';
import { TransportProvider, seedAccountUsage } from '@/layers/shared/model';
import { AgentExecutionRows } from '../ui/AgentExecutionRows';

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

/** When set, the catalog read fails, as an unreadable credits list does. */
let modelsFail = false;
/** When set, which runtimes run on credits by default (`GET /api/cloud/credits`). */
let creditsDefaults: Record<string, { runsOn: 'credits' }> | null = null;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  modelsFail = false;
  creditsDefaults = null;
});

const DEFAULTS: ExecutionDefaults = {
  runtime: 'claude-code',
  trustStop: null,
  perRuntime: [
    {
      runtime: 'claude-code',
      model: 'opus',
      effort: 'medium',
      supportsEffort: true,
      trustStop: null,
    },
    { runtime: 'opencode', model: null, effort: null, supportsEffort: false, trustStop: null },
  ],
};

// Typed, so a catalog a case hands in is the shape the wire really carries —
// which is how `unverified` became addable here at all.
const MODELS: ModelOption[] = [
  { value: 'opus', displayName: 'Opus', description: '', supportsEffort: true },
  { value: 'sonnet', displayName: 'Sonnet', description: '', supportsEffort: true },
  { value: 'haiku', displayName: 'Haiku', description: '', supportsEffort: false },
];

function manifest(extra: Partial<AgentManifest> = {}): AgentManifest {
  return {
    id: 'a',
    name: 'alpha',
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    ...extra,
  } as AgentManifest;
}

/**
 * A capability map that declares both runtimes' settings surface, so the rows
 * can be rendered against the runtime's own answer rather than a defaults row.
 */
function capabilityMap(opencodeSupportsEffort: boolean) {
  const entry = (type: string, supportsEffort: boolean) => ({
    type,
    supportsToolApproval: true,
    supportsCostTracking: false,
    supportsResume: true,
    supportsMcp: true,
    supportsQuestionPrompt: true,
    supportsPlugins: false,
    permissionModes: { supported: false, values: [] },
    settings: { configSection: type, supportsEffort, sections: [] },
    features: {},
  });
  return {
    capabilities: {
      'claude-code': entry('claude-code', true),
      opencode: entry('opencode', opencodeSupportsEffort),
    },
    defaultRuntime: 'claude-code',
  };
}

/**
 * A capability map that never lands — the window between the first paint and
 * the query answering, which used to render an editable effort control.
 */
const WITHHELD = 'withheld' as const;

/** The account registry as `GET /api/config` reports it, when a test supplies one. */
interface ClaudeCodeConfig {
  resolvedAccount: string;
  inherited: boolean;
  accounts: { id: string | null; path: string; label: string | null; isAccountRoot: boolean }[];
  /** The server admitting it could not read the registry at all. */
  accountsUnavailable?: boolean;
  /** The DorkOS credits entry, when the server offers it. */
  credits?: {
    id: 'dorkos-credits';
    path: string;
    available: boolean;
    isDefault: boolean;
    allowedAgents: string[];
  };
}

/** Two registered accounts — the smallest registry that offers a real choice. */
const TWO_ACCOUNTS: ClaudeCodeConfig = {
  resolvedAccount: '/Users/dev/.claude',
  inherited: false,
  accounts: [
    { id: 'personal', path: '/Users/dev/.claude', label: null, isAccountRoot: true },
    { id: 'work', path: '/Users/dev/.claude-work', label: 'Acme Corp', isAccountRoot: true },
  ],
};

function renderRows(
  agent: AgentManifest,
  executionDefaults: ExecutionDefaults = DEFAULTS,
  models: ModelOption[] = MODELS,
  capabilities: ReturnType<typeof capabilityMap> | typeof WITHHELD = capabilityMap(false),
  claudeCode: ClaudeCodeConfig | undefined = undefined,
  usage: AccountUsage[] = []
) {
  const onUpdate = vi.fn();
  const transport = createMockTransport({
    getCapabilities: vi
      .fn()
      .mockImplementation(() =>
        capabilities === WITHHELD ? new Promise(() => {}) : Promise.resolve(capabilities)
      ),
    getConfig: vi.fn().mockResolvedValue({
      version: '1.0.0',
      port: 4242,
      uptime: 0,
      workingDirectory: '/test',
      nodeVersion: 'v20.0.0',
      platform: 'linux-x64',
      runtimes: ['claude-code'],
      claudeCliPath: null,
      claudeCode,
      executionDefaults,
      tunnel: {
        enabled: false,
        connected: false,
        url: null,
        authEnabled: false,
        tokenConfigured: false,
      },
    }),
    ...(creditsDefaults
      ? {
          getCloudCredits: vi
            .fn()
            .mockResolvedValue({ linked: true, available: true, defaults: creditsDefaults }),
        }
      : {}),
    getModels: modelsFail
      ? vi.fn().mockRejectedValue(new Error('The models could not be read'))
      : vi.fn().mockResolvedValue(models),
    // The Account row's one write path (DOR-1736).
    updateMeshAgent: vi.fn().mockResolvedValue(agent),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  // What the session list's envelope seeds.
  seedAccountUsage(queryClient, usage);
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <AgentExecutionRows agent={agent} onUpdate={onUpdate} />
      </TransportProvider>
    </QueryClientProvider>
  );
  return { onUpdate, transport, queryClient };
}

describe('AgentExecutionRows', () => {
  it('wears the server default when the agent has no opinion', async () => {
    renderRows(manifest());
    await waitFor(() =>
      expect(screen.getByTestId('agent-model-row-chip')).toHaveTextContent('Server default · opus')
    );
    expect(screen.getByTestId('agent-model-row')).toHaveTextContent('Opus');
    expect(screen.getByTestId('agent-effort-row-chip')).toHaveTextContent(
      'Server default · Medium'
    );
  });

  // The design's whole point: the chip IS the reset, and its one action clears
  // the field back to inheriting — which on the wire is `null`, not `undefined`.
  it('offers exactly one action from a "set here" chip, and it clears the field', async () => {
    const { onUpdate } = renderRows(manifest({ model: 'sonnet' }));
    await waitFor(() =>
      expect(screen.getByTestId('agent-model-row-chip')).toHaveTextContent('Set here')
    );
    await userEvent.click(screen.getByRole('button', { name: /set here/i }));
    const reset = await screen.findByTestId('agent-model-row-chip-reset');
    expect(reset).toHaveTextContent('Use server default');
    expect(reset).toHaveTextContent('Currently opus');
    await userEvent.click(reset);
    expect(onUpdate).toHaveBeenCalledWith({ model: null });
  });

  it('picks a model through the row, and writes it', async () => {
    const { onUpdate } = renderRows(manifest());
    await waitFor(() => expect(screen.getByTestId('agent-model-row')).toHaveTextContent('Opus'));
    await userEvent.click(screen.getByTestId('agent-model-row'));
    await userEvent.click(await screen.findByRole('button', { name: 'Sonnet' }));
    expect(onUpdate).toHaveBeenCalledWith({ model: 'sonnet' });
  });

  it('warns about an effort stored where the runtime has none, and still lets it be cleared', async () => {
    const { onUpdate } = renderRows(manifest({ runtime: 'opencode', effort: 'high' }));
    expect(await screen.findByTestId('agent-effort-unsupported-runtime')).toHaveTextContent(
      'has no effort setting'
    );
    await userEvent.click(screen.getByTestId('agent-effort-row-chip').closest('button')!);
    await userEvent.click(await screen.findByTestId('agent-effort-row-chip-reset'));
    expect(onUpdate).toHaveBeenCalledWith({ effort: null });
  });

  // ── The capped catalog has to admit itself here too (DOR-1674) ────────────
  it('admits an unconfirmed catalog, and points the row at the admission', async () => {
    // With no provider connected every row arrives `unverified`, and a list
    // that stays silent about that reads as complete when it is a guess.
    renderRows(
      manifest(),
      DEFAULTS,
      MODELS.map((m) => ({ ...m, unverified: true }))
    );
    const notice = await screen.findByTestId('model-catalog-unverified');
    expect(notice).toBeVisible();
    // Seeing it is not enough: the trigger describes itself by the notice, so a person navigating
    // by control hears the admission rather than only the model name.
    expect(screen.getByTestId('agent-model-row')).toHaveAttribute(
      'aria-describedby',
      notice.getAttribute('id')
    );
  });

  // ── B2: a picker that stays open hides the row it just changed ─────────────
  it('closes the picker once a model is chosen', async () => {
    renderRows(manifest());
    await waitFor(() => expect(screen.getByTestId('agent-model-row')).toHaveTextContent('Opus'));
    await userEvent.click(screen.getByTestId('agent-model-row'));
    await userEvent.click(await screen.findByRole('button', { name: 'Sonnet' }));
    await waitFor(() => expect(screen.queryByTestId('agent-model-row-inherit')).toBeNull());
  });

  // ── I3: effort is judged against the model that will actually run ──────────
  it('names an inherited model that cannot take the effort this agent set', async () => {
    renderRows(manifest({ effort: 'high' }), {
      runtime: 'claude-code',
      trustStop: null,
      perRuntime: [
        {
          runtime: 'claude-code',
          model: 'haiku',
          effort: null,
          supportsEffort: true,
          trustStop: null,
        },
      ],
    });
    expect(await screen.findByTestId('agent-effort-unsupported-model')).toHaveTextContent(
      'haiku does not take an effort setting'
    );
  });
});

describe('AgentExecutionRows — the Account row', () => {
  it('is absent on a runtime that has no such thing as an account', async () => {
    renderRows(manifest({ runtime: 'opencode' }), DEFAULTS, MODELS, capabilityMap(true), {
      ...TWO_ACCOUNTS,
    });
    // Wait for something the same config DOES draw, so the absence below is a
    // rendered absence rather than a not-yet.
    await waitFor(() =>
      expect(screen.getByTestId('agent-model-row-chip')).toHaveTextContent('Server default')
    );
    expect(screen.queryByTestId('agent-account-row')).toBeNull();
  });

  it('names an unregistered server default by the host label, never ".claude" (§12)', async () => {
    const MAIN = "Main (this computer's sign-in)";
    renderRows(
      manifest(),
      DEFAULTS,
      MODELS,
      capabilityMap(false),
      {
        resolvedAccount: '/Users/dev/.claude',
        inherited: true,
        accounts: [
          { id: 'work', path: '/Users/dev/.claude-work', label: 'Acme Corp', isAccountRoot: true },
          { id: 'side', path: '/Users/dev/.claude-side', label: 'Side', isAccountRoot: true },
        ],
      },
      [createMockAccountUsage({ accountId: 'default', path: '/Users/dev/.claude', label: MAIN })]
    );
    expect(await screen.findByTestId('agent-account-row-chip')).toHaveTextContent(
      `Server default · ${MAIN}`
    );
    expect(screen.queryByText(/\.claude$/)).toBeNull();
  });

  // DOR-1736.
  it('writes the registry id through the OPERATOR route, never the agent self-edit route', async () => {
    const { onUpdate, transport } = renderRows(
      manifest(),
      DEFAULTS,
      MODELS,
      capabilityMap(false),
      TWO_ACCOUNTS
    );
    await userEvent.click(await screen.findByTestId('agent-account-row'));
    await userEvent.click(await screen.findByRole('button', { name: /Acme Corp/ }));
    await waitFor(() =>
      expect(transport.updateMeshAgent).toHaveBeenCalledWith('a', { account: 'work' })
    );
    // The self-edit route this row used to take, and the one that 403s.
    expect(onUpdate).not.toHaveBeenCalled();
  });

  // ADR 261001-000811: an agent's own file cannot put it on DorkOS credits.
  it('says when an agent’s file names credits nobody allowed, and lets a person allow it', async () => {
    const credits = {
      id: 'dorkos-credits' as const,
      path: '/Users/dev/.dork/runtimes/claude-code/credits',
      available: true,
      isDefault: false,
      allowedAgents: [],
    };
    const { transport } = renderRows(
      manifest({ account: 'dorkos-credits' }),
      DEFAULTS,
      MODELS,
      capabilityMap(false),
      { ...TWO_ACCOUNTS, credits }
    );
    const notice = await screen.findByTestId('agent-credits-not-allowed');
    expect(notice).toHaveTextContent('It uses your default until you allow it.');
    await userEvent.click(within(notice).getByRole('button', { name: 'Allow' }));
    await waitFor(() =>
      expect(transport.updateMeshAgent).toHaveBeenCalledWith('a', { account: 'dorkos-credits' })
    );
  });

  describe('on DorkOS credits (DOR-2636)', () => {
    const CREDITS = {
      id: 'dorkos-credits' as const,
      path: '/Users/dev/.dork/runtimes/claude-code/credits',
      available: true,
      isDefault: false,
      allowedAgents: ['a'],
    };
    /** Claude Code declaring the protocol it speaks to the credits endpoint. */
    function withCredits() {
      const map = capabilityMap(false);
      return {
        ...map,
        capabilities: {
          ...map.capabilities,
          'claude-code': {
            ...map.capabilities['claude-code'],
            credits: { protocol: 'anthropic-messages' },
          },
        },
      };
    }
    const NO_DEFAULT_MODEL: ExecutionDefaults = {
      ...DEFAULTS,
      perRuntime: DEFAULTS.perRuntime.map((row) => ({ ...row, model: null })),
    };
    const CREDIT_MODELS: ModelOption[] = [
      {
        value: 'md_pick',
        displayName: 'Service pick',
        description: '',
        isDefault: true,
        paidFromCredits: true,
      },
      { value: 'md_other', displayName: 'Another', description: '', paidFromCredits: true },
    ];

    it('asks for the models credits serve, and starts on the service’s suggestion', async () => {
      const { transport } = renderRows(
        manifest({ account: 'dorkos-credits' }),
        NO_DEFAULT_MODEL,
        CREDIT_MODELS,
        withCredits() as never,
        { ...TWO_ACCOUNTS, credits: CREDITS }
      );
      await waitFor(() =>
        expect(transport.getModels).toHaveBeenCalledWith({
          sessionId: undefined,
          runtime: 'claude-code',
          account: 'dorkos-credits',
          cwd: undefined,
        })
      );
      expect(await screen.findByTestId('agent-model-row')).toHaveTextContent('Service pick');
      await userEvent.click(screen.getByTestId('agent-model-row'));
      expect(await screen.findByTestId('agent-model-row-inherit')).toHaveTextContent(
        'Use the suggested model: Service pick'
      );
    });
  });

  it('refreshes the manifest it renders, so a picked account does not snap back', async () => {
    // `useUpdateAgent` (mesh) clears `['mesh','agents']` and stops, while this row renders the
    // manifest `useCurrentAgent` holds under `agentKeys.byPath` — and the Settings exceptions
    // strip reads `agentKeys.resolved`.
    const { transport, queryClient } = renderRows(
      manifest(),
      DEFAULTS,
      MODELS,
      capabilityMap(false),
      TWO_ACCOUNTS
    );
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await userEvent.click(await screen.findByTestId('agent-account-row'));
    await userEvent.click(await screen.findByRole('button', { name: /Acme Corp/ }));
    await waitFor(() => expect(transport.updateMeshAgent).toHaveBeenCalled());
    await waitFor(() => {
      const asked = invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey));
      expect(asked).toContain(JSON.stringify(['agents']));
    });
  });

  it('leaves the row showing what is stored when the write is refused', async () => {
    // `onSettled`, not `onSuccess`, and no optimistic write: the row is fully controlled by the
    // manifest, so a re-read is the only thing that ever moves it — and after a REFUSED write it
    // is the only thing that proves it did not.
    const { onUpdate, transport } = renderRows(
      manifest({ account: 'work' }),
      DEFAULTS,
      MODELS,
      capabilityMap(false),
      TWO_ACCOUNTS
    );
    vi.mocked(transport.updateMeshAgent).mockRejectedValueOnce(new Error('Forbidden'));
    await userEvent.click(await screen.findByTestId('agent-account-row'));
    await userEvent.click(await screen.findByTestId('agent-account-row-option-personal'));
    await waitFor(() => expect(transport.updateMeshAgent).toHaveBeenCalled());
    // Still Acme Corp — the row never claimed a change the server rejected.
    expect(screen.getByTestId('agent-account-row')).toHaveTextContent('Acme Corp');
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('restores the server default through the footer, writing the wire null', async () => {
    const { onUpdate, transport } = renderRows(
      manifest({ account: 'work' }),
      DEFAULTS,
      MODELS,
      capabilityMap(false),
      TWO_ACCOUNTS
    );
    await userEvent.click(await screen.findByTestId('agent-account-row'));
    const inherit = await screen.findByTestId('agent-account-row-inherit');
    expect(inherit).toHaveTextContent('Use server default: .claude');
    await userEvent.click(inherit);
    // `null`, not `undefined`: omitting the key would leave the override in
    // place on the manifest. The mesh route turns it back into a deletion.
    await waitFor(() =>
      expect(transport.updateMeshAgent).toHaveBeenCalledWith('a', { account: null })
    );
    expect(onUpdate).not.toHaveBeenCalled();
  });
});

describe('AgentExecutionRows — a registry the server could not read', () => {
  /** An empty list that means "nobody knows", not "nothing is registered". */
  const UNAVAILABLE: ClaudeCodeConfig = {
    resolvedAccount: '/Users/dev/.claude',
    inherited: true,
    accounts: [],
    accountsUnavailable: true,
  };

  it('still shows the stored account, and does not call it broken', async () => {
    renderRows(manifest({ account: 'work' }), DEFAULTS, MODELS, capabilityMap(false), UNAVAILABLE);
    // The value stays visible — it is what a person came to see, and clearing
    // it is still possible — but nothing on screen claims it is wrong.
    expect(await screen.findByTestId('agent-account-row')).toHaveTextContent('work');
    expect(screen.queryByRole('button', { name: /isn’t on this computer/i })).toBeNull();
  });
});
