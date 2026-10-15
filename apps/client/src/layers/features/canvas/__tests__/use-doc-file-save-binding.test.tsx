/** @vitest-environment jsdom */
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { useDocChannel } from '../model/use-doc-channel';
const incarnation = {
  v: 1 as const,
  documentId: 'doc-1',
  physicalOpenedAt: '2026-10-15T00:00:00.000Z',
  channelCreatedAt: '2026-10-15T00:00:00.000Z',
  generation: 'a'.repeat(64),
};
function setup(withBirth = true) {
  const transport = createMockTransport();
  vi.mocked(transport.getCanvasChannel).mockResolvedValue({
    ...(withBirth ? { incarnation } : {}),
    routing: { enabled: false, approvedEventTypes: [], destinationLabel: 'No routes' },
    events: [],
    state: {},
    stateRev: 0,
    highWatermark: 0,
    retentionFloor: 1,
    receiptRetentionFloor: 1,
    resetRequired: false,
    health: { status: 'ready', reasons: [] },
    receipts: [],
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <TransportProvider transport={transport}>{children}</TransportProvider>
  );
  return { transport, view: renderHook(() => useDocChannel('doc-1'), { wrapper }) };
}
it('projects the real verified read birth for file receipts without requiring an enabled event route', async () => {
  const { transport, view } = setup();
  await waitFor(() => expect(view.result.current.fileSaveBinding?.current()).toBe(true));
  expect(view.result.current.channel.enabled).toBe(false);
  const binding = view.result.current.fileSaveBinding!;
  expect(binding.incarnation).toEqual(incarnation);
  expect(Object.isFrozen(binding.incarnation)).toBe(true);
  view.unmount();
  expect(binding.current()).toBe(false);
  expect(transport.ingestCanvasEvent).not.toHaveBeenCalled();
});
it('does not invent an incarnation for a legacy replay', async () => {
  const { transport, view } = setup(false);
  await waitFor(() => expect(view.result.current.channel.snapshot?.stateRev).toBe(0));
  expect(transport.getCanvasChannel).toHaveBeenCalled();
  expect(view.result.current.fileSaveBinding).toBeUndefined();
  view.unmount();
});
