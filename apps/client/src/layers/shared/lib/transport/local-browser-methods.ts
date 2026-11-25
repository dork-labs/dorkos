import type { LocalBrowserTransport } from '@dorkos/shared/transport-local-browser';
import {
  LocalBrowserCapabilitiesSchema,
  LocalBrowserPersonStateSchema,
  LocalBrowserProfileSchema,
  LocalBrowserStateSchema,
} from '@dorkos/shared/local-browser';
import { YourBrowserScanSchema } from '@dorkos/shared/your-browser';
import { fetchJSON } from './http-client';
import { createBrowserViewerMethods } from './browser-viewer-methods';
import { resolveStableClientId } from './client-id';

/** Local browser human controls, using the same authenticated origin as every app action. */
export function createLocalBrowserMethods(
  baseUrl: string,
  clientId: () => string = resolveStableClientId
): LocalBrowserTransport {
  const request = <T>(path: string, body?: unknown): Promise<T> =>
    fetchJSON<T>(baseUrl, `/local-browser${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const selected = (path: string, sessionId?: string | null) =>
    sessionId == null ? path : `${path}?sessionId=${encodeURIComponent(sessionId)}`;
  return {
    ...createBrowserViewerMethods(baseUrl, clientId),
    scanYourBrowsers: async () =>
      YourBrowserScanSchema.parse(
        await fetchJSON(baseUrl, '/your-browser/scan', {
          method: 'POST',
          body: '{}',
          cache: 'no-store',
        })
      ),
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
      LocalBrowserPersonStateSchema.parse(await request('/handoff/state')),
    getLocalBrowserCapabilities: async () =>
      LocalBrowserCapabilitiesSchema.parse(await request('/capabilities')),
    listLocalBrowserProfiles: async () => {
      const result = await request<{ profiles: unknown[] }>('/profiles');
      return {
        profiles: result.profiles.map((profile) => LocalBrowserProfileSchema.parse(profile)),
      };
    },
    bindLocalBrowserProfile: async (id, agentId, sessionId) =>
      LocalBrowserProfileSchema.parse(
        await request(selected(`/profiles/${encodeURIComponent(id)}/agents`, sessionId), {
          agentId,
        })
      ),
    unbindLocalBrowserProfile: async (id, agentId, sessionId) =>
      LocalBrowserProfileSchema.parse(
        await fetchJSON(
          baseUrl,
          `/local-browser${selected(`/profiles/${encodeURIComponent(id)}/agents/${encodeURIComponent(agentId)}`, sessionId)}`,
          { method: 'DELETE' }
        )
      ),
    forgetLocalBrowserSignIns: (id) =>
      request(`/profiles/${encodeURIComponent(id ?? 'default')}/forget-sign-ins`, {}),
    deleteLocalBrowserProfile: (id) =>
      fetchJSON(baseUrl, `/local-browser/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    openLocalBrowser: async (input) =>
      LocalBrowserPersonStateSchema.parse(await request('/open', input)),
    selectLocalBrowserTab: async (id, sessionId) =>
      LocalBrowserStateSchema.parse(
        await request(selected(`/tabs/${encodeURIComponent(id)}/select`, sessionId), {})
      ),
    navigateLocalBrowser: async (url, options) =>
      LocalBrowserPersonStateSchema.parse(
        await request(
          selected('/navigate', options?.sessionId),
          options?.httpFallback ? { url, httpFallback: true } : { url }
        )
      ),
    stepLocalBrowserHistory: async (direction, sessionId) =>
      LocalBrowserPersonStateSchema.parse(
        await request(selected('/history', sessionId), { direction })
      ),
    takeOverLocalBrowser: async (sessionId) =>
      LocalBrowserPersonStateSchema.parse(await request(selected('/take-over', sessionId), {})),
    pauseLocalBrowser: async (sessionId) =>
      LocalBrowserStateSchema.parse(await request(selected('/pause', sessionId), {})),
    resumeLocalBrowser: async (sessionId) =>
      LocalBrowserPersonStateSchema.parse(await request(selected('/resume', sessionId), {})),
    disconnectLocalBrowser: async (sessionId) =>
      LocalBrowserPersonStateSchema.parse(await request(selected('/disconnect', sessionId), {})),
    signInLocalBrowser: async (input, sessionId) =>
      LocalBrowserPersonStateSchema.parse(await request(selected('/sign-in', sessionId), input)),
    finishLocalBrowserSignIn: async (handoffId, sessionId) => {
      await request(selected('/sign-in/done', sessionId), handoffId ? { handoffId } : {});
    },
    handBackLocalBrowser: async (handoffId) =>
      LocalBrowserPersonStateSchema.parse(await request('/handoff/hand-back', { handoffId })),
    stopLocalBrowserHandoff: async (handoffId) =>
      LocalBrowserPersonStateSchema.parse(await request('/handoff/stop', { handoffId })),
  };
}
