/**
 * What a `dork:` link opens (DOR-5046): `GET /api/links/target`, the
 * `link.resolve` capability's own path, through the generated API client
 * (DOR-5473).
 *
 * @module shared/lib/transport/dork-link-methods
 */
import { ResolvedDorkLinkSchema, type ResolvedDorkLink } from '@dorkos/shared/dork-link-schemas';
import { createTransportApiClient } from './api-client';

/** Create the `dork:` link methods bound to a base URL. */
export function createDorkLinkMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  return {
    async resolveDorkLink(uri: string): Promise<ResolvedDorkLink> {
      const answer = await api.call('link.resolve', { query: { uri } });
      return ResolvedDorkLinkSchema.parse(answer);
    },
  };
}
