import type { LocalBrowserTransport } from '@dorkos/shared/transport-local-browser';
import {
  LocalBrowserCapabilitiesSchema,
  LocalBrowserPersonStateSchema,
  LocalBrowserProfileSchema,
  LocalBrowserStateSchema,
} from '@dorkos/shared/local-browser';
import { YourBrowserScanSchema } from '@dorkos/shared/your-browser';
import { fetchJSON } from './http-client';

/** Local browser human controls, using the same authenticated origin as every app action. */
export function createLocalBrowserMethods(baseUrl: string): LocalBrowserTransport {
  const request = <T>(path: string, body?: unknown): Promise<T> =>
    fetchJSON<T>(baseUrl, `/local-browser${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    scanYourBrowsers: async () =>
      YourBrowserScanSchema.parse(
        await fetchJSON(baseUrl, '/your-browser/scan', {
          method: 'POST',
          body: '{}',
          cache: 'no-store',
        })
      ),
    getLocalBrowserState: async () => LocalBrowserPersonStateSchema.parse(await request('/state')),
    getLocalBrowserCapabilities: async () =>
      LocalBrowserCapabilitiesSchema.parse(await request('/capabilities')),
    listLocalBrowserProfiles: async () => {
      const result = await request<{ profiles: unknown[] }>('/profiles');
      return {
        profiles: result.profiles.map((profile) => LocalBrowserProfileSchema.parse(profile)),
      };
    },
    forgetLocalBrowserSignIns: (id) =>
      request(`/profiles/${encodeURIComponent(id ?? 'default')}/forget-sign-ins`, {}),
    deleteLocalBrowserProfile: (id) =>
      fetchJSON(baseUrl, `/local-browser/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    openLocalBrowser: async (input) =>
      LocalBrowserPersonStateSchema.parse(await request('/open', input)),
    selectLocalBrowserTab: async (id) =>
      LocalBrowserStateSchema.parse(await request(`/tabs/${encodeURIComponent(id)}/select`, {})),
    navigateLocalBrowser: async (url) =>
      LocalBrowserStateSchema.parse(await request('/navigate', { url })),
    pauseLocalBrowser: async () => LocalBrowserStateSchema.parse(await request('/pause', {})),
    resumeLocalBrowser: async () =>
      LocalBrowserPersonStateSchema.parse(await request('/resume', {})),
    disconnectLocalBrowser: async () =>
      LocalBrowserPersonStateSchema.parse(await request('/disconnect', {})),
    signInLocalBrowser: async (input) =>
      LocalBrowserPersonStateSchema.parse(await request('/sign-in', input)),
    handBackLocalBrowser: async (handoffId) =>
      LocalBrowserPersonStateSchema.parse(await request('/handoff/hand-back', { handoffId })),
    stopLocalBrowserHandoff: async (handoffId) =>
      LocalBrowserPersonStateSchema.parse(await request('/handoff/stop', { handoffId })),
  };
}
