/**
 * Harness Sync Transport methods factory.
 *
 * Wraps `GET /api/harness/status` (spec `harness-sync-status` §2.1) with a
 * typed fetch. Unlike `marketplace-methods.ts` there is nothing to
 * `encodeURIComponent` here: the one input is a filesystem path and it rides the
 * query string, where `buildQueryString` escapes it. Building the URL by hand
 * would send a folder with a space or a `+` in its name to a different folder.
 *
 * @module shared/lib/transport/harness-methods
 */
import type {
  HarnessAdoptResponse,
  HarnessStatusResponse,
  HarnessSyncResponse,
} from '@dorkos/shared/harness-schemas';
import { fetchJSON, buildQueryString } from './http-client';

/** Create the Harness Sync methods bound to a base URL. */
export function createHarnessMethods(baseUrl: string) {
  return {
    getHarnessStatus(projectPath: string): Promise<HarnessStatusResponse> {
      const qs = buildQueryString({ projectPath });
      return fetchJSON<HarnessStatusResponse>(baseUrl, `/harness/status${qs}`);
    },

    syncHarness(projectPath: string): Promise<HarnessSyncResponse> {
      // A body rather than a query string, unlike the read beside it: this is a
      // write, and a path in a URL is a path in an access log.
      return fetchJSON<HarnessSyncResponse>(baseUrl, '/harness/sync', {
        method: 'POST',
        body: JSON.stringify({ projectPath }),
      });
    },

    adoptHarness(projectPath: string, name: string): Promise<HarnessAdoptResponse> {
      // A body for the same reason the sync uses one, plus a second: the skill's
      // name is a folder name, and a folder name in a URL is a folder name in an
      // access log.
      //
      // Two fields, never three. The route also takes `claudeOnly`, and this
      // sends it never: the app has no affordance for that choice, so passing it
      // through would be an option nothing can set.
      return fetchJSON<HarnessAdoptResponse>(baseUrl, '/harness/adopt', {
        method: 'POST',
        body: JSON.stringify({ projectPath, name }),
      });
    },
  };
}
