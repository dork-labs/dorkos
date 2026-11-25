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
    case 'account_cleanup_pending':
      return 'DorkOS is still removing this app’s earlier access. Try again in a few minutes.';
    case 'still_connected':
      return 'Disconnect this app before removing it.';
    case 'not_found':
      return 'This app is no longer connected. Pick it again from the list.';
    case 'app_not_set_up':
      return 'Sign-in isn’t available for this app. Check Settings › Connections, then try again.';
    case 'conflict':
      return 'This sign-in was already used. Start again.';
    default:
      return 'Couldn’t confirm that change. Check the app before trying again.';
  }
}
