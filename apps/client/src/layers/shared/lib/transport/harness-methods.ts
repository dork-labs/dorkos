/**
 * Harness Sync Transport methods factory, through the generated API client
 * (DOR-5473).
 *
 * Wraps `GET /api/harness/status` (spec `harness-sync-status` §2.1) and its two
 * writes. The one input is a filesystem path, and it rides the query string,
 * where the client escapes it. Building the URL by hand would send a folder
 * with a space or a `+` in its name to a different folder.
 *
 * @module shared/lib/transport/harness-methods
 */
import type {
  HarnessAdoptResponse,
  HarnessStatusResponse,
  HarnessSyncResponse,
} from '@dorkos/shared/harness-schemas';
import { createTransportApiClient } from './api-client';

/** Create the Harness Sync methods bound to a base URL. */
export function createHarnessMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  return {
    getHarnessStatus(projectPath: string): Promise<HarnessStatusResponse> {
      return api.call('harness.getStatus', { query: { projectPath } });
    },

    syncHarness(projectPath: string): Promise<HarnessSyncResponse> {
      // A body rather than a query string, unlike the read beside it: this is a
      // write, and a path in a URL is a path in an access log.
      return api.call('harness.sync', { body: { projectPath } });
    },

    adoptHarness(projectPath: string, name: string): Promise<HarnessAdoptResponse> {
      // A body for the same reason the sync uses one, plus a second: the skill's
      // name is a folder name, and a folder name in a URL is a folder name in an
      // access log.
      //
      // Two fields, never three. The route also takes `claudeOnly`, and this
      // sends it never: the app has no affordance for that choice, so passing it
      // through would be an option nothing can set.
      return api.call('harness.createAdopt', { body: { projectPath, name } });
    },
  };
}
