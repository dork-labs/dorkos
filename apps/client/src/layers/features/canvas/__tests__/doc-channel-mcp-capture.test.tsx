/** @vitest-environment jsdom */
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createMockTransport } from '@dorkos/test-utils';
import type { CanvasChannelReplayResponse } from '@dorkos/shared/canvas-channel-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { useDocChannel } from '../model/use-doc-channel';
const birth = {
  v: 1 as const,
  documentId: 'mcp-document',
  physicalOpenedAt: '2026-10-01T00:00:00.000Z',
  channelCreatedAt: '2026-10-01T00:00:00.000Z',
  generation: 'a'.repeat(64),
};
const event = {
  v: 1 as const,
  id: '44444444-4444-4444-8444-444444444444',
  type: 'task.changed',
  payload: { value: 1 },
};
function replay(withOrigin: boolean): CanvasChannelReplayResponse {
  return {
    scope: 'session:native-session',
    incarnation: birth,
    events: [],
    state: {},
    stateRev: 0,
    highWatermark: 0,
    retentionFloor: 1,
    receiptRetentionFloor: 1,
    resetRequired: false,
    health: { status: 'ready', reasons: [] },
    receipts: [],
    routing: { enabled: false, approvedEventTypes: [], destinationLabel: 'Log only' },
    ...(withOrigin
      ? {
          mcpOrigin: {
            canonicalSessionId: 'native-session',
            serverName: 'original-server',
            uri: 'ui://original-resource',
            physicalRevision: 1,
            declaration: { routes: [] },
            declarationHash: 'b'.repeat(64),
          },
        }
      : {}),
  };
}
describe('MCP recording from the original document owner', () => {
  it('captures log-only original HTTP operations without opening widget routing, and retires on unmount', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getCanvasChannel).mockResolvedValue(replay(true));
    const accepted = {
      receipt: { id: event.id, status: 'recorded' as const, docSeq: 1 },
      deliveries: [],
    };
    const submit = vi.mocked(transport.ingestCanvasEvent).mockResolvedValue(accepted);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TransportProvider transport={transport}>{children}</TransportProvider>
    );
    const { result, unmount } = renderHook(() => useDocChannel(birth.documentId), { wrapper });
    try {
      await waitFor(() => expect(result.current.mcpBinding?.current('read')).toBe(true));
      expect(result.current.channel.enabled).toBe(false);
      expect(result.current.channel.captureOriginal?.(event)).toBeNull();
      const binding = result.current.mcpBinding!;
      const original = binding.captureOriginal(event);
      expect(original).not.toBeNull();
      await act(async () =>
        expect(await original!.submit(new AbortController().signal)).toEqual(accepted)
      );
      expect(submit).toHaveBeenCalledWith(
        birth.documentId,
        event,
        { expectedGeneration: birth.generation },
        expect.any(AbortSignal)
      );
      unmount();
      expect(binding.current('read')).toBe(false);
      expect(original!.current('read')).toBe(false);
    } finally {
      unmount();
    }
  });
  it('does not invent MCP permission when the original owned HTTP page has no stored MCP source', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getCanvasChannel).mockResolvedValue(replay(false));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <TransportProvider transport={transport}>{children}</TransportProvider>
    );
    const { result, unmount } = renderHook(() => useDocChannel(birth.documentId), { wrapper });
    try {
      await waitFor(() => expect(result.current.replayObserved).toBe(true));
      expect(result.current.mcpBinding).toBeUndefined();
      expect(result.current.channel.captureOriginal?.(event)).toBeNull();
      expect(transport.ingestCanvasEvent).not.toHaveBeenCalled();
    } finally {
      unmount();
    }
  });
});
