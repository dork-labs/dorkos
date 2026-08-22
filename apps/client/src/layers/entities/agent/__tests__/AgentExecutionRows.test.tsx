// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { ExecutionDefaults } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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

const MODELS = [
  { value: 'opus', displayName: 'Opus', description: '', supportsEffort: true, trustStop: null },
  {
    value: 'sonnet',
    displayName: 'Sonnet',
    description: '',
    supportsEffort: true,
    trustStop: null,
  },
  { value: 'haiku', displayName: 'Haiku', description: '', supportsEffort: false, trustStop: null },
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
  models: typeof MODELS = MODELS,
  capabilities: ReturnType<typeof capabilityMap> | typeof WITHHELD = capabilityMap(false),
  claudeCode: ClaudeCodeConfig | undefined = undefined
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
    getModels: vi.fn().mockResolvedValue(models),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <AgentExecutionRows agent={agent} onUpdate={onUpdate} />
      </TransportProvider>
    </QueryClientProvider>
  );
  return { onUpdate };
}

describe('AgentExecutionRows', () => {
  it('wears the server default when the agent has no opinion', async () => {
    renderRows(manifest());
    await waitFor(() =>
      expect(screen.getByTestId('agent-model-row-chip')).toHaveTextContent('server default · opus')
    );
    expect(screen.getByTestId('agent-model-row')).toHaveTextContent('Opus');
    expect(screen.getByTestId('agent-effort-row-chip')).toHaveTextContent(
      'server default · Medium'
    );
  });

  it('says "set here" when the agent names its own', async () => {
    renderRows(manifest({ model: 'sonnet', effort: 'high' }));
    await waitFor(() =>
      expect(screen.getByTestId('agent-model-row-chip')).toHaveTextContent('set here')
    );
    expect(screen.getByTestId('agent-effort-row-chip')).toHaveTextContent('set here');
  });

  // The design's whole point: the chip IS the reset, and its one action clears
  // the field back to inheriting — which on the wire is `null`, not `undefined`.
  it('offers exactly one action from a "set here" chip, and it clears the field', async () => {
    const { onUpdate } = renderRows(manifest({ model: 'sonnet' }));
    await waitFor(() =>
      expect(screen.getByTestId('agent-model-row-chip')).toHaveTextContent('set here')
    );
    await userEvent.click(screen.getByRole('button', { name: /set here/i }));
    const reset = await screen.findByTestId('agent-model-row-chip-reset');
    expect(reset).toHaveTextContent('Use server default');
    expect(reset).toHaveTextContent('currently opus');
    await userEvent.click(reset);
    expect(onUpdate).toHaveBeenCalledWith({ model: null });
  });

  it('does not offer a reset on an inherited chip — there is nothing to undo', async () => {
    renderRows(manifest());
    await waitFor(() =>
      expect(screen.getByTestId('agent-model-row-chip')).toHaveTextContent('server default')
    );
    expect(screen.queryByRole('button', { name: /set here/i })).toBeNull();
  });

  it('picks a model through the row, and writes it', async () => {
    const { onUpdate } = renderRows(manifest());
    await waitFor(() => expect(screen.getByTestId('agent-model-row')).toHaveTextContent('Opus'));
    await userEvent.click(screen.getByTestId('agent-model-row'));
    await userEvent.click(await screen.findByRole('button', { name: 'Sonnet' }));
    expect(onUpdate).toHaveBeenCalledWith({ model: 'sonnet' });
  });

  it('says effort is not supported by the runtime rather than dropping the row', async () => {
    renderRows(manifest({ runtime: 'opencode' }));
    expect(await screen.findByTestId('agent-effort-unsupported-runtime')).toHaveTextContent(
      'Not supported by OpenCode'
    );
    expect(screen.queryByTestId('agent-effort-row')).toBeNull();
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

  it('says a model does not take an effort, in the model’s own words', async () => {
    renderRows(manifest({ model: 'haiku' }));
    expect(await screen.findByTestId('agent-effort-unsupported-model')).toHaveTextContent(
      "This model doesn't take an effort setting"
    );
  });

  // ── B1: a warming catalog is not evidence that a model is gone ─────────────
  it('does not call a pinned model gone while the catalog is still empty', async () => {
    renderRows(manifest({ model: 'sonnet' }), DEFAULTS, []);
    // Wait for the EFFORT chip's server default, which only appears once config
    // has arrived, then let the catalog query settle too — an empty catalog
    // changes nothing on screen, so there is no positive thing to wait for, and
    // asserting before it lands would pass no matter what the rule says.
    await waitFor(() =>
      expect(screen.getByTestId('agent-effort-row-chip')).toHaveTextContent('server default')
    );
    await waitFor(() =>
      expect(screen.getByTestId('agent-model-row-chip')).toHaveTextContent('set here')
    );
    await new Promise((r) => setTimeout(r, 50));
    // The row falls back to the raw id and says nothing about availability. The
    // chip's accessible name is the assertion that discriminates: a warning is
    // appended to it (`Set here — …`), so an exact "Set here" is proof there
    // isn't one.
    expect(screen.getByTestId('agent-model-row')).toHaveTextContent('sonnet');
    expect(screen.getByRole('button', { name: 'Set here' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /no longer offers/i })).toBeNull();
  });

  // ── B2: the optimistic `null` an in-flight reset writes must read as inherit ─
  it('treats a null field as inheriting, not as a value set here', async () => {
    // `AgentManifest` types these as `string | undefined`, so a `null` here is a
    // deliberate lie about the type — and that is the point: the type says this
    // cannot happen while the optimistic merge made it happen anyway, which is
    // why nothing caught the bug at compile time.
    renderRows(manifest({ model: null, effort: null } as unknown as Partial<AgentManifest>));
    await waitFor(() =>
      expect(screen.getByTestId('agent-model-row-chip')).toHaveTextContent('server default · opus')
    );
    expect(screen.getByTestId('agent-model-row-chip')).not.toHaveTextContent('set here');
    expect(screen.getByTestId('agent-effort-row-chip')).toHaveTextContent(
      'server default · Medium'
    );
    expect(screen.queryByRole('button', { name: /no longer offers null/i })).toBeNull();
  });

  // ── B2: a picker that stays open hides the row it just changed ─────────────
  it('closes the picker once a model is chosen', async () => {
    renderRows(manifest());
    await waitFor(() => expect(screen.getByTestId('agent-model-row')).toHaveTextContent('Opus'));
    await userEvent.click(screen.getByTestId('agent-model-row'));
    await userEvent.click(await screen.findByRole('button', { name: 'Sonnet' }));
    await waitFor(() => expect(screen.queryByTestId('agent-model-row-inherit')).toBeNull());
  });

  it('closes the picker when the inherit line is used', async () => {
    const { onUpdate } = renderRows(manifest({ model: 'sonnet' }));
    await userEvent.click(await screen.findByTestId('agent-model-row'));
    await userEvent.click(await screen.findByTestId('agent-model-row-inherit'));
    expect(onUpdate).toHaveBeenCalledWith({ model: null });
    await waitFor(() => expect(screen.queryByTestId('agent-model-row-inherit')).toBeNull());
  });

  it('closes the chip’s reset popover once the reset is taken', async () => {
    renderRows(manifest({ model: 'sonnet' }));
    await userEvent.click(await screen.findByRole('button', { name: /set here/i }));
    await userEvent.click(await screen.findByTestId('agent-model-row-chip-reset'));
    await waitFor(() => expect(screen.queryByTestId('agent-model-row-chip-reset')).toBeNull());
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

  // ── The runtime's own declaration is the source, not a list in the client ──
  // The defaults carry no `opencode` row here, so the only thing left that can
  // say OpenCode takes no effort is the capability map.
  const NO_OPENCODE_ROW: ExecutionDefaults = {
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
    ],
  };

  it('reads the runtime-level unsupported state off the capability map', async () => {
    renderRows(manifest({ runtime: 'opencode' }), NO_OPENCODE_ROW, MODELS, capabilityMap(false));
    expect(await screen.findByTestId('agent-effort-unsupported-runtime')).toHaveTextContent(
      'Not supported by OpenCode'
    );
    expect(screen.queryByTestId('agent-effort-row')).toBeNull();
  });

  // The discriminator: flip only the declaration and the control comes back.
  it('offers the effort control when the same runtime declares it takes one', async () => {
    renderRows(manifest({ runtime: 'opencode' }), NO_OPENCODE_ROW, MODELS, capabilityMap(true));
    expect(await screen.findByTestId('agent-effort-row')).toBeInTheDocument();
    expect(screen.queryByTestId('agent-effort-unsupported-runtime')).toBeNull();
  });

  // The third state, between those two: nothing has answered yet. An editable
  // control here would be offered and then taken away a round-trip later.
  it('offers no effort control while the declaration is still in flight', async () => {
    renderRows(manifest({ runtime: 'opencode' }), NO_OPENCODE_ROW, MODELS, WITHHELD);
    expect(await screen.findByTestId('agent-effort-pending')).toHaveTextContent(
      'Checking what OpenCode supports'
    );
    expect(screen.queryByTestId('agent-effort-row')).toBeNull();
    // Nor does it guess the other way: "Not supported" is a claim, and nothing
    // has said it.
    expect(screen.queryByTestId('agent-effort-unsupported-runtime')).toBeNull();
  });
});

describe('AgentExecutionRows — the Account row', () => {
  /** One registered account: a registry with nothing to choose between. */
  const ONE_ACCOUNT: ClaudeCodeConfig = {
    ...TWO_ACCOUNTS,
    accounts: [TWO_ACCOUNTS.accounts[0]!],
  };

  it('is absent on a runtime that has no such thing as an account', async () => {
    renderRows(manifest({ runtime: 'opencode' }), DEFAULTS, MODELS, capabilityMap(true), {
      ...TWO_ACCOUNTS,
    });
    // Wait for something the same config DOES draw, so the absence below is a
    // rendered absence rather than a not-yet.
    await waitFor(() =>
      expect(screen.getByTestId('agent-model-row-chip')).toHaveTextContent('server default')
    );
    expect(screen.queryByTestId('agent-account-row')).toBeNull();
  });

  it('is absent when this machine knows only one account — there is nothing to pick', async () => {
    renderRows(manifest(), DEFAULTS, MODELS, capabilityMap(false), ONE_ACCOUNT);
    await waitFor(() =>
      expect(screen.getByTestId('agent-model-row-chip')).toHaveTextContent('server default')
    );
    expect(screen.queryByTestId('agent-account-row')).toBeNull();
  });

  it('comes back for an agent that HAS an account set, however small the registry', async () => {
    // The one agent whose setting must stay visible: hiding it would make it
    // unclearable.
    renderRows(
      manifest({ account: 'personal' }),
      DEFAULTS,
      MODELS,
      capabilityMap(false),
      ONE_ACCOUNT
    );
    expect(await screen.findByTestId('agent-account-row')).toBeInTheDocument();
  });

  it('is absent until the config answers, rather than offering an empty picker', async () => {
    renderRows(manifest());
    await waitFor(() =>
      expect(screen.getByTestId('agent-model-row-chip')).toHaveTextContent('server default')
    );
    expect(screen.queryByTestId('agent-account-row')).toBeNull();
  });

  it('wears the resolved server default when the agent has no opinion', async () => {
    renderRows(manifest(), DEFAULTS, MODELS, capabilityMap(false), TWO_ACCOUNTS);
    expect(await screen.findByTestId('agent-account-row-chip')).toHaveTextContent(
      'server default · .claude'
    );
    expect(screen.getByTestId('agent-account-row')).toHaveTextContent('.claude');
  });

  it('says "set here" and names the account by its label, not its id', async () => {
    renderRows(manifest({ account: 'work' }), DEFAULTS, MODELS, capabilityMap(false), TWO_ACCOUNTS);
    expect(await screen.findByTestId('agent-account-row-chip')).toHaveTextContent('set here');
    expect(screen.getByTestId('agent-account-row')).toHaveTextContent('Acme Corp');
  });

  it('writes the registry id when an account is picked', async () => {
    const { onUpdate } = renderRows(
      manifest(),
      DEFAULTS,
      MODELS,
      capabilityMap(false),
      TWO_ACCOUNTS
    );
    await userEvent.click(await screen.findByTestId('agent-account-row'));
    await userEvent.click(await screen.findByRole('button', { name: /Acme Corp/ }));
    expect(onUpdate).toHaveBeenCalledWith({ account: 'work' });
  });

  it('restores the server default through the footer, writing the wire null', async () => {
    const { onUpdate } = renderRows(
      manifest({ account: 'work' }),
      DEFAULTS,
      MODELS,
      capabilityMap(false),
      TWO_ACCOUNTS
    );
    await userEvent.click(await screen.findByTestId('agent-account-row'));
    const inherit = await screen.findByTestId('agent-account-row-inherit');
    expect(inherit).toHaveTextContent('Using server default: .claude — tap to restore');
    await userEvent.click(inherit);
    // `null`, not `undefined`: omitting the key would leave the override in
    // place on the manifest.
    expect(onUpdate).toHaveBeenCalledWith({ account: null });
  });

  it('never offers a synthesized root as a choice — nothing can point at it', async () => {
    renderRows(manifest(), DEFAULTS, MODELS, capabilityMap(false), {
      resolvedAccount: '/Users/dev/.claude',
      inherited: true,
      accounts: [
        // The inherited root the operator never registered: display-only,
        // carrying no id (ADR 260821-205324).
        { id: null, path: '/Users/dev/.claude', label: null, isAccountRoot: true },
        { id: 'work', path: '/Users/dev/.claude-work', label: 'Acme Corp', isAccountRoot: true },
      ],
    });
    await userEvent.click(await screen.findByTestId('agent-account-row'));
    await screen.findByTestId('agent-account-row-option-work');
    // The registered account is the ONLY option; the only way back to the
    // unregistered root is the inherit footer below them.
    expect(screen.queryAllByTestId(/^agent-account-row-option-/)).toHaveLength(1);
  });

  it('turns amber for an id nobody registered, and still says which id', async () => {
    renderRows(
      manifest({ account: 'retired-client' }),
      DEFAULTS,
      MODELS,
      capabilityMap(false),
      TWO_ACCOUNTS
    );
    const chip = await screen.findByTestId('agent-account-row-chip');
    expect(chip).toHaveTextContent('set here');
    // The warning is appended to the chip's accessible name, so it is never
    // only a color.
    expect(screen.getByRole('button', { name: /no longer registered/i })).toBeInTheDocument();
    expect(screen.getByTestId('agent-account-row')).toHaveTextContent('retired-client');
  });

  it('reads the optimistic wire null as inheriting, not as an account named null', async () => {
    renderRows(
      manifest({ account: null } as unknown as Partial<AgentManifest>),
      DEFAULTS,
      MODELS,
      capabilityMap(false),
      TWO_ACCOUNTS
    );
    await waitFor(() =>
      expect(screen.getByTestId('agent-account-row-chip')).toHaveTextContent('server default')
    );
    expect(screen.queryByRole('button', { name: /no longer registered/i })).toBeNull();
  });
});
