/**
 * One-time client migration (DOR-431): lift the status-bar visibility toggles
 * that previously lived in `localStorage` up into server config (`ui.statusBar`),
 * then delete the legacy keys.
 *
 * Status-bar prefs moved from client Zustand + `localStorage` to server config
 * so they sync across devices and agents can flip them. A device that toggled
 * any item before the move still has its choice in `localStorage`; this reads
 * only the keys that were explicitly written, PATCHes them up, removes them, and
 * invalidates the config cache so the cockpit reflects the migrated values.
 *
 * Idempotent by construction: a per-mount ref guards against React's
 * double-invoke, it no-ops when no legacy key is present (the common case — a
 * user who never toggled has no keys), and removing the keys on success makes a
 * later page load find nothing to migrate. A failed PATCH leaves the keys in
 * place, so the next page load retries — no value is lost.
 *
 * @module entities/config/model/use-status-bar-legacy-migration
 */
import { useEffect, useRef } from 'react';
import type { StatusBarPrefs } from '@dorkos/shared/config-schema';
import { useTransport } from '@/layers/shared/model';
import { useQueryClient } from '@tanstack/react-query';
import { configKeys } from '../api/query-keys';
import type { StatusBarPrefKey } from './use-status-bar-prefs';

/**
 * Legacy `localStorage` keys, one per status-bar item, written by the retired
 * Zustand preferences slice. Frozen: these strings are historical and must
 * match exactly what the old `BOOL_KEYS` map wrote.
 */
const LEGACY_STATUS_BAR_KEYS: Record<StatusBarPrefKey, string> = {
  cwd: 'dorkos-show-status-bar-cwd',
  git: 'dorkos-show-status-bar-git',
  runtime: 'dorkos-show-status-bar-runtime',
  model: 'dorkos-show-status-bar-model',
  cache: 'dorkos-show-status-bar-cache',
  context: 'dorkos-show-status-bar-context',
  usage: 'dorkos-show-status-bar-usage',
  permission: 'dorkos-show-status-bar-permission',
  sound: 'dorkos-show-status-bar-sound',
  polling: 'dorkos-show-status-bar-polling',
};

/**
 * Mount-once hook that runs the legacy status-bar `localStorage` → config
 * migration. Guarded by a per-mount ref so React's double-invoke never
 * double-PATCHes; a no-op once the keys are removed or when nothing was ever
 * toggled. Only one app shell (standalone or embedded) mounts per client, so a
 * ref is a sufficient guard.
 */
export function useStatusBarLegacyMigration(): void {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const attemptedRef = useRef(false);

  useEffect(() => {
    if (attemptedRef.current) return;
    attemptedRef.current = true;

    const patch: Partial<StatusBarPrefs> = {};
    let found = false;
    try {
      for (const [key, lsKey] of Object.entries(LEGACY_STATUS_BAR_KEYS) as [
        StatusBarPrefKey,
        string,
      ][]) {
        const stored = localStorage.getItem(lsKey);
        if (stored === 'true' || stored === 'false') {
          patch[key] = stored === 'true';
          found = true;
        }
      }
    } catch {
      return;
    }

    // Nothing was ever toggled on this device — the common case. Leave config's
    // schema defaults (all visible) untouched.
    if (!found) return;

    void transport
      .updateConfig({ ui: { statusBar: patch } })
      .then(() => {
        try {
          for (const lsKey of Object.values(LEGACY_STATUS_BAR_KEYS)) {
            localStorage.removeItem(lsKey);
          }
        } catch {
          // Removal is best-effort; the values are already in config.
        }
        void queryClient.invalidateQueries({ queryKey: configKeys.current() });
      })
      .catch(() => {
        // Leave the legacy keys in place; the next page load's fresh mount
        // retries — the values are not lost.
      });
  }, [transport, queryClient]);
}
