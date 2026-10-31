/** @vitest-environment jsdom */
// An MCP App canvas runs a third-party server's UI. A route to the agent itself
// is granted with no person, so the document's page channel must never reach
// one: the real renderer and the real MCP App frame, with the doc channel open
// and routed, must offer it no capture, no challenge and no port.
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMockTransport } from '@dorkos/test-utils';
import type { CanvasChannelReplayResponse } from '@dorkos/shared/canvas-channel-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { DocFrameHandshake, FrameLifetimeController } from '@/layers/shared/lib/canvas-doc-frame';
import { CanvasRenderer } from '../ui/CanvasRenderer';

vi.mock('@/layers/entities/session', async (actual) => ({
  ...(await actual<typeof import('@/layers/entities/session')>()),
  useSessionId: () => ['session-a', vi.fn()],
}));

const generation = 'a'.repeat(64);
const replay: CanvasChannelReplayResponse = {
  incarnation: {
    v: 1,
    documentId: 'doc',
    physicalOpenedAt: '2026-10-02T00:00:00Z',
    channelCreatedAt: '2026-10-02T00:00:01Z',
    generation,
  },
  events: [],
  state: {},
  stateRev: 0,
  highWatermark: 0,
  retentionFloor: 1,
  receiptRetentionFloor: 1,
  resetRequired: false,
  receipts: [],
  health: { status: 'ready', reasons: [] },
  routing: { enabled: true, approvedEventTypes: ['save'], destinationLabel: 'DorkBot' },
};

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('an mcp_app doc gets no capture, challenge or port from the page channel', async () => {
  const transport = createMockTransport();
  transport.fetchMcpAppResource = vi.fn().mockResolvedValue({
    mimeType: 'text/html;profile=mcp-app',
    text: '<html><head></head><body>app</body></html>',
    permissions: [],
  });
  vi.mocked(transport.getCanvasChannel).mockResolvedValue(replay);
  const observe = vi.spyOn(FrameLifetimeController.prototype, 'observeHostContext');
  const start = vi.spyOn(DocFrameHandshake.prototype, 'start');
  const { container } = render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TransportProvider transport={transport}>
        <CanvasRenderer
          documentId="doc"
          content={{ type: 'mcp_app', serverName: 'fixture-app', uri: 'ui://dash/main' }}
          onContentChange={vi.fn()}
        />
      </TransportProvider>
    </QueryClientProvider>
  );
  const frame = await waitFor(() => {
    const el = container.querySelector('iframe');
    expect(el?.getAttribute('srcdoc')).toBeTruthy();
    return el as HTMLIFrameElement;
  });
  const page = frame.contentWindow!;
  const posts = vi.spyOn(page, 'postMessage');
  fireEvent.load(frame);
  // The app posts a perfectly shaped Doc acknowledgement from its own window.
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: page,
        origin: 'null',
        data: {
          protocol: 'dorkos-doc',
          v: 1,
          kind: 'ack',
          nonce: 'guessed-nonce',
          requestToken: 'guessed-token',
          loadToken: 1,
          generation,
        },
      })
    );
  });
  await act(async () => {});
  expect(observe).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
  // `postMessage` is overloaded; read every call as its raw arguments.
  const docTraffic = (posts.mock.calls as unknown[][]).filter(
    ([data, , transfer]) =>
      (data as { protocol?: unknown } | null)?.protocol === 'dorkos-doc' ||
      (Array.isArray(transfer) && transfer.length > 0)
  );
  expect(docTraffic).toHaveLength(0);
});
