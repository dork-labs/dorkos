/**
 * The docs in one space, for wiki links (DOR-2982), through the generated API
 * client (DOR-5473).
 *
 * @module shared/lib/transport/doc-link-methods
 */
import type { DocIndex, DocResolve } from '@dorkos/shared/doc-links';
import { createTransportApiClient } from './api-client';

/** Create the doc-link methods bound to a base URL. */
export function createDocLinkMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  return {
    getDocIndex(cwd: string): Promise<DocIndex> {
      return api.call('documents.getIndex', { query: { cwd } });
    },

    resolveDocLink(cwd: string, target: string, from: string | null): Promise<DocResolve> {
      return api.call('documents.resolve', {
        query: { cwd, target, ...(from ? { from } : {}) },
      });
    },
  };
}
