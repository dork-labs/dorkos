import type { BrowserPageBroker } from '../local-browser/leases/page-broker.js';
import type {
  BrowserPersonInputLease,
  BrowserViewerPageHandle,
} from '../local-browser/leases/broker-contract.js';
import { startBrokerPageStream } from './page-stream.js';
import { BrowserViewerError, type ViewerPage, type ViewerPrincipal } from './viewer-contract.js';

/** Capture server-derived authority once. No raw Page, context or later target lookup escapes. */
export async function captureViewerPage(
  broker: BrowserPageBroker,
  chatId: string,
  principal: ViewerPrincipal,
  viewerId: string
): Promise<ViewerPage> {
  let handle: BrowserViewerPageHandle;
  try {
    handle = await broker.captureViewerLease(chatId, {
      ownerId: principal.ownerId,
      appSessionId: principal.sessionId,
      clientInstanceId: principal.clientId,
      viewerId,
    });
  } catch {
    throw new BrowserViewerError('viewer_unavailable');
  }
  const lifetime = new AbortController();
  const ended = () => lifetime.abort();
  const offRevoke = handle.onRevoked(ended);
  let control: BrowserPersonInputLease | undefined;
  const offChange = handle.onPageChange(() => {
    // A failed safety renewal ends this watch; explicit hand-back/abandon clear it first.
    if (control && !control.isCurrent()) ended();
  });
  const assertLive = () => {
    try {
      if (lifetime.signal.aborted) throw new BrowserViewerError('viewer_unavailable');
      handle.assertCurrent();
      handle.assertWatchAllowed();
    } catch {
      ended();
      throw new BrowserViewerError('viewer_unavailable');
    }
  };
  const assertCurrent = async () => {
    try {
      assertLive();
      await handle.assertAuthorized();
      assertLive();
    } catch {
      ended();
      throw new BrowserViewerError('viewer_unavailable');
    }
  };
  return {
    binding: handle.binding,
    facts: () => {
      assertLive();
      return handle.facts();
    },
    onChange: (listener) => handle.onPageChange(listener),
    async takeControl() {
      try {
        const lease = await broker.takePersonControl(handle);
        control = lease;
        return lease;
      } catch (error) {
        ended();
        throw error;
      }
    },
    handBack: (lease) => {
      control = undefined;
      return broker.handBack(lease);
    },
    identity: Object.freeze({
      chatId,
      profileId: handle.binding.profileId,
      connectionId: handle.binding.connectionId,
      tabId: handle.binding.tabId,
    }),
    signal: lifetime.signal,
    assertLive,
    assertCurrent,
    abandon: () => {
      control = undefined;
      return broker.abandonViewer(handle);
    },
    async close() {
      ended();
      offRevoke();
      offChange();
      await handle.close();
    },
    async start(receive) {
      await assertCurrent();
      const stop = await startBrokerPageStream(handle, receive, ended);
      const detach = () => {
        void stop().catch(() => undefined);
      };
      lifetime.signal.addEventListener('abort', detach, { once: true });
      try {
        await assertCurrent();
      } catch (error) {
        await stop();
        throw error;
      }
      return async () => {
        lifetime.signal.removeEventListener('abort', detach);
        await stop();
      };
    },
  };
}
