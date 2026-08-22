/**
 * The trust-stop write path, tested where it lives rather than through whichever
 * card happens to render it (spec `runtimes-settings-redesign`, task 2.3).
 *
 * Two surfaces write trust stops through this hook — the per-runtime row and the
 * global one — and the consent contract between them is the thing that must not
 * drift: what shape the patch takes, when it asks first, and above all that the
 * acknowledgement and the stop travel in ONE request. The server refuses the
 * stop without a standing acknowledgement, so a split into two requests races
 * and the stop bounces. That is the regression these tests exist for.
 *
 * A mock `Transport` behind a real `TransportProvider`, not mocked hooks: the
 * request that reaches the wire is the assertion, and the query wiring the hook
 * owns (`useConfig`, `useUpdateConfig`, capabilities) is part of what is under
 * test.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, type Mock } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor, act, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ExecutionDefaults } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { configKeys } from '@/layers/entities/config';
import { useTrustStopWrites } from '../model/use-trust-stop-writes';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const DEFAULTS: ExecutionDefaults = {
  runtime: 'claude-code',
  trustStop: null,
  perRuntime: [
    { runtime: 'claude-code', model: null, effort: null, supportsEffort: true, trustStop: null },
    { runtime: 'codex', model: null, effort: null, supportsEffort: true, trustStop: null },
  ],
};

/**
 * Three runtimes, because the contract is about what each one DECLARES.
 *
 * Codex carries its own autonomy mode with its own sentence, so a staged dialog
 * reading Claude Code's promise instead of Codex's would be visible here rather
 * than only to a person. `test-mode` declares `configSection: null` — the
 * runtime that has nowhere to store a setting, and therefore writes nothing.
 */
async function capabilityFixture() {
  const base = await createMockTransport().getCapabilities();
  const claude = base.capabilities['claude-code']!;
  return {
    ...base,
    capabilities: {
      ...base.capabilities,
      codex: {
        ...claude,
        type: 'codex',
        permissionModes: {
          supported: true,
          values: [
            {
              id: 'untrusted',
              label: 'Read only',
              stop: 'ask' as const,
              asks: 'always' as const,
              reach: 'read' as const,
              promise: 'Asks before it touches anything.',
            },
            {
              id: 'danger-full-access',
              label: 'Full access',
              stop: 'autonomy' as const,
              asks: 'never' as const,
              reach: 'everything' as const,
              promise: 'Codex runs everything without asking, anywhere on this machine.',
            },
          ],
        },
        settings: { configSection: 'codex', supportsEffort: true, sections: [] },
      },
      'test-mode': {
        ...claude,
        type: 'test-mode',
        permissionModes: { supported: false, values: [] },
        settings: { configSection: null, supportsEffort: false, sections: [] },
      },
    },
  };
}

/** The wire, as `Transport.updateConfig` declares it. */
type UpdateConfigMock = Mock<(patch: Record<string, unknown>) => Promise<void>>;

function setup(
  options: {
    executionDefaults?: ExecutionDefaults;
    acknowledgedAt?: string | null;
    updateConfig?: UpdateConfigMock;
  } = {}
) {
  const updateConfig: UpdateConfigMock =
    options.updateConfig ??
    vi.fn<(patch: Record<string, unknown>) => Promise<void>>(async () => {});
  const transport = createMockTransport({
    getCapabilities: vi.fn(capabilityFixture),
    getConfig: vi.fn().mockResolvedValue({
      version: '1.0.0',
      port: 4242,
      uptime: 0,
      workingDirectory: '/test',
      nodeVersion: 'v20.0.0',
      platform: 'linux-x64',
      runtimes: ['claude-code'],
      claudeCliPath: null,
      executionDefaults: options.executionDefaults ?? DEFAULTS,
      ui: { autonomyAcknowledgedAt: options.acknowledgedAt ?? null },
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
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  const view = renderHook(() => useTrustStopWrites(), { wrapper });
  return { ...view, updateConfig, queryClient };
}

/** Both reads the hook depends on have landed and been rendered. */
async function ready(queryClient: QueryClient) {
  await waitFor(() => {
    expect(queryClient.getQueryData(['capabilities'])).toBeDefined();
    expect(queryClient.getQueryData(configKeys.current())).toBeDefined();
  });
  await act(async () => {});
}

describe('useTrustStopWrites — the patch shape', () => {
  it('writes a global stop as the bare runtimes field', async () => {
    const { result, updateConfig, queryClient } = setup();
    await ready(queryClient);

    act(() => result.current.changeTrustStop(null, 'act'));

    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({ runtimes: { defaultTrustStop: 'act' } })
    );
  });

  it('writes a per-runtime stop into the section that runtime declares', async () => {
    const { result, updateConfig, queryClient } = setup();
    await ready(queryClient);

    act(() => result.current.changeTrustStop('codex', 'act'));

    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({
        runtimes: { codex: { defaultTrustStop: 'act' } },
      })
    );
  });

  it('writes nothing at all for a runtime with no config section', async () => {
    const { result, updateConfig, queryClient } = setup();
    await ready(queryClient);

    act(() => result.current.changeTrustStop('test-mode', 'act'));
    // The control: the same call on a runtime that HAS a section does write, so
    // the silence above is the missing section and not a hook that never woke up.
    act(() => result.current.changeTrustStop('codex', 'act'));

    await waitFor(() => expect(updateConfig).toHaveBeenCalledTimes(1));
    expect(updateConfig).toHaveBeenCalledWith({ runtimes: { codex: { defaultTrustStop: 'act' } } });
  });
});

describe('useTrustStopWrites — the Full-autonomy door', () => {
  it('writes nothing and stages the runtime’s OWN promise when nobody has acknowledged', async () => {
    const { result, updateConfig, queryClient } = setup();
    await ready(queryClient);

    act(() => result.current.changeTrustStop('codex', 'autonomy'));

    await waitFor(() => expect(result.current.pendingAutonomy).not.toBeNull());
    expect(result.current.pendingAutonomy?.runtime).toBe('codex');
    // Codex's sentence, not Claude Code's — what Full autonomy means differs by
    // agent, and a stand-in would be wrong for somebody.
    expect(result.current.pendingAutonomy?.descriptor.promise).toBe(
      'Codex runs everything without asking, anywhere on this machine.'
    );
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('sends the acknowledgement and the stop in exactly ONE request', async () => {
    // The load-bearing property. The server refuses the stop without a standing
    // acknowledgement, so two requests would race and the stop could land first
    // and bounce. Any refactor that splits this is a defect.
    const { result, updateConfig, queryClient } = setup();
    await ready(queryClient);

    act(() => result.current.changeTrustStop(null, 'autonomy'));
    await waitFor(() => expect(result.current.pendingAutonomy).not.toBeNull());
    act(() => result.current.confirmAutonomy());

    await waitFor(() => expect(updateConfig).toHaveBeenCalledTimes(1));
    const patch = updateConfig.mock.calls[0]![0] as {
      ui: { autonomyAcknowledgedAt: string };
      runtimes: { defaultTrustStop: string };
    };
    expect(patch.runtimes).toEqual({ defaultTrustStop: 'autonomy' });
    expect(Number.isNaN(Date.parse(patch.ui.autonomyAcknowledgedAt))).toBe(false);
    expect(result.current.pendingAutonomy).toBeNull();
  });

  it('asks nothing of somebody who already acknowledged it', async () => {
    const { result, updateConfig, queryClient } = setup({
      acknowledgedAt: '2026-08-01T09:30:00.000Z',
    });
    await ready(queryClient);

    act(() => result.current.changeTrustStop(null, 'autonomy'));

    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({ runtimes: { defaultTrustStop: 'autonomy' } })
    );
    expect(result.current.pendingAutonomy).toBeNull();
  });
});

describe('useTrustStopWrites — what a person is told when it fails', () => {
  it('shows the server’s own refusal verbatim', async () => {
    const updateConfig: UpdateConfigMock = vi.fn(() =>
      Promise.reject(new Error('Full autonomy needs an acknowledgement first.'))
    );
    const { result, queryClient } = setup({ updateConfig });
    await ready(queryClient);

    act(() => result.current.changeTrustStop(null, 'act'));

    await waitFor(() =>
      expect(result.current.writeError).toBe('Full autonomy needs an acknowledgement first.')
    );
    act(() => result.current.clearWriteError());
    expect(result.current.writeError).toBeNull();
  });
});

describe('useTrustStopWrites — who moves with the write', () => {
  it('invalidates the config PREFIX, not just this card’s key', async () => {
    // The status bar, the sidebar badges and `useFeatureEnabled` read config off
    // a broader key set, and the server applies the default live.
    const { result, queryClient } = setup();
    await ready(queryClient);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    act(() => result.current.changeTrustStop(null, 'act'));

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: configKeys.all }));
  });
});
