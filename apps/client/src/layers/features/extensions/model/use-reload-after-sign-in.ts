/**
 * Load the extensions again once the person signs in.
 *
 * `ExtensionProvider` sits above `AuthGuard`, so its first load runs as the
 * window opens, before anyone has signed in. With login on, that request is
 * refused, the loader reads the refusal as "no extensions", and nothing asked
 * again: every mini app's sidebar row and Settings tab stayed missing until the
 * window was reloaded by hand. This hook is the "ask again".
 *
 * @module features/extensions/model/use-reload-after-sign-in
 */
import { useEffect, useRef } from 'react';
import { getAuthRequired, subscribeAuthRequired } from '@/layers/shared/lib';

/**
 * Run `reload` each time the app goes from "sign in first" to signed in.
 *
 * Only that edge counts: a window that never asked anyone to sign in already
 * loaded with a session, so it is left alone.
 *
 * @param reload - Re-fetches and remounts the extension set. Kept in a ref, so
 *   a new identity never resubscribes. A rejection is logged; the extensions
 *   already live stay live.
 */
export function useReloadAfterSignIn(reload: () => Promise<void>): void {
  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  }, [reload]);

  useEffect(() => {
    let wasRequired = getAuthRequired();
    return subscribeAuthRequired(() => {
      const required = getAuthRequired();
      const signedIn = wasRequired && !required;
      wasRequired = required;
      if (!signedIn) return;
      reloadRef.current().catch((err: unknown) => {
        console.error('[extensions] Failed to load extensions after sign-in:', err);
      });
    });
  }, []);
}
