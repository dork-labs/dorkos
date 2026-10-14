/**
 * The two retired settings sections DorkOS removes at boot rather than in a
 * `CONFIG_MIGRATIONS` body: `approvals` (standing permissions) and
 * `agentContext` (the four tool switches), both from spec `agent-permissions`
 * D13. Each function says why it is deliberately not a migration. They live
 * beside `config-manager.ts` rather than in it because no migration key reaches
 * them; `ConfigManager` calls them through its two `retire…` methods.
 *
 * @module services/core/config/retired-settings
 */
import type { PermissionAreaId } from '@dorkos/shared/permissions';

/**
 * Retire the standing-permission settings (spec `agent-permissions` D13, phase
 * 2): delete `approvals.standingGrants`, `approvals.trustWindowMinutes` and
 * `approvals.standingGrantsVoidBefore`, and the `approvals` section itself once
 * nothing else is in it. "Always allow" on a request card replaced standing
 * permissions; the grants themselves were ended at upgrade, not converted (see
 * `permissions/ended-standing-grants.ts`).
 *
 * A top-level section this build no longer declares, so nothing else ever
 * writes it again: this body is the whole removal. Anything else a newer build
 * put under `approvals` is kept, on the version-skew rule.
 *
 * Deliberately NOT a config migration. A migration runs whenever the config
 * store opens, and the CLI opens it before the server has migrated the
 * database, so a migration would erase the settings the capture of live
 * standing permissions needs (the master switch and the void floor) before it
 * ran. The server calls this once the capture is done, through
 * {@link ConfigManager.retireStandingGrantSettings}; until then the section is an
 * unknown key, carried across writes like any other.
 *
 * @param store - The config store.
 */
export function retireStandingGrantSettings(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  delete: (key: string) => void;
}): void {
  const stored = store.get('approvals');
  if (stored === undefined) return;
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) {
    store.delete('approvals');
    return;
  }
  const {
    standingGrants: _standingGrants,
    trustWindowMinutes: _trustWindowMinutes,
    standingGrantsVoidBefore: _standingGrantsVoidBefore,
    ...rest
  } = stored as Record<string, unknown>;
  if (Object.keys(rest).length === 0) store.delete('approvals');
  else store.set('approvals', rest);
}

/**
 * Which permission area each retired `agentContext` switch folds into.
 */
const AGENT_CONTEXT_AREAS = {
  tasksTools: 'tasks',
  relayTools: 'messages',
  meshTools: 'agents',
  adapterTools: 'connections',
} as const satisfies Record<string, PermissionAreaId>;

/**
 * Retire the four `agentContext.*Tools` switches (spec `agent-permissions` D13,
 * phase 3). Each switch a person turned OFF becomes its area Blocked in
 * `permissions.defaults.areas` for everyone, unless that area is already set
 * there (an area a person set through DorkOS wins); then the section is deleted.
 *
 * The switches only ever left tool docs out of Claude Code's context, and the
 * tools stayed callable (ADR 260726-171347, superseded). A Blocked area hides
 * AND refuses them on every runtime, so the fold is faithful to what a person
 * who turned one off meant, and slightly stronger than what they got.
 *
 * Deliberately NOT a `CONFIG_MIGRATIONS` body, on the precedent of
 * {@link retireStandingGrantSettings}: a migration runs once per version, so an
 * install that already ran this version's key under an earlier build (a
 * dogfood install always has) would never be folded, and a migration runs
 * before the Activity log exists, so it could not record the change it made.
 * This runs at every boot, from the permission upgrade, acts only while the
 * section is on disk, and returns what it Blocked so the caller can record it.
 * Running it twice is a no-op: the first run removed the section.
 *
 * `agentContext` is a top-level section this build no longer declares, so
 * nothing else ever writes it again; until this runs it is an unknown key,
 * carried across writes like any other.
 *
 * @param store - The config store.
 * @returns The areas it set to Blocked, in a stable order, or `null` when there
 *   was no `agentContext` section to retire.
 */
export function retireAgentContextSettings(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  delete: (key: string) => void;
}): PermissionAreaId[] | null {
  const stored = store.get('agentContext');
  if (stored === undefined) return null;
  const section =
    stored && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  const off = (Object.keys(AGENT_CONTEXT_AREAS) as (keyof typeof AGENT_CONTEXT_AREAS)[])
    .filter((key) => section[key] === false)
    .map((key) => AGENT_CONTEXT_AREAS[key]);

  const blocked: PermissionAreaId[] = [];
  if (off.length > 0) {
    const permissions = store.get('permissions');
    const current =
      permissions && typeof permissions === 'object' && !Array.isArray(permissions)
        ? (permissions as Record<string, unknown>)
        : { preset: null, defaults: { areas: {}, actions: {} }, upgradeSweptVersion: null };
    const defaults =
      current.defaults && typeof current.defaults === 'object' && !Array.isArray(current.defaults)
        ? (current.defaults as Record<string, unknown>)
        : { areas: {}, actions: {} };
    const areas: Record<string, unknown> = {
      ...((defaults.areas as Record<string, unknown> | undefined) ?? {}),
    };
    for (const area of off) {
      if (Object.hasOwn(areas, area)) continue;
      areas[area] = 'blocked';
      blocked.push(area);
    }
    if (blocked.length > 0) {
      store.set('permissions', {
        ...current,
        defaults: { actions: {}, ...defaults, areas },
      });
    }
  }
  store.delete('agentContext');
  return blocked;
}
