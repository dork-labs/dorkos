/**
 * The generated API client (`@dorkos/api-client`), sending through this
 * transport's one request path.
 *
 * Its `fetch` is {@link fetchResponse}, so a generated call gets exactly what a
 * hand-written one gets: the session cookie, the timeout, the community-owner
 * header, the sign-in signal on a 401, and a refusal thrown as the app's
 * `ResponseError`. A slice moves onto it one method at a time
 * (`contributing/data-fetching.md`).
 *
 * @module shared/lib/transport/api-client
 */
import { createApiClient, type ApiClient } from '@dorkos/api-client';
import { fetchResponse } from './http-client';

/**
 * A generated client bound to this server's API mount.
 *
 * @param baseUrl - The transport's base URL, the `/api` mount.
 */
export function createTransportApiClient(baseUrl: string): ApiClient {
  return createApiClient({ baseUrl, fetch: (url, init) => fetchResponse('', url, init) });
}
