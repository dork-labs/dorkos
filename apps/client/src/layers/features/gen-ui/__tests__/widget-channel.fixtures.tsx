/** Shared fixtures for the widget channel tests: a two-button document, receipts and an owned doc channel. */
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { cleanup, render, renderHook, waitFor, type RenderResult } from '@testing-library/react';
import type { WidgetDocument } from '@dorkos/shared/ui-widget';
import type { CanvasChannelEventReceipt, PageEvent } from '@dorkos/shared/canvas-channel-schemas';
import { useDocChannel } from '@/layers/features/canvas';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import { TransportProvider } from '@/layers/shared/model';
import { WidgetRenderer } from '../ui/WidgetRenderer';
import type { WidgetChannelPort } from '../model/widget-channel';

export const transport = createMockTransport();
export const document: WidgetDocument = {
  version: 1,
  title: 'Tasks',
  root: {
    type: 'stack',
    direction: 'vertical',
    children: [
      {
        type: 'button',
        label: 'One',
        action: { kind: 'emit', type: 'task.changed', payload: { task: 'one' } },
      },
      {
        type: 'button',
        label: 'Two',
        action: { kind: 'emit', type: 'task.changed', payload: { task: 'two' } },
      },
    ],
  },
};
export function receipt(
  event: PageEvent,
  status: CanvasChannelEventReceipt['deliveries'][number]['status'] = 'waiting'
): CanvasChannelEventReceipt {
  return {
    receipt: { id: event.id, status: 'recorded', docSeq: 1 },
    deliveries: [
      {
        eventId: event.id,
        routeId: 'tasks',
        batchId: 'batch',
        status,
        turnId: null,
        reason: null,
        updatedAt: new Date().toISOString(),
      },
    ],
  };
}
let ownedChannel: WidgetChannelPort;
let disposeOwned: (() => void) | undefined;
export function port(): WidgetChannelPort {
  return { ...ownedChannel };
}

export function draw(doc = document, channel = port()): RenderResult {
  return render(
    <TransportProvider transport={transport}>
      <WidgetRenderer document={doc} sessionId="session" channel={channel} />
    </TransportProvider>
  );
}
/** Drop the owned channel now, so a test can watch what happens after its owner goes. */
export function disposeOwnedChannel() {
  disposeOwned?.();
  disposeOwned = undefined;
}

/** Register the shared owned channel and cleanup around every widget-channel test. */
export function installWidgetChannelSuite() {
  beforeEach(async () => {
    vi.resetAllMocks();
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    vi.mocked(transport.ingestCanvasEvent).mockImplementation(async (_id, event) => receipt(event));
    vi.mocked(transport.getCanvasEventReceipt).mockRejectedValue(
      Object.assign(new Error('Missing'), { status: 404 })
    );
    vi.mocked(transport.getCanvasChannel).mockResolvedValue({
      events: [],
      state: {},
      stateRev: 0,
      highWatermark: 0,
      retentionFloor: 1,
      receiptRetentionFloor: 1,
      resetRequired: false,
      receipts: [],
      health: { status: 'ready', reasons: [] },
      routing: { enabled: true, destinationLabel: 'LifeOS', approvedEventTypes: ['widget.action'] },
      incarnation: {
        v: 1,
        documentId: 'doc-one',
        physicalOpenedAt: '2026-10-02T00:00:00Z',
        channelCreatedAt: '2026-10-02T00:00:01Z',
        generation: 'a'.repeat(64),
      },
    });
    const owned = renderHook(() => useDocChannel('doc-one'), {
      wrapper: ({ children }) => (
        <TransportProvider transport={transport}>{children}</TransportProvider>
      ),
    });
    disposeOwned = owned.unmount;
    await waitFor(() => expect(owned.result.current.channel.enabled).toBe(true));
    ownedChannel = owned.result.current.channel;
  });
  afterEach(() => {
    disposeOwned?.();
    disposeOwned = undefined;
    cleanup();
  });
}
