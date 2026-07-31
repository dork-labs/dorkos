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
import { AgentExecutionRows } from '../ui/tabs/AgentExecutionRows';

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
  perRuntime: [
    { runtime: 'claude-code', model: 'opus', effort: 'medium', supportsEffort: true },
    { runtime: 'opencode', model: null, effort: null, supportsEffort: false },
  ],
};

const MODELS = [
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

function renderRows(
  agent: AgentManifest,
  executionDefaults: ExecutionDefaults = DEFAULTS,
  models: typeof MODELS = MODELS
) {
  const onUpdate = vi.fn();
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
      perRuntime: [{ runtime: 'claude-code', model: 'haiku', effort: null, supportsEffort: true }],
    });
    expect(await screen.findByTestId('agent-effort-unsupported-model')).toHaveTextContent(
      'haiku does not take an effort setting'
    );
  });
});
