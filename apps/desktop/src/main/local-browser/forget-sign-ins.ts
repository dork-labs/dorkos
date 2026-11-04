import type { Session } from 'electron';

/** Forget every origin only in the Agent browser partition, after every writer closes. */
export async function forgetGuestSignIns(
  guest: Pick<
    Session,
    'clearStorageData' | 'clearCache' | 'clearAuthCache' | 'closeAllConnections'
  > & { cookies: Pick<Session['cookies'], 'flushStore'> },
  closePages: () => Promise<void>
): Promise<void> {
  await closePages();
  await guest.closeAllConnections();
  await guest.clearAuthCache();
  await guest.clearStorageData();
  await guest.clearCache();
  await guest.cookies.flushStore();
}
