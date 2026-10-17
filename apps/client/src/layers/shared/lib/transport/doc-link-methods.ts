/**
 * The docs in one space, for wiki links (DOR-2982).
 *
 * @module shared/lib/transport/doc-link-methods
 */
import type { DocIndex } from '@dorkos/shared/doc-links';
import { fetchJSON } from './http-client';

/** Create the doc-link methods bound to a base URL. */
export function createDocLinkMethods(baseUrl: string) {
  return {
    getDocIndex(cwd: string): Promise<DocIndex> {
      const params = new URLSearchParams({ cwd });
      return fetchJSON<DocIndex>(baseUrl, `/documents/index?${params}`);
    },
  };
}
