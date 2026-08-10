/**
 * One-time migration of legacy localStorage pins into server config (DOR-329).
 *
 * Unchanged by the redesign, and deliberately so: it has its own deprecation
 * clock and will be removed by it rather than by a refactor that happened to
 * pass nearby.
 *
 * It lives in its own module because `DashboardSidebar` is held to "this
 * component transforms nothing" by a source-level test, and parsing a JSON
 * array of paths is a transformation. The rule is worth more than the
 * convenience of keeping fifty lines in the file they used to be in.
 *
 * @module features/dashboard-sidebar/model/use-legacy-pin-migration
 */
import { useEffect, useRef } from 'react';
import { useConfig, useSidebarPrefs, useUpdateSidebarPrefs } from '@/layers/entities/config';

/**
 * Legacy localStorage key that held pinned agent paths before organization
 * moved to server config. Its presence IS the one-time migration flag.
 */
const LEGACY_PINNED_STORAGE_KEY = 'dorkos-pinned-agents';

/**
 * Seed server pins from the old localStorage key, once, then forget it.
 *
 * If the key exists and the server has no pins yet, the server pins are seeded
 * from it in order; server state wins when it already has pins. The key is
 * removed either way, so re-mounts and reloads are no-ops.
 */
export function useLegacyPinMigration(): void {
  const { data: config } = useConfig();
  const sidebarPrefs = useSidebarPrefs();
  const { update: updateSidebarPrefs } = useUpdateSidebarPrefs();
  const pinnedCount = sidebarPrefs.pinned.length;
  const doneRef = useRef(false);

  useEffect(() => {
    if (doneRef.current) return;
    if (config === undefined) return; // wait for real server config
    const raw = localStorage.getItem(LEGACY_PINNED_STORAGE_KEY);
    if (raw === null) {
      doneRef.current = true;
      return;
    }
    doneRef.current = true;
    let stored: string[] = [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) stored = parsed.filter((v): v is string => typeof v === 'string');
    } catch {
      stored = [];
    }
    if (pinnedCount === 0 && stored.length > 0) {
      updateSidebarPrefs((prev) => ({
        ...prev,
        pinned: stored.map((path) => ({ kind: 'agent', path })),
      }));
    }
    localStorage.removeItem(LEGACY_PINNED_STORAGE_KEY);
  }, [config, pinnedCount, updateSidebarPrefs]);
}
