import { vi } from 'vitest';
import { leaseFixture } from '../../local-browser/__tests__/page-leases-fixture.js';
import { BrowserViewerRegistry } from '../viewer-registry.js';
import type { BrowserViewerPaint } from '@dorkos/shared/browser-viewer-control';
export const person = { ownerId: 'owner', sessionId: 'app', clientId: 'client' };
const image = Buffer.from([255, 216, 255, 192, 0, 11, 8, 1, 224, 2, 128, 1, 1, 17, 0, 255, 217]);
/** Real broker/controller/registry; only the executable/protocol edges are fake. */
export async function controlFixture() {
  const f = await leaseFixture();
  await f.open('chat-a');
  const page = f.contexts[0].pages[0];
  page.navigate('https://example.com');
  let enabled = true;
  const registry = new BrowserViewerRegistry(f.service.viewerPages.resolve, () => enabled);
  const viewer = await registry.subscribe(person, 'chat-a');
  const meta = () => registry.metadata(person, viewer.viewerId, viewer.nonce);
  const controls = () => registry.control(person, viewer.viewerId, viewer.nonce);
  const authorize = vi.fn(async () => undefined);
  const starts = () =>
    f.protocolSessions.filter((s) => s.send.mock.calls.some(([m]) => m === 'Page.startScreencast'));
  const emit = (width = 640) =>
    starts()
      .at(-1)!
      .events.emit('Page.screencastFrame', {
        sessionId: 1,
        data: image.toString('base64'),
        metadata: {
          deviceWidth: width,
          deviceHeight: 480,
          offsetTop: 0,
          pageScaleFactor: 1,
          scrollOffsetX: 0,
          scrollOffsetY: 0,
        },
      });
  const address = () =>
    registry.address(person, viewer.viewerId, viewer.nonce, 'chat-a', () =>
      f.service.personState('chat-a')
    );
  const ack = async (receipt?: string, paint?: BrowserViewerPaint) => {
    const pending = registry.frame(
      person,
      viewer.viewerId,
      viewer.nonce,
      receipt,
      undefined,
      paint
    );
    void pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(2000);
    return pending;
  };
  const paint = async () => {
    // A current stream is installed only after the previous physical one stops.
    await vi.waitFor(() => expectStream());
    await vi.advanceTimersByTimeAsync(84);
    emit();
    const frame = (await registry.frame(person, viewer.viewerId, viewer.nonce))!;
    const state = await address();
    await ack(frame.receipt, {
      addressReceipt: state.viewerAddress!.receipt,
      viewportGeneration: frame.viewport.generation,
    });
    return { frame, state };
  };
  const expectStream = () => {
    const latest = starts().at(-1);
    if (!latest || latest.detach.mock.calls.length) throw Error('stream not ready');
  };
  const operation = () => {
    const m = meta();
    return {
      nonce: viewer.nonce,
      controllerId: m.control!.id,
      controlEpoch: m.control!.epoch,
      navigationGeneration: m.navigationGeneration,
      viewportGeneration: m.viewport!.generation,
      sequence: m.control!.nextSequence,
    };
  };
  return {
    ...f,
    registry,
    viewer,
    meta,
    controls,
    authorize,
    page,
    starts,
    emit,
    address,
    ack,
    paint,
    operation,
    off: () => {
      enabled = false;
      registry.disableInput();
    },
    cleanup: async () => {
      await registry.close();
      await f.cleanup();
    },
  };
}
