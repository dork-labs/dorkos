/**
 * Mirror whether Require login is on into the app store, so the extension
 * host can answer `api.getState().requireLogin` synchronously (spec
 * `flow-multiproject` §7.10).
 *
 * @module features/extensions/model/use-sync-require-login
 */
import { useEffect } from 'react';
import { useConfig } from '@/layers/entities/config';
import { useAppStore } from '@/layers/shared/model';

/**
 * Keep `requireLogin` in the app store equal to the server's `auth.enabled`.
 * False until the config is read: a dial that says "anyone on this computer
 * can change this" a moment too long is the honest mistake to make.
 */
export function useSyncRequireLogin(): void {
  const { data: config } = useConfig();
  const setRequireLogin = useAppStore((s) => s.setRequireLogin);
  const enabled = config?.auth?.enabled === true;
  useEffect(() => {
    setRequireLogin(enabled);
  }, [enabled, setRequireLogin]);
}
