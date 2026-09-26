/** @vitest-environment jsdom */
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { ConnectorReconciliationPreview } from '@dorkos/shared/connector-schemas';
import type { ConnectorAuthoritySyncState } from '@dorkos/shared/connector-resource-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useAccessReconciliation } from '../model/use-access-reconciliation';

const GRANT = { agentId: 'agent-a', operationRevisionIds: ['read-v1'] };

function preview(expiresAt = '2099-01-01T00:00:00.000Z'): ConnectorReconciliationPreview {
  return {
    previewId: 'preview-1',
    connection: {
      connectionId: 'connection-1' as never,
      toolkit: 'gmail',
      label: 'work',
      status: 'active',
      custody: 'managed',
      reconciliationStatus: 'ready',
    },
    candidates: [],
    agents: [{ agentId: 'agent-a', displayName: 'Ada' }],
    currentGrants: [],
    catalogComplete: true,
    createdAt: '2026-09-06T00:00:00.000Z',
    expiresAt,
  };
}

function renderAccess(transport: Transport) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return renderHook(() => useAccessReconciliation({ connectionId: 'connection-1', active: true }), {
    wrapper,
  });
}

/** Save one grant whose authority sync the server reports as pending. */
async function savePending(transport: Transport) {
  vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(preview());
  vi.mocked(transport.applyConnectorReconciliation).mockResolvedValue({
    connectionId: 'connection-1' as never,
    reconciliationStatus: 'ready',
    authoritySync: { status: 'pending' },
    grants: [GRANT],
  });
  const hook = renderAccess(transport);
  await waitFor(() => expect(hook.result.current.preview).toBeDefined());
  act(() => hook.result.current.apply([GRANT]));
  await waitFor(() => expect(hook.result.current.saveOutcome).not.toBeNull());
  return hook;
}

function readBack(
  agentSync: ConnectorAuthoritySyncState,
  connectionStatus: 'ready' | 'migration_needs_reconcile' = 'ready'
) {
  return {
    connection: {
      connectionId: 'connection-1',
      reconciliationStatus: connectionStatus,
      authoritySync: { status: 'ready' },
    },
    agents: [{ ...GRANT, reconciliationStatus: 'ready', authoritySync: agentSync }],
  } as never;
}

describe('useAccessReconciliation', () => {
  it('stays pending when the sync check still reads pending', async () => {
    const transport = createMockTransport();
    const hook = await savePending(transport);
    vi.mocked(transport.getConnectorConnection).mockResolvedValue(readBack({ status: 'pending' }));

    act(() => hook.result.current.checkSync());
    await waitFor(() => expect(transport.getConnectorConnection).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(hook.result.current.isCheckingSync).toBe(false));
    expect(hook.result.current.saved).toBe(false);
    expect(hook.result.current.saveOutcome?.authoritySync).toEqual({ status: 'pending' });
  });

  it('reports a failed sync, with its reason, when the check reads a failure', async () => {
    const transport = createMockTransport();
    const hook = await savePending(transport);
    vi.mocked(transport.getConnectorConnection).mockResolvedValue(
      readBack({ status: 'failed', reason: 'Provider refused.' })
    );

    act(() => hook.result.current.checkSync());
    await waitFor(() =>
      expect(hook.result.current.saveOutcome?.authoritySync).toEqual({
        status: 'failed',
        reason: 'Provider refused.',
      })
    );
    expect(hook.result.current.saved).toBe(false);
    expect(transport.applyConnectorReconciliation).toHaveBeenCalledTimes(1);
  });

  it('reports ready only when the check reads every changed agent ready', async () => {
    const transport = createMockTransport();
    const hook = await savePending(transport);
    vi.mocked(transport.getConnectorConnection).mockResolvedValue(readBack({ status: 'ready' }));

    act(() => hook.result.current.checkSync());
    await waitFor(() => expect(hook.result.current.saved).toBe(true));
  });

  it('never sends a save against an expired snapshot, and asks for a fresh one', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.previewConnectorReconciliation).mockResolvedValue(
      preview('2000-01-01T00:00:00.000Z')
    );
    const hook = renderAccess(transport);
    await waitFor(() => expect(hook.result.current.preview).toBeDefined());

    act(() => hook.result.current.apply([GRANT]));
    expect(hook.result.current.needsRefresh).toBe(true);
    expect(transport.applyConnectorReconciliation).not.toHaveBeenCalled();
  });

  it('reports needs review when the check reads the connection needing reconciliation', async () => {
    const transport = createMockTransport();
    const hook = await savePending(transport);
    vi.mocked(transport.getConnectorConnection).mockResolvedValue(
      readBack({ status: 'ready' }, 'migration_needs_reconcile')
    );

    act(() => hook.result.current.checkSync());
    await waitFor(() => expect(hook.result.current.needsReconciliation).toBe(true));
    expect(hook.result.current.saved).toBe(false);
  });
});
