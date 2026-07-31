// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
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
  perRuntime: [
    { runtime: 'claude-code', model: 'claude-opus-4-6', effort: 'high', supportsEffort: true },
    { runtime: 'codex', model: null, effort: null, supportsEffort: true },
    { runtime: 'opencode', model: null, effort: null, supportsEffort: false },
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
  { value: 'haiku', displayName: 'Haiku', description: 'Small model', supportsEffort: false },
];

function renderCard(executionDefaults: ExecutionDefaults = DEFAULTS, models = MODELS) {
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
      perRuntime: [{ runtime: 'claude-code', model: 'haiku', effort: null, supportsEffort: true }],
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
        { runtime: 'claude-code', model: 'haiku', effort: 'high', supportsEffort: true },
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
          { runtime: 'claude-code', model: 'claude-opus-4-6', effort: null, supportsEffort: true },
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
      perRuntime: [{ runtime: 'claude-code', model: 'opus-3', effort: null, supportsEffort: true }],
    });
    await waitFor(() =>
      expect(screen.getByTestId('default-model-select')).toHaveTextContent('no longer offered')
    );
  });
});
