import type { LocalBrowserTransport } from '@dorkos/shared/transport-local-browser';
import {
  LocalBrowserStateSchema,
  LocalBrowserCapabilitiesSchema,
} from '@dorkos/shared/local-browser';
import { fetchJSON } from './http-client';

/** Local browser human controls, using the same authenticated origin as every app action. */
export function createLocalBrowserMethods(baseUrl: string): LocalBrowserTransport {
  const request = <T>(path: string, body?: unknown): Promise<T> =>
    fetchJSON<T>(baseUrl, `/local-browser${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    getLocalBrowserState: async () => LocalBrowserStateSchema.parse(await request('/state')),
    getLocalBrowserCapabilities: async () =>
      LocalBrowserCapabilitiesSchema.parse(await request('/capabilities')),
    openLocalBrowser: async (input) => LocalBrowserStateSchema.parse(await request('/open', input)),
    selectLocalBrowserTab: async (id) =>
      LocalBrowserStateSchema.parse(await request(`/tabs/${encodeURIComponent(id)}/select`, {})),
    navigateLocalBrowser: async (url) =>
      LocalBrowserStateSchema.parse(await request('/navigate', { url })),
    pauseLocalBrowser: async () => LocalBrowserStateSchema.parse(await request('/pause', {})),
    resumeLocalBrowser: async () => LocalBrowserStateSchema.parse(await request('/resume', {})),
    disconnectLocalBrowser: async () =>
      LocalBrowserStateSchema.parse(await request('/disconnect', {})),
  };
}
