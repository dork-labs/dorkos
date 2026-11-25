/**
 * What a `dork:` link opens (DOR-5046): `GET /api/links/target`, the
 * `link.resolve` capability's own path.
 *
 * @module shared/lib/transport/dork-link-methods
 */
import { ResolvedDorkLinkSchema, type ResolvedDorkLink } from '@dorkos/shared/dork-link-schemas';
import { buildQueryString, fetchJSON } from './http-client';

/** Create the `dork:` link methods bound to a base URL. */
export function createDorkLinkMethods(baseUrl: string) {
  return {
    async resolveDorkLink(uri: string): Promise<ResolvedDorkLink> {
      const answer = await fetchJSON<unknown>(baseUrl, `/links/target${buildQueryString({ uri })}`);
      return ResolvedDorkLinkSchema.parse(answer);
    },
  };
}
