/** Browser profile and instance methods for the implemented owner-qualified HTTP routes. */
import { z } from 'zod';
import {
  BrowserProfileSchema,
  BrowserInstanceSchema,
  BrowserCloseRequestSchema,
  BrowserCloseReceiptSchema,
  BrowserReferenceSchema,
  BrowserCounterSchema,
  type BrowserProfile,
  type BrowserInstance,
  type BrowserCloseRequest,
  type BrowserCloseReceipt,
} from '@dorkos/shared/browser-schemas';
import { fetchJSON } from './http-client';

const profilesEnvelope = z.object({ profiles: z.array(BrowserProfileSchema) }).strict();
const instancesEnvelope = z.object({ instances: z.array(BrowserInstanceSchema) }).strict();

/** Requests use the existing session-cookie/auth failure path; wire data confers no authority. */
export function createBrowserMethods(baseUrl: string) {
  return {
    async getBrowserProfiles(signal?: AbortSignal): Promise<BrowserProfile[]> {
      return profilesEnvelope.parse(
        await fetchJSON<unknown>(baseUrl, '/browser/profiles', { signal })
      ).profiles;
    },
    async getBrowserProfile(profileId: string, signal?: AbortSignal): Promise<BrowserProfile> {
      const id = BrowserReferenceSchema.parse(profileId);
      const result = BrowserProfileSchema.parse(
        await fetchJSON<unknown>(baseUrl, `/browser/profiles/${encodeURIComponent(id)}`, { signal })
      );
      if (result.profileId !== id)
        throw new Error('Browser response did not match the requested profile.');
      return result;
    },
    async getBrowserInstances(signal?: AbortSignal): Promise<BrowserInstance[]> {
      return instancesEnvelope.parse(
        await fetchJSON<unknown>(baseUrl, '/browser/instances', { signal })
      ).instances;
    },
    async getBrowserInstance(
      browserId: string,
      browserGeneration: number,
      signal?: AbortSignal
    ): Promise<BrowserInstance> {
      const id = BrowserReferenceSchema.parse(browserId),
        generation = BrowserCounterSchema.parse(browserGeneration);
      const result = BrowserInstanceSchema.parse(
        await fetchJSON<unknown>(
          baseUrl,
          `/browser/instances/${encodeURIComponent(id)}?browserGeneration=${generation}`,
          { signal }
        )
      );
      if (result.browserId !== id || result.browserGeneration !== generation)
        throw new Error('Browser response did not match the requested instance.');
      return result;
    },
    async closeBrowserInstance(
      request: BrowserCloseRequest,
      signal?: AbortSignal
    ): Promise<BrowserCloseReceipt> {
      const current = BrowserCloseRequestSchema.parse(request);
      const result = BrowserCloseReceiptSchema.parse(
        await fetchJSON<unknown>(baseUrl, '/browser/instances/close', {
          method: 'POST',
          body: JSON.stringify(current),
          signal,
        })
      );
      if (
        result.requestId !== current.requestId ||
        result.browserId !== current.browserId ||
        result.browserGeneration !== current.browserGeneration
      )
        throw new Error('Browser response did not match the close request.');
      return result;
    },
  };
}
