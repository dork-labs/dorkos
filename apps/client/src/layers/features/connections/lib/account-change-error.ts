/**
 * The words for an account change (sign in again, resume, pause, disconnect,
 * remove) the server refused, by its stable code. Only known codes are shown;
 * arbitrary server text never reaches the page.
 *
 * @module features/connections/lib/account-change-error
 */

/**
 * One plain line for a refused account change.
 *
 * @param error - The failed request's error, carrying the server's `code`.
 */
export function accountChangeError(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  switch (code) {
    case 'connection_cleanup_pending':
      return 'DorkOS is still removing this app’s earlier access at the service. Try again in a few minutes.';
    case 'connection_not_disconnected':
      return 'Disconnect this app before removing it.';
    case 'connection_not_found':
      return 'This app is no longer connected. Pick it again from the list.';
    case 'provider_not_found':
    case 'authentication_unavailable':
      return 'Sign-in isn’t available for this app right now. Check how DorkOS reaches your apps in Settings › Connections, then try again.';
    case 'idempotency_conflict':
      return 'This sign-in was already used. Start again.';
    default:
      return 'We couldn’t confirm that change. Check the app’s current state before trying again.';
  }
}
