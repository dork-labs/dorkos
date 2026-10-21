/**
 * Which targets the operator has muted (BC-40). A muted row keeps its place and
 * is drawn dimmed; only an @mention pierces it (`derive-unread-signal`).
 *
 * @module features/dashboard-sidebar/model/rules/apply-mute-rules
 */
import type { SidebarItemRef } from '@dorkos/shared/config-schema';
import type { SidebarModelPrefs } from '../sidebar-state';

/** Every target key the operator has muted, individually or through a group. */
export interface MuteIndex {
  /** Muted agent `projectPath`s. */
  agents: ReadonlySet<string>;
  /** Muted room ids. */
  rooms: ReadonlySet<string>;
}

/**
 * Which targets are muted, reading both the individual list and every muted
 * group's membership.
 *
 * **Group mute is a lens, never a write.** A muted group dims its members while
 * it is muted and gives each of them its own state back when it is not, which
 * only works if membership is resolved on read. A smart group's stored `items`
 * are ignored here for the same reason `buildSections` ignores them: they
 * are a convert-to-manual target, not live membership.
 *
 * @param prefs - The operator's stored sidebar preferences.
 */
export function muteIndex(prefs: SidebarModelPrefs): MuteIndex {
  const agents = new Set<string>();
  const rooms = new Set<string>();
  const add = (refs: readonly SidebarItemRef[]) => {
    for (const ref of refs) {
      if (ref.kind === 'agent') agents.add(ref.path);
      else rooms.add(ref.roomId);
    }
  };
  add(prefs.muted);
  for (const group of prefs.groups) {
    if (!group.muted || group.kind === 'smart') continue;
    add(group.items);
  }
  return { agents, rooms };
}
