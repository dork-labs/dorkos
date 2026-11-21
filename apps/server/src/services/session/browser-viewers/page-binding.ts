import type { BrowserPageBroker } from '../local-browser/leases/page-broker.js';
import type { BrowserViewerPageHandle } from '../local-browser/leases/broker-contract.js';
import { startChromeScreencast } from './chrome-screencast.js';
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
  const navigation = handle.facts().navigationGeneration;
  const ended = () => lifetime.abort();
  const offRevoke = handle.onRevoked(ended);
  // Preserve PR1's explicit reopen after navigation until the paint/address range lands.
  const offChange = handle.onPageChange((facts) => {
    if (facts.navigationGeneration !== navigation) ended();
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
    identity: Object.freeze({
      chatId,
      profileId: handle.binding.profileId,
      connectionId: handle.binding.connectionId,
      tabId: handle.binding.tabId,
    }),
    signal: lifetime.signal,
    assertLive,
    assertCurrent,
    abandon: () => broker.abandonViewer(handle),
    async close() {
      ended();
      offChange();
      offRevoke();
      await handle.close();
    },
    async start(receive) {
      await assertCurrent();
      const stop = await startChromeScreencast(handle, (frame) => {
        try {
          assertLive();
          receive(frame);
        } catch {
          /* Revocation fences publication. */
        }
      });
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
