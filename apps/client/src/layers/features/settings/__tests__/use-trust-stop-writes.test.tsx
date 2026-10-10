/**
 * The trust-stop write path, tested where it lives rather than through whichever
 * card happens to render it (spec `runtimes-settings-redesign`, task 2.3).
 *
 * Two surfaces write trust stops through this hook — the per-runtime row and the
 * global one — and the contract between them is the thing that must not drift:
 * what shape the patch takes, and that Full autonomy is written straight through
 * like any other stop (ADR 261006-225605).
 *
 * A mock `Transport` behind a real `TransportProvider`, not mocked hooks: the
 * request that reaches the wire is the assertion, and the query wiring the hook
 * owns (`useUpdateConfig`, capabilities) is part of what is under
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
 * Codex declares its own config section. `test-mode` declares `configSection:
 * null` — the runtime that has nowhere to store a setting, and therefore writes
 * nothing.
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
      ui: {},
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

/** The capability read the hook depends on has landed and been rendered. */
async function ready(queryClient: QueryClient) {
  await waitFor(() => {
    expect(queryClient.getQueryData(['capabilities'])).toBeDefined();
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

describe('useTrustStopWrites — Full autonomy is a normal choice', () => {
  it('writes a global Full autonomy stop straight through, with no acknowledgement', async () => {
    // ADR 261006-225605 retired the consent ritual: no staging, no dialog, and
    // nothing under `ui` rides the write. `toHaveBeenCalledWith` compares the
    // whole patch, so an acknowledgement riding along would fail it.
    const { result, updateConfig, queryClient } = setup();
    await ready(queryClient);

    act(() => result.current.changeTrustStop(null, 'autonomy'));

    await waitFor(() => expect(updateConfig).toHaveBeenCalledTimes(1));
    expect(updateConfig).toHaveBeenCalledWith({ runtimes: { defaultTrustStop: 'autonomy' } });
    expect(updateConfig.mock.calls[0]![0]).not.toHaveProperty('ui');
  });

  it('writes a per-runtime Full autonomy stop straight through', async () => {
    const { result, updateConfig, queryClient } = setup();
    await ready(queryClient);

    act(() => result.current.changeTrustStop('codex', 'autonomy'));

    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({
        runtimes: { codex: { defaultTrustStop: 'autonomy' } },
      })
    );
  });
});

describe('useTrustStopWrites — what a person is told when it fails', () => {
  it('shows the server’s own refusal verbatim', async () => {
    const updateConfig: UpdateConfigMock = vi.fn(() =>
      Promise.reject(new Error('Only a person can change this.'))
    );
    const { result, queryClient } = setup({ updateConfig });
    await ready(queryClient);

    act(() => result.current.changeTrustStop(null, 'act'));

    await waitFor(() => expect(result.current.writeError).toBe('Only a person can change this.'));
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
