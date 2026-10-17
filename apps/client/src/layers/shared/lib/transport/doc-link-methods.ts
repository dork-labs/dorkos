/**
 * The docs in one space, for wiki links (DOR-2982).
 *
 * @module shared/lib/transport/doc-link-methods
 */
import type { DocIndex, DocResolve } from '@dorkos/shared/doc-links';
import { fetchJSON } from './http-client';

/** Create the doc-link methods bound to a base URL. */
export function createDocLinkMethods(baseUrl: string) {
  return {
    getDocIndex(cwd: string): Promise<DocIndex> {
      const params = new URLSearchParams({ cwd });
      return fetchJSON<DocIndex>(baseUrl, `/documents/index?${params}`);
    },

    resolveDocLink(cwd: string, target: string, from: string | null): Promise<DocResolve> {
      const params = new URLSearchParams({ cwd, target, ...(from ? { from } : {}) });
      return fetchJSON<DocResolve>(baseUrl, `/documents/resolve?${params}`);
    },
  };
}
