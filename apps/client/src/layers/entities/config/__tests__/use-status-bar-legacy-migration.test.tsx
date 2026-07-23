/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useStatusBarLegacyMigration } from '../model/use-status-bar-legacy-migration';

const LEGACY_KEYS = [
  'dorkos-show-status-bar-cwd',
  'dorkos-show-status-bar-git',
  'dorkos-show-status-bar-runtime',
  'dorkos-show-status-bar-model',
  'dorkos-show-status-bar-cache',
  'dorkos-show-status-bar-context',
  'dorkos-show-status-bar-usage',
  'dorkos-show-status-bar-permission',
  'dorkos-show-status-bar-sound',
  'dorkos-show-status-bar-polling',
];

function harness(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return { wrapper };
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe('useStatusBarLegacyMigration', () => {
  it('does nothing when no legacy keys are present (the common case)', async () => {
    const transport = createMockTransport({ updateConfig: vi.fn().mockResolvedValue(undefined) });
    const { wrapper } = harness(transport);

    renderHook(() => useStatusBarLegacyMigration(), { wrapper });

    await Promise.resolve();
    expect(transport.updateConfig).not.toHaveBeenCalled();
  });

  it('PATCHes only the explicitly-set legacy values and then removes every legacy key', async () => {
    localStorage.setItem('dorkos-show-status-bar-git', 'false');
    localStorage.setItem('dorkos-show-status-bar-cwd', 'true');
    // An unrelated key must survive untouched.
    localStorage.setItem('dorkos-theme', 'dark');
    const transport = createMockTransport({ updateConfig: vi.fn().mockResolvedValue(undefined) });
    const { wrapper } = harness(transport);

    renderHook(() => useStatusBarLegacyMigration(), { wrapper });

    // Lifts up only the two keys the device actually set.
    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith({
        ui: { statusBar: { git: false, cwd: true } },
      })
    );

    // Every legacy status-bar key is cleared after a successful write.
    await waitFor(() => {
      for (const key of LEGACY_KEYS) {
        expect(localStorage.getItem(key)).toBeNull();
      }
    });
    // The unrelated key is left alone.
    expect(localStorage.getItem('dorkos-theme')).toBe('dark');
  });

  it('leaves the legacy keys in place when the PATCH fails (a later load retries)', async () => {
    localStorage.setItem('dorkos-show-status-bar-model', 'false');
    const transport = createMockTransport({
      updateConfig: vi.fn().mockRejectedValue(new Error('offline')),
    });
    const { wrapper } = harness(transport);

    renderHook(() => useStatusBarLegacyMigration(), { wrapper });

    await waitFor(() => expect(transport.updateConfig).toHaveBeenCalledTimes(1));
    // The value is preserved for a future retry.
    expect(localStorage.getItem('dorkos-show-status-bar-model')).toBe('false');
  });

  it('attempts the migration at most once per mount (ref guard)', async () => {
    localStorage.setItem('dorkos-show-status-bar-git', 'false');
    const transport = createMockTransport({ updateConfig: vi.fn().mockResolvedValue(undefined) });
    const { wrapper } = harness(transport);

    const { rerender } = renderHook(() => useStatusBarLegacyMigration(), { wrapper });
    rerender();
    rerender();

    await waitFor(() => expect(transport.updateConfig).toHaveBeenCalledTimes(1));
  });
});
