/**
 * The pinned apps under the Apps door, and what stands there instead of them
 * while they cannot be shown (DOR-3970).
 *
 * The pins arrive already resolved and in pin order: `useSidebarState` reads
 * them from the app catalog, which leaves out an app that is off (turning it
 * back on brings its row back) and keeps a held or broken one where it was, so
 * a pinned app never vanishes. This decides only what each row says.
 *
 * @module features/dashboard-sidebar/model/rules/app-rows
 */
import type { SidebarAppsNotice, SidebarRowModel } from '../build-sidebar-model';
import type { SidebarApps, SidebarPinnedApp } from '../sidebar-state';
import { rowKey } from './targets';

/**
 * One pinned app's row: never dragged by the panel's drag layer, never muted
 * and never unread. The app's own count rides `count`; its state rides `app`.
 *
 * @param app - The pinned app.
 */
function appRow(app: SidebarPinnedApp): SidebarRowModel {
  const target = { kind: 'add-on', extensionId: app.id, path: app.path } as const;
  return {
    key: rowKey(target),
    target,
    glyph: { kind: 'page-icon', pageId: app.pageId ?? `${app.id}:${app.path}` },
    primary: app.name,
    reservesVerbLine: false,
    unread: { tier: 'none' },
    ...(app.state === 'ok' && app.count > 0 ? { count: app.count } : {}),
    muted: false,
    draggable: false,
    app: { id: app.id, state: app.state, accessibleName: app.accessibleName },
    reason: `apps:pinned-${app.state}`,
  };
}

/**
 * The pinned rows, in pin order — none until the list has answered.
 *
 * @param apps - The Apps door's state.
 */
export function appRows(apps: SidebarApps): SidebarRowModel[] {
  return apps.status === 'ready' ? apps.pinned.map(appRow) : [];
}

/**
 * What stands under the door instead of the pins, or `null` when the pins
 * (or nothing at all) do.
 *
 * Loading draws one skeleton bar per stored pin, so the panel does not jump
 * when they arrive; with none stored there is nothing to hold room for.
 *
 * @param apps - The Apps door's state.
 */
export function appsNotice(apps: SidebarApps): SidebarAppsNotice | null {
  if (apps.status === 'failed') return { kind: 'failed' };
  if (apps.status === 'loading' && apps.storedPinCount > 0) {
    return { kind: 'loading', rows: apps.storedPinCount };
  }
  return null;
}

/**
 * Whether the door wears a dot: an app waits on a person, and no pinned row
 * already shows it.
 *
 * @param apps - The Apps door's state.
 */
export function heldDot(apps: SidebarApps): boolean {
  return apps.status === 'ready' && apps.heldUnpinned;
}
