import type { Page } from 'playwright-core';
import type { PageConnection } from '../../../server/src/services/session/local-browser/leases/profile-connection.js';

/** Read the named CI chat's registered Page through its scoped host handle. */
export async function browserProofPage(
  connection: Pick<PageConnection, 'newPage'> | undefined
): Promise<Page> {
  if (!connection) throw new Error('The proof has no live chat page');
  // ScopedPageConnection.newPage returns its registered Page; it creates no new tab.
  const page = await connection.newPage();
  if (page.isClosed()) throw new Error('The proof has no live chat page');
  return page;
}
