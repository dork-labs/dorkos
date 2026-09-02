// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ModelOption } from '@dorkos/shared/types';
import type { SystemRequirements } from '@dorkos/shared/agent-runtime';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { RuntimeCard, type RuntimeCardProps } from '../RuntimeCard';

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
  // Radix Select needs DOM APIs jsdom lacks to open its listbox under userEvent.
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

/** Codex's catalog, as its card reasons about it. */
const CODEX_MODELS: ModelOption[] = [
  {
    value: 'gpt-5.5',
    displayName: 'GPT-5.5',
    description: 'Frontier model',
    supportsEffort: true,
  },
  {
    value: 'gpt-5.5-mini',
    displayName: 'GPT-5.5 mini',
    description: 'Small model',
    supportsEffort: false,
  },
];

/** One `perRuntime` entry, spelled out so each test states only what it changes. */
function entry(runtime: string, over: Partial<PerRuntime> = {}): PerRuntime {
  return { runtime, model: null, effort: null, supportsEffort: true, trustStop: null, ...over };
}

type PerRuntime = {
  runtime: string;
  model: string | null;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  supportsEffort: boolean;
  trustStop: 'ask' | 'act' | 'autonomy' | null;
};

/** The `GET /api/config` projection these cards read, with room to override. */
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
 * A registered runtime that declares NO config section — `test-mode`'s real
 * shape, and the case where every row on the card has nowhere to write.
 */
async function sectionlessRuntime() {
  const base = await createMockTransport().getCapabilities();
  const codex = base.capabilities.codex!;
  return {
    ...base,
    capabilities: {
      ...base.capabilities,
      'test-mode': {
        ...codex,
        type: 'test-mode',
        settings: { configSection: null, supportsEffort: true, sections: [] },
      },
    },
  };
}

/**
 * A registered runtime whose capability entry declares no `settings` at all.
 *
 * The resolved twin of a capability map still in flight: both leave the card
 * with no section to write into, and both are the window where a live-looking
 * control would swallow the change somebody made in it.
 */
async function undeclaredSettingsRuntime() {
  const base = await createMockTransport().getCapabilities();
  const codex = { ...base.capabilities.codex! };
  delete (codex as { settings?: unknown }).settings;
  return { ...base, capabilities: { ...base.capabilities, codex } };
}

/** Every runtime ready — the state most of these assertions are about. */
const ALL_READY: SystemRequirements = {
  runtimes: {
    'claude-code': { state: 'ready', dependencies: [] },
    codex: { state: 'ready', dependencies: [] },
    opencode: { state: 'ready', dependencies: [], provider: 'ollama' },
  },
} as unknown as SystemRequirements;

function renderCard(
  props: Partial<RuntimeCardProps> = {},
  transportOverrides: Record<string, unknown> = {}
) {
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue(makeConfig()),
    checkRequirements: vi.fn().mockResolvedValue(ALL_READY),
    getModels: vi.fn().mockResolvedValue(CODEX_MODELS),
    updateConfig: vi.fn().mockResolvedValue(undefined),
    ...transportOverrides,
  });
  // Read back off the built transport, so a test that supplies its own failing
  // `updateConfig` asserts on THAT one rather than the default it replaced.
  const updateConfig = vi.mocked(transport.updateConfig);
  const getModels = vi.mocked(transport.getModels);
  const onChangeTrustStop = vi.fn();
  const onMakeDefault = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <RuntimeCard
          type="codex"
          isDefault={false}
          trustStop={null}
          globalStop="ask"
          onChangeTrustStop={onChangeTrustStop}
          onMakeDefault={onMakeDefault}
          {...props}
        />
      </TransportProvider>
    </QueryClientProvider>
  );
  return { updateConfig, getModels, onChangeTrustStop, onMakeDefault, transport };
}

/** Open the card's body — the click target is its header. */
async function expand(type = 'codex') {
  await userEvent.click(await screen.findByTestId(`runtime-card-toggle-${type}`));
}

/**
 * Pick an effort rung, whichever control the row chose to draw.
 *
 * A model that narrows nothing leaves every rung standing, and the row asks a
 * ladder that long as a menu rather than eight crushed segments — so the test
 * goes through the same test id either way.
 */
async function pickEffort(label: string, type = 'codex') {
  await userEvent.click(await screen.findByTestId(`runtime-effort-${type}`));
  await userEvent.click(await screen.findByRole('option', { name: label }));
}

describe('RuntimeCard — write paths', () => {
  it('writes a model into the section the runtime itself declares', async () => {
    // The capability hole this redesign closes: before it, setting Codex's model
    // meant making Codex the default runtime first.
    const { updateConfig } = renderCard();
    await expand();

    await userEvent.click(await screen.findByTestId('runtime-model-select-codex'));
    await userEvent.click(await screen.findByRole('option', { name: 'GPT-5.5' }));

    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({
        runtimes: { codex: { defaultModel: 'gpt-5.5' } },
      })
    );
  });

  it("writes a null model for Runtime's choice, never the picker's sentinel", async () => {
    const { updateConfig } = renderCard(
      {},
      {
        getConfig: vi.fn().mockResolvedValue(
          makeConfig({
            executionDefaults: {
              runtime: 'claude-code',
              trustStop: null,
              perRuntime: [entry('codex', { model: 'gpt-5.5' })],
            },
          })
        ),
      }
    );
    await expand();

    await userEvent.click(await screen.findByTestId('runtime-model-select-codex'));
    await userEvent.click(await screen.findByRole('option', { name: "Runtime's choice" }));

    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({ runtimes: { codex: { defaultModel: null } } })
    );
  });

  it('writes an effort into that same declared section', async () => {
    const { updateConfig } = renderCard();
    await expand();

    await pickEffort('High');

    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({ runtimes: { codex: { defaultEffort: 'high' } } })
    );
  });

  it('clears an effort stranded on a model that cannot take one', async () => {
    const { updateConfig } = renderCard(
      {},
      {
        getConfig: vi.fn().mockResolvedValue(
          makeConfig({
            executionDefaults: {
              runtime: 'claude-code',
              trustStop: null,
              perRuntime: [entry('codex', { model: 'gpt-5.5-mini', effort: 'high' })],
            },
          })
        ),
      }
    );
    await expand();

    await userEvent.click(await screen.findByTestId('runtime-effort-clear-codex'));

    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({ runtimes: { codex: { defaultEffort: null } } })
    );
  });

  it('offers no rows at all for a runtime that declares no config section, and says why', async () => {
    // `test-mode` is the real one: registered, usable, and with nowhere under
    // `runtimes.*` to keep a setting. Every one of the three rows would report
    // its change into a section that does not exist — model and effort through
    // `writeForRuntime`, the stop through `useTrustStopWrites`, which needs the
    // same declaration — so the card says that in one line instead of drawing
    // controls that look live and are not.
    const { updateConfig } = renderCard(
      { type: 'test-mode' },
      {
        getCapabilities: vi.fn(sectionlessRuntime),
        checkRequirements: vi
          .fn()
          .mockResolvedValue({ runtimes: { 'test-mode': { state: 'ready', dependencies: [] } } }),
      }
    );
    await expand('test-mode');

    expect(await screen.findByTestId('runtime-card-no-settings-test-mode')).toHaveTextContent(
      'keeps no settings of its own'
    );
    expect(screen.queryByTestId('runtime-model-select-test-mode')).not.toBeInTheDocument();
    // Whichever control the effort row would have drawn, and whether or not it
    // would have called itself unsupported.
    expect(screen.queryByTestId(/^runtime-effort-/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('runtime-trust-test-mode')).not.toBeInTheDocument();
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('keeps the three rows while the runtime has not yet said whether it stores anything', async () => {
    // A declaration in flight is not a declaration of `null`. A card that said
    // "keeps no settings of its own" for the length of one round-trip would be
    // lying, exactly as an effort row calling effort unsupported would be.
    renderCard({}, { getCapabilities: vi.fn(() => new Promise(() => {})) });
    await expand();

    expect(await screen.findByTestId('runtime-model-select-codex')).toBeInTheDocument();
    expect(screen.queryByTestId('runtime-card-no-settings-codex')).not.toBeInTheDocument();
  });

  it('freezes the three rows while the runtime has not said where its settings live', async () => {
    // The rows stay (a declaration in flight is not a declaration of `null`),
    // but nothing on them is live: every write in this window resolves to no
    // section and does nothing, so a control that accepted a change would take
    // it and drop it.
    const { updateConfig, onChangeTrustStop } = renderCard(
      {},
      { getCapabilities: vi.fn(undeclaredSettingsRuntime) }
    );
    await expand();

    expect(await screen.findByTestId('runtime-model-select-codex')).toBeDisabled();
    expect(screen.getByTestId('runtime-effort-codex')).toBeDisabled();
    const stop = screen.getByRole('radio', { name: 'Pauses at big steps' });
    expect(stop).toBeDisabled();

    await userEvent.click(screen.getByTestId('runtime-model-select-codex'));
    await userEvent.click(screen.getByTestId('runtime-effort-codex'));
    await userEvent.click(stop);
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    expect(updateConfig).not.toHaveBeenCalled();
    expect(onChangeTrustStop).not.toHaveBeenCalled();
  });

  it('freezes them the same way while the capability map is still in flight', async () => {
    renderCard({}, { getCapabilities: vi.fn(() => new Promise(() => {})) });
    await expand();

    expect(await screen.findByTestId('runtime-model-select-codex')).toBeDisabled();
    expect(screen.getByTestId('runtime-effort-codex')).toBeDisabled();
  });

  it('hands the rows back the moment the declaration lands', async () => {
    renderCard();
    await expand();

    expect(await screen.findByTestId('runtime-model-select-codex')).toBeEnabled();
    expect(screen.getByTestId('runtime-effort-codex')).toBeEnabled();
    expect(screen.getByRole('radio', { name: 'Pauses at big steps' })).toBeEnabled();
  });

  it('renders a half-loaded capability map without sections and without throwing', async () => {
    // Nobody has answered what this runtime declares yet. Optional all the way
    // down: a card, no bespoke sections, and no crash.
    renderCard({}, { getCapabilities: vi.fn(() => new Promise(() => {})) });
    expect(await screen.findByTestId('runtime-card-codex')).toBeInTheDocument();
    expect(screen.queryByTestId(/^runtime-card-section-/)).not.toBeInTheDocument();
  });

  it('hands Make default up rather than writing it, so one writer owns the default', async () => {
    const { updateConfig, onMakeDefault } = renderCard();
    await userEvent.click(await screen.findByTestId('runtime-make-default-codex'));
    expect(onMakeDefault).toHaveBeenCalledOnce();
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('hands a trust change up too, and never writes the stop itself', async () => {
    const { updateConfig, onChangeTrustStop } = renderCard();
    await expand();
    await userEvent.click(await screen.findByRole('radio', { name: 'Pauses at big steps' }));
    expect(onChangeTrustStop).toHaveBeenCalledWith('act');
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('says nothing about timing until a write has actually landed', async () => {
    renderCard();
    await expand();
    expect(screen.queryByTestId('runtime-card-timing-codex')).not.toBeInTheDocument();

    await pickEffort('High');

    expect(await screen.findByTestId('runtime-card-timing-codex')).toHaveTextContent(
      'Applies to new conversations'
    );
  });

  it("shows a refused write in the server's own words", async () => {
    const { updateConfig } = renderCard(
      {},
      {
        updateConfig: vi
          .fn()
          .mockRejectedValue(new Error('Only a person can change those settings')),
      }
    );
    await expand();
    await pickEffort('High');

    await waitFor(() => expect(updateConfig).toHaveBeenCalled());
    expect(await screen.findByTestId('runtime-card-error-codex')).toHaveTextContent(
      'Only a person can change those settings'
    );
  });
});

describe('RuntimeCard — the sign-in expiry warning', () => {
  /**
   * Requirements whose auth check reports a deadline `daysOut` days away.
   *
   * A minute of slack past the day boundary keeps the countdown off the edge:
   * exactly 48h would round down to "1 day" the moment a millisecond passed
   * between building this and reading it.
   */
  function requirementsExpiringIn(daysOut: number) {
    const expiresAt = new Date(Date.now() + daysOut * 86_400_000 + 60_000).toISOString();
    return {
      runtimes: {
        'claude-code': {
          state: 'ready',
          dependencies: [
            { name: 'Claude Code CLI', description: 'Powers agent sessions.', status: 'satisfied' },
            {
              name: 'Claude Code authentication',
              description: 'Signed in to Claude.',
              status: 'satisfied',
              expiresAt,
            },
          ],
        },
      },
    };
  }

  it('warns on the card when the server reports a sign-in close to running out', async () => {
    // The seam, end to end through the real container: what the transport
    // returns reaches the banner. The view and the selector are each tested
    // alone; only this asserts they are actually wired to each other.
    renderCard(
      { type: 'claude-code' },
      { checkRequirements: vi.fn().mockResolvedValue(requirementsExpiringIn(2)) }
    );

    expect(await screen.findByTestId('runtime-sign-in-expiring-claude-code')).toHaveTextContent(
      'Your Claude Code sign-in runs out in 2 days. Sign in again before your agents stall.'
    );
  });

  it('stays silent when the deadline is further out than the warning window', async () => {
    // A sign-in lasts weeks, so this is the ordinary state. A card that warned
    // here would carry the line for most of a sign-in's life and be ignored.
    renderCard(
      { type: 'claude-code' },
      { checkRequirements: vi.fn().mockResolvedValue(requirementsExpiringIn(19)) }
    );

    expect(await screen.findByTestId('runtime-card-claude-code')).toBeInTheDocument();
    expect(screen.queryByTestId('runtime-sign-in-expiring-claude-code')).not.toBeInTheDocument();
  });
});

describe('RuntimeCard — the summary line', () => {
  it('names a configured model from the catalog once it has arrived', async () => {
    renderCard(
      {},
      {
        getConfig: vi.fn().mockResolvedValue(
          makeConfig({
            executionDefaults: {
              runtime: 'claude-code',
              trustStop: null,
              perRuntime: [entry('codex', { model: 'gpt-5.5', effort: 'high' })],
            },
          })
        ),
      }
    );

    const summary = await screen.findByTestId('runtime-card-summary-codex');
    await waitFor(() => expect(summary).toHaveTextContent('GPT-5.5'));
    expect(summary).toHaveTextContent('High effort');
    // The effective stop, marked as the global one until this card overrides it.
    expect(summary).toHaveTextContent('Asks first');
  });

  it('falls back to the raw model id while no catalog can name it', async () => {
    renderCard(
      {},
      {
        getConfig: vi.fn().mockResolvedValue(
          makeConfig({
            executionDefaults: {
              runtime: 'claude-code',
              trustStop: null,
              perRuntime: [entry('codex', { model: 'gpt-4.1-retired' })],
            },
          })
        ),
        getModels: vi.fn().mockResolvedValue([]),
      }
    );

    const summary = await screen.findByTestId('runtime-card-summary-codex');
    await waitFor(() => expect(summary).toHaveTextContent('gpt-4.1-retired'));
  });

  it('leaves a stranded effort out of the line, and names it in the opened row', async () => {
    // One card, two voices: the collapsed line used to promise "High effort"
    // while the row a click away said the model takes none and offered to clear
    // it. The catalog answers that question once, and both read the answer.
    renderCard(
      {},
      {
        getConfig: vi.fn().mockResolvedValue(
          makeConfig({
            executionDefaults: {
              runtime: 'claude-code',
              trustStop: null,
              perRuntime: [entry('codex', { model: 'gpt-5.5-mini', effort: 'high' })],
            },
          })
        ),
      }
    );

    const summary = await screen.findByTestId('runtime-card-summary-codex');
    // The catalog has landed by the time it can name the model — which is also
    // when it knows the model takes no effort.
    await waitFor(() => expect(summary).toHaveTextContent('GPT-5.5 mini'));
    expect(summary).not.toHaveTextContent('High effort');

    await expand();
    expect(await screen.findByTestId('runtime-effort-clear-codex')).toHaveTextContent(
      'does nothing'
    );
  });

  it("names this runtime's own stop as its own once it overrides the global one", async () => {
    renderCard({ trustStop: 'autonomy', globalStop: 'ask' });
    const summary = await screen.findByTestId('runtime-card-summary-codex');
    expect(summary).toHaveTextContent('Full autonomy');
  });
});

describe('RuntimeCard — the model catalog is fetched late', () => {
  it('fetches nothing for a collapsed card with no model to name', async () => {
    const { getModels } = renderCard();
    await screen.findByTestId('runtime-card-codex');
    // Give any enabled query a turn to fire before claiming it did not.
    await waitFor(() => expect(screen.getByTestId('runtime-card-summary-codex')));
    expect(getModels).not.toHaveBeenCalled();
  });

  it('fetches exactly one catalog when the card is opened', async () => {
    const { getModels } = renderCard();
    await expand();
    await waitFor(() => expect(getModels).toHaveBeenCalledTimes(1));
    expect(getModels).toHaveBeenCalledWith({ sessionId: undefined, runtime: 'codex' });
  });

  it('fetches for a COLLAPSED card that has a model to name', async () => {
    const { getModels } = renderCard(
      {},
      {
        getConfig: vi.fn().mockResolvedValue(
          makeConfig({
            executionDefaults: {
              runtime: 'claude-code',
              trustStop: null,
              perRuntime: [entry('codex', { model: 'gpt-5.5' })],
            },
          })
        ),
      }
    );
    await waitFor(() => expect(getModels).toHaveBeenCalledTimes(1));
  });

  it('fetches nothing for a runtime that cannot start a conversation yet', async () => {
    const { getModels } = renderCard(
      {},
      {
        checkRequirements: vi.fn().mockResolvedValue({
          runtimes: {
            codex: {
              state: 'connect',
              connect: { kind: 'login', label: 'Connect Codex' },
              dependencies: [],
            },
          },
        }),
      }
    );
    await screen.findByTestId('runtime-card-locked-codex');
    expect(getModels).not.toHaveBeenCalled();
  });
});

describe('RuntimeCard — connecting and reconnecting', () => {
  const NOT_READY = {
    runtimes: {
      codex: {
        state: 'connect',
        connect: { kind: 'login', label: 'Connect Codex' },
        dependencies: [
          {
            name: 'Codex CLI',
            description: 'The Codex CLI powers Codex sessions.',
            status: 'satisfied',
            version: '1.0.0',
          },
          {
            name: 'Codex authentication',
            description: 'Signed in to Codex.',
            status: 'missing',
            installHint: 'codex login',
          },
        ],
      },
    },
  };

  it('offers the connect flow, and one true sentence instead of a summary', async () => {
    renderCard({}, { checkRequirements: vi.fn().mockResolvedValue(NOT_READY) });

    expect(await screen.findByTestId('runtime-card-locked-codex')).toHaveTextContent(
      'One sign-in away'
    );
    expect(await screen.findByTestId('runtime-card-connect-codex')).toBeInTheDocument();
    expect(screen.queryByTestId('runtime-card-summary-codex')).not.toBeInTheDocument();
  });

  it('keeps the broken default visible instead of hiding either half', async () => {
    renderCard({ isDefault: true }, { checkRequirements: vi.fn().mockResolvedValue(NOT_READY) });

    expect(await screen.findByTestId('runtime-default-broken-codex')).toHaveTextContent(
      'New conversations can’t start here'
    );
    expect(screen.getByTestId('runtime-default-pill-codex')).toBeInTheDocument();
    expect(await screen.findByTestId('runtime-card-connect-codex')).toBeInTheDocument();
  });

  it('offers a one-click install where that is what connecting means', async () => {
    renderCard(
      {},
      {
        checkRequirements: vi.fn().mockResolvedValue({
          runtimes: {
            codex: {
              state: 'connect',
              connect: { kind: 'install', label: 'Install Codex' },
              dependencies: [
                {
                  name: 'Codex CLI',
                  description: 'The Codex CLI powers Codex sessions.',
                  status: 'missing',
                  installHint: 'npm i -g @openai/codex',
                },
              ],
            },
          },
        }),
      }
    );

    expect(await screen.findByRole('button', { name: 'Install Codex' })).toBeInTheDocument();
    // The transparency note, whose disclosure names the exact command that runs.
    expect(screen.getByRole('button', { name: 'What runs?' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'What runs?' }));
    expect(await screen.findByText('npm i -g @openai/codex')).toBeInTheDocument();
  });

  it('reopens a ready runtime’s sign-in, and takes back nothing when cancelled', async () => {
    renderCard();

    await userEvent.click(await screen.findByTestId('runtime-reconnect-codex'));
    const panel = await screen.findByTestId('runtime-reconnect-panel-codex');
    expect(panel).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('runtime-reconnect-cancel-codex'));
    expect(screen.queryByTestId('runtime-reconnect-panel-codex')).not.toBeInTheDocument();
  });

  it("calls OpenCode's reopened flow a change of source, not a sign-in", async () => {
    renderCard({ type: 'opencode' });

    await userEvent.click(await screen.findByTestId('runtime-change-opencode'));
    expect(await screen.findByTestId('runtime-change-panel-opencode')).toBeInTheDocument();
    expect(screen.getByTestId('runtime-change-cancel-opencode')).toHaveTextContent(
      'Keep current source'
    );
  });
});

describe('RuntimeCard — declared sections', () => {
  it('renders the section a runtime declares, and only that one', async () => {
    renderCard({ type: 'opencode' });
    await expand('opencode');

    expect(
      await screen.findByTestId('runtime-card-section-opencode-power-source-opencode')
    ).toBeInTheDocument();
    expect(screen.queryByTestId('runtime-card-section-claude-accounts-opencode')).toBeNull();
  });

  it("names the power source in the collapsed card's summary", async () => {
    renderCard({ type: 'opencode' });
    const summary = await screen.findByTestId('runtime-card-summary-opencode');
    await waitFor(() => expect(summary).toHaveTextContent('On your computer (Ollama)'));
  });

  it('renders the accounts section on the Claude card and names the account it bills', async () => {
    renderCard(
      { type: 'claude-code' },
      {
        getConfig: vi.fn().mockResolvedValue(
          makeConfig({
            claudeCode: {
              resolvedAccount: '/Users/dev/.claude2',
              inherited: false,
              accounts: [{ path: '/Users/dev/.claude2', label: 'Acme Corp', isAccountRoot: true }],
            },
          })
        ),
      }
    );

    const summary = await screen.findByTestId('runtime-card-summary-claude-code');
    await waitFor(() => expect(summary).toHaveTextContent('billing Acme Corp'));

    await expand('claude-code');
    expect(
      await screen.findByTestId('runtime-card-section-claude-accounts-claude-code')
    ).toBeInTheDocument();
  });

  it('says nothing about billing while the account is the inherited default', async () => {
    renderCard(
      { type: 'claude-code' },
      {
        getConfig: vi.fn().mockResolvedValue(
          makeConfig({
            claudeCode: {
              resolvedAccount: '/Users/dev/.claude',
              inherited: true,
              accounts: [],
            },
          })
        ),
      }
    );

    const summary = await screen.findByTestId('runtime-card-summary-claude-code');
    await waitFor(() => expect(summary).toHaveTextContent("Runtime's choice"));
    expect(summary).not.toHaveTextContent('billing');
  });
});
