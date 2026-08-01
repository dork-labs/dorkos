// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ExecutionDefaults } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { ExecutionDefaultsCard } from '../ui/execution-defaults/ExecutionDefaultsCard';

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

const DEFAULTS: ExecutionDefaults = {
  runtime: 'claude-code',
  trustStop: null,
  perRuntime: [
    {
      runtime: 'claude-code',
      model: 'claude-opus-4-6',
      effort: 'high',
      supportsEffort: true,
      trustStop: null,
    },
    { runtime: 'codex', model: null, effort: null, supportsEffort: true, trustStop: null },
    { runtime: 'opencode', model: null, effort: null, supportsEffort: false, trustStop: null },
  ],
};

/**
 * The catalog the card actually reasons about. Spelled out rather than left to
 * the shared mock's default, whose entries carry no `supportsEffort` at all —
 * and absence means "no" here, exactly as it does in the status-bar picker and
 * an agent's Config rows.
 */
const MODELS = [
  {
    value: 'claude-sonnet-4-5-20250929',
    displayName: 'Sonnet 4.5',
    description: 'Fast model',
    supportsEffort: true,
  },
  {
    value: 'claude-opus-4-6',
    displayName: 'Opus 4.6',
    description: 'Capable model',
    supportsEffort: true,
  },
  {
    value: 'haiku',
    displayName: 'Haiku',
    description: 'Small model',
    supportsEffort: false,
    trustStop: null,
  },
];

function renderCard(
  executionDefaults: ExecutionDefaults = DEFAULTS,
  models = MODELS,
  ui?: { autonomyAcknowledgedAt: string | null }
) {
  const updateConfig = vi.fn().mockResolvedValue(undefined);
  const transport = createMockTransport({
    getModels: vi.fn().mockResolvedValue(models),
    getConfig: vi.fn().mockResolvedValue({
      version: '1.0.0',
      port: 4242,
      uptime: 0,
      workingDirectory: '/test',
      nodeVersion: 'v20.0.0',
      platform: 'linux-x64',
      runtimes: ['claude-code'],
      claudeCliPath: null,
      executionDefaults,
      ...(ui ? { ui } : {}),
      tunnel: {
        enabled: false,
        connected: false,
        url: null,
        authEnabled: false,
        tokenConfigured: false,
      },
    }),
    updateConfig,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <ExecutionDefaultsCard />
      </TransportProvider>
    </QueryClientProvider>
  );
  return { updateConfig };
}

describe('ExecutionDefaultsCard', () => {
  it('shows the model and effort already set for the default runtime', async () => {
    renderCard();
    await waitFor(() =>
      expect(screen.getByTestId('default-model-select')).toHaveTextContent('Opus 4.6')
    );
    expect(screen.getByTestId('default-runtime-select')).toHaveTextContent('Claude Code');
    expect(screen.getByTestId('default-effort-select')).toHaveTextContent('High');
  });

  it('says nothing about timing until something has actually changed', async () => {
    const { updateConfig } = renderCard();
    await waitFor(() =>
      expect(screen.getByTestId('default-model-select')).toHaveTextContent('Opus 4.6')
    );
    expect(screen.queryByTestId('execution-defaults-timing')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('default-effort-select'));
    await userEvent.click(await screen.findByRole('option', { name: 'Low' }));

    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({
        runtimes: { claudeCode: { defaultEffort: 'low' } },
      })
    );
    expect(await screen.findByTestId('execution-defaults-timing')).toHaveTextContent(
      'Applies to new conversations'
    );
  });

  it('writes the model into the section of the runtime it belongs to', async () => {
    const { updateConfig } = renderCard({ ...DEFAULTS, runtime: 'codex' });
    await waitFor(() =>
      expect(screen.getByTestId('default-runtime-select')).toHaveTextContent('Codex')
    );
    await userEvent.click(screen.getByTestId('default-model-select'));
    await userEvent.click(await screen.findByRole('option', { name: 'Opus 4.6' }));
    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({
        runtimes: { codex: { defaultModel: 'claude-opus-4-6' } },
      })
    );
  });

  it('says effort is unsupported rather than hiding the row', async () => {
    renderCard({ ...DEFAULTS, runtime: 'opencode' });
    expect(await screen.findByTestId('default-effort-unsupported')).toHaveTextContent(
      'Not supported by OpenCode'
    );
    expect(screen.queryByTestId('default-effort-select')).not.toBeInTheDocument();
  });

  // ── I5: effort is a per-MODEL capability, and this card sets both ──────────
  it('will not let the default model be paired with an effort it cannot take', async () => {
    renderCard({
      ...DEFAULTS,
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
    // The runtime supports effort; the model chosen above does not. Said, not
    // hidden — and the select that would have offered High is gone.
    expect(await screen.findByTestId('default-effort-model-unsupported')).toHaveTextContent(
      "Haiku doesn't take an effort setting"
    );
    expect(screen.queryByTestId('default-effort-select')).not.toBeInTheDocument();
  });

  it('lets an effort already saved against such a model be cleared', async () => {
    const { updateConfig } = renderCard({
      ...DEFAULTS,
      perRuntime: [
        {
          runtime: 'claude-code',
          model: 'haiku',
          effort: 'high',
          supportsEffort: true,
          trustStop: null,
        },
      ],
    });
    const clear = await screen.findByTestId('default-effort-clear');
    expect(clear).toHaveTextContent('High is saved here and does nothing');
    await userEvent.click(clear);
    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({
        runtimes: { claudeCode: { defaultEffort: null } },
      })
    );
  });

  it('offers only the rungs the default model actually accepts', async () => {
    renderCard(
      {
        ...DEFAULTS,
        perRuntime: [
          {
            runtime: 'claude-code',
            model: 'claude-opus-4-6',
            effort: null,
            supportsEffort: true,
            trustStop: null,
          },
        ],
      },
      [
        {
          value: 'claude-opus-4-6',
          displayName: 'Opus 4.6',
          description: 'Capable model',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high'],
        } as (typeof MODELS)[number],
      ]
    );
    await userEvent.click(await screen.findByTestId('default-effort-select'));
    expect(await screen.findByRole('option', { name: 'High' })).toBeInTheDocument();
    // `max` and `xhigh` are Anthropic/OpenAI rungs this model does not take.
    expect(screen.queryByRole('option', { name: 'Extra high' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Max' })).not.toBeInTheDocument();
  });

  it('keeps a model that is no longer offered selectable rather than showing a blank', async () => {
    renderCard({
      ...DEFAULTS,
      perRuntime: [
        {
          runtime: 'claude-code',
          model: 'opus-3',
          effort: null,
          supportsEffort: true,
          trustStop: null,
        },
      ],
    });
    await waitFor(() =>
      expect(screen.getByTestId('default-model-select')).toHaveTextContent('no longer offered')
    );
  });
});

describe('ExecutionDefaultsCard — where new sessions start (trust-dial, decision 6B)', () => {
  it('shows one dial and spells out what the chosen stop means on each runtime', async () => {
    renderCard();
    // Ask first is where a fresh install stands, resolved from the runtime's own
    // starting mode rather than from a stored value there is none of.
    expect(await screen.findByRole('radio', { name: 'Ask first' })).toBeChecked();
    // The caption is the runtime's own sentence, not copy written in Settings.
    await waitFor(() =>
      expect(screen.getByTestId('default-trust-stop-consequences')).toHaveTextContent(
        'Asks before it edits a file or runs a command.'
      )
    );
  });

  it('writes the runtime-neutral stop, never a mode id', async () => {
    const { updateConfig } = renderCard();
    await userEvent.click(await screen.findByRole('radio', { name: 'Act' }));

    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({ runtimes: { defaultTrustStop: 'act' } })
    );
  });

  it('asks before Full autonomy becomes the default, and writes nothing until it is answered', async () => {
    const { updateConfig } = renderCard();
    await userEvent.click(await screen.findByRole('radio', { name: 'Full autonomy' }));

    // The dialog reads the RUNTIME's own promise — what Full autonomy means
    // differs by agent, so Settings never writes its own sentence.
    expect(
      await screen.findByText(/Runs everything without asking, including outside this project/)
    ).toBeInTheDocument();
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('records the acknowledgement and the new default in ONE write', async () => {
    // Set-time is consent-time. Two requests would race — the server refuses the
    // stop without a record — so the dialog sends both together.
    const { updateConfig } = renderCard();
    await userEvent.click(await screen.findByRole('radio', { name: 'Full autonomy' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Turn on Full autonomy' }));

    await waitFor(() => expect(updateConfig).toHaveBeenCalledTimes(1));
    const patch = updateConfig.mock.calls[0]![0] as {
      ui: { autonomyAcknowledgedAt: string };
      runtimes: { defaultTrustStop: string };
    };
    expect(patch.runtimes).toEqual({ defaultTrustStop: 'autonomy' });
    expect(typeof patch.ui.autonomyAcknowledgedAt).toBe('string');
  });

  it('asks nothing of somebody who already acknowledged it', async () => {
    const { updateConfig } = renderCard(DEFAULTS, MODELS, {
      autonomyAcknowledgedAt: '2026-08-01T09:30:00.000Z',
    });
    await userEvent.click(await screen.findByRole('radio', { name: 'Full autonomy' }));

    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({ runtimes: { defaultTrustStop: 'autonomy' } })
    );
  });

  it('says so, quietly and permanently, while autonomy is the standing default', async () => {
    renderCard({ ...DEFAULTS, trustStop: 'autonomy' });
    expect(await screen.findByTestId('default-trust-stop-standing-note')).toHaveTextContent(
      'New sessions run without asking'
    );
  });

  it('keeps the per-runtime overrides behind a disclosure', async () => {
    const { updateConfig } = renderCard();
    expect(screen.queryByTestId('default-trust-stop-per-runtime')).not.toBeInTheDocument();

    await userEvent.click(await screen.findByTestId('default-trust-stop-disclosure'));
    const rows = await screen.findByTestId('default-trust-stop-per-runtime');
    // That runtime's OWN dial: the stop it lands on is resolved through its
    // profile, so the row writes a mode's stop rather than a stop word guessed here.
    await userEvent.click(within(rows).getAllByRole('radio', { name: 'Act' })[0]!);

    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({
        runtimes: { claudeCode: { defaultTrustStop: 'act' } },
      })
    );
  });

  it('returns a runtime to the global setting with a null, never a copied stop', async () => {
    const { updateConfig } = renderCard({
      ...DEFAULTS,
      trustStop: 'act',
      perRuntime: [
        {
          runtime: 'claude-code',
          model: null,
          effort: null,
          supportsEffort: true,
          trustStop: 'ask',
        },
      ],
    });
    await userEvent.click(await screen.findByTestId('default-trust-stop-disclosure'));
    await userEvent.click(await screen.findByRole('button', { name: 'Use the setting above' }));

    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({
        runtimes: { claudeCode: { defaultTrustStop: null } },
      })
    );
  });
});
