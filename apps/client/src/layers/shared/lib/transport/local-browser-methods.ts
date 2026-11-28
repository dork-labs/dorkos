import type { LocalBrowserTransport } from '@dorkos/shared/transport-local-browser';
import {
  LocalBrowserCapabilitiesSchema,
  LocalBrowserPersonStateSchema,
  LocalBrowserProfileSchema,
  LocalBrowserStateSchema,
} from '@dorkos/shared/local-browser';
import { YourBrowserScanSchema } from '@dorkos/shared/your-browser';
import { createTransportApiClient } from './api-client';
import { fetchJSON } from './http-client';
import { createBrowserViewerMethods } from './browser-viewer-methods';
import { resolveStableClientId } from './client-id';

/**
 * Local browser human controls, using the same authenticated origin as every app action.
 * Documented calls go through the generated API client (DOR-5473).
 */
export function createLocalBrowserMethods(
  baseUrl: string,
  clientId: () => string = resolveStableClientId
): LocalBrowserTransport {
  const api = createTransportApiClient(baseUrl);
  /** The chat a call acts on, left out for Your browser. */
  const chat = (sessionId?: string | null) => ({ sessionId: sessionId ?? undefined });
  const selected = (path: string, sessionId?: string | null) =>
    sessionId == null ? path : `${path}?sessionId=${encodeURIComponent(sessionId)}`;
  return {
    ...createBrowserViewerMethods(baseUrl, clientId),
    // Stays hand-written: it asks the browser not to cache the answer (DOR-5473).
    scanYourBrowsers: async () =>
      YourBrowserScanSchema.parse(
        await fetchJSON(baseUrl, '/your-browser/scan', {
          method: 'POST',
          body: '{}',
          cache: 'no-store',
        })
      ),
    // Stays hand-written: it sends its own viewer headers and asks for no cache (DOR-5473).
    getLocalBrowserState: async (sessionId, viewer) =>
      LocalBrowserPersonStateSchema.parse(
        await fetchJSON(baseUrl, `/local-browser${selected('/state', sessionId)}`, {
          cache: 'no-store',
          headers: viewer
            ? {
                'X-Client-Id': clientId(),
                'X-Viewer-Id': viewer.viewerId,
                'X-Viewer-Nonce': viewer.nonce,
              }
            : undefined,
        })
      ),
    getLocalBrowserHandoffState: async () =>
      LocalBrowserPersonStateSchema.parse(await api.call('localBrowser.getHandoffState', {})),
    getLocalBrowserCapabilities: async () =>
      LocalBrowserCapabilitiesSchema.parse(await api.call('localBrowser.getCapabilities', {})),
    listLocalBrowserProfiles: async () => {
      const result = await api.call('localBrowser.listProfiles', {});
      return {
        profiles: result.profiles.map((profile) => LocalBrowserProfileSchema.parse(profile)),
      };
    },
    // Stays hand-written: the document leaves out its `sessionId` query (DOR-5473).
    bindLocalBrowserProfile: async (id, agentId, sessionId) =>
      LocalBrowserProfileSchema.parse(
        await fetchJSON(
          baseUrl,
          `/local-browser${selected(`/profiles/${encodeURIComponent(id)}/agents`, sessionId)}`,
          { method: 'POST', body: JSON.stringify({ agentId }) }
        )
      ),
    // Stays hand-written: the document leaves out its `sessionId` query (DOR-5473).
    unbindLocalBrowserProfile: async (id, agentId, sessionId) =>
      LocalBrowserProfileSchema.parse(
        await fetchJSON(
          baseUrl,
          `/local-browser${selected(`/profiles/${encodeURIComponent(id)}/agents/${encodeURIComponent(agentId)}`, sessionId)}`,
          { method: 'DELETE' }
        )
      ),
    forgetLocalBrowserSignIns: (id) =>
      api.call('localBrowser.createProfilesForgetSignIns', { path: { id: id ?? 'default' } }),
    deleteLocalBrowserProfile: (id) => api.call('localBrowser.deleteProfiles', { path: { id } }),
    openLocalBrowser: async (input) =>
      LocalBrowserPersonStateSchema.parse(await api.call('localBrowser.open', { body: input })),
    selectLocalBrowserTab: async (id, sessionId) =>
      LocalBrowserStateSchema.parse(
        await api.call('localBrowser.createTabsSelect', { path: { id }, query: chat(sessionId) })
      ),
    navigateLocalBrowser: async (url, options) =>
      LocalBrowserPersonStateSchema.parse(
        await api.call('localBrowser.createNavigate', {
          query: chat(options?.sessionId),
          body: options?.httpFallback ? { url, httpFallback: true } : { url },
        })
      ),
    stepLocalBrowserHistory: async (direction, sessionId) =>
      LocalBrowserPersonStateSchema.parse(
        await api.call('localBrowser.createHistory', {
          query: chat(sessionId),
          body: { direction },
        })
      ),
    takeOverLocalBrowser: async (sessionId) =>
      LocalBrowserPersonStateSchema.parse(
        await api.call('localBrowser.createTakeOver', { query: chat(sessionId) })
      ),
    pauseLocalBrowser: async (sessionId) =>
      LocalBrowserStateSchema.parse(
        await api.call('localBrowser.pause', { query: chat(sessionId) })
      ),
    resumeLocalBrowser: async (sessionId) =>
      LocalBrowserPersonStateSchema.parse(
        await api.call('localBrowser.resume', { query: chat(sessionId) })
      ),
    disconnectLocalBrowser: async (sessionId) =>
      LocalBrowserPersonStateSchema.parse(
        await api.call('localBrowser.createDisconnect', { query: chat(sessionId) })
      ),
    signInLocalBrowser: async (input, sessionId) =>
      LocalBrowserPersonStateSchema.parse(
        await api.call('localBrowser.signIn', { query: chat(sessionId), body: input })
      ),
    finishLocalBrowserSignIn: async (handoffId, sessionId) => {
      await api.call('localBrowser.createSignInDone', {
        query: chat(sessionId),
        body: handoffId ? { handoffId } : {},
      });
    },
    handBackLocalBrowser: async (handoffId) =>
      LocalBrowserPersonStateSchema.parse(
        await api.call('localBrowser.createHandoffHandBack', { body: { handoffId } })
      ),
    stopLocalBrowserHandoff: async (handoffId) =>
      LocalBrowserPersonStateSchema.parse(
        await api.call('localBrowser.stopHandoff', { body: { handoffId } })
      ),
  };
}
