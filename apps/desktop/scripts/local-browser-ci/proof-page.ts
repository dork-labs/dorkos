import type { Page } from 'playwright-core';

/** Read the named CI chat's registered Page through its scoped host handle. */
export async function browserProofPage(
  connection: { newPage(): Promise<Page> } | undefined
): Promise<Page> {
  if (!connection) throw new Error('The proof has no live chat page');
  // ScopedPageConnection.newPage returns its registered Page; it creates no new tab.
  const page = await connection.newPage();
  if (page.isClosed()) throw new Error('The proof has no live chat page');
  return page;
}
